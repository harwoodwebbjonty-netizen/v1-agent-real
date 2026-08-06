"""Deterministic lead-prioritisation score.

Turns the data already stored on a lead into a 0–100 "who deserves a call next"
score, so the highest-value companies sort to the top of the cold-call sheet.
It is free and AI-free — no model call, no credits — and is a deliberate sibling
of two other systems:

  * companies_house_service.compute_ch_score — the prospecting pre-filter this
    reuses the thresholds of (charges recency, high-finance SIC, company age).
  * the AI lead_score in lead_intelligence_versions — paid and sparse; unrelated.

Signals used (all present on the lead / in the DB):
  charges (recency + volume), industry/SIC, company age, contact history
  (call outcomes + email history + contact_status), recent Companies House
  activity. Turnover and previous funding are intentionally NOT scored — the
  free Companies House source does not return turnover and no funding data is
  stored anywhere (see datagardener_service.py, which is unwired).

The raw component maxima sum to 100 (65 CH-fit + 20 contact + 15 activity);
the final score is capped at 100.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from app import db

logger = logging.getLogger("app.lead_scoring")

# Construction / manufacturing / property etc. — sectors that typically carry a
# high finance need. Kept in sync with compute_ch_score's local constant.
HIGH_FINANCE_SIC_PREFIXES = ("41", "42", "43", "25", "26", "28", "24", "68", "49")

# A pair of outcomes that count as an unsuccessful reach attempt.
_MISSED_OUTCOMES = ("no_answer", "voicemail")


def _parse_ch_data(raw: Any) -> dict:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (ValueError, TypeError):
        return {}


def _days_since(iso_date: str) -> int | None:
    """Whole days between an ISO date/datetime string and today (UTC), or None."""
    if not iso_date:
        return None
    try:
        d = datetime.fromisoformat(iso_date).date()
    except ValueError:
        try:
            d = date.fromisoformat(iso_date[:10])
        except ValueError:
            return None
    return (date.today() - d).days


def _score_charges(ch: dict) -> tuple[int, str]:
    """Recency of the most recent charge — a strong lending trigger."""
    charges = ch.get("charges", []) or []
    best: int | None = None
    for charge in charges:
        days = _days_since(charge.get("created_on", ""))
        if days is not None and (best is None or days < best):
            best = days
    if best is None:
        return 0, "No charges on file"
    if best <= 90:
        return 30, f"New charge {best}d ago — active finance trigger"
    if best <= 365:
        return 15, f"Charge in last year ({best}d ago)"
    return 0, "Charges only older than a year"


def _score_industry(ch: dict, industry: str) -> tuple[int, str]:
    sic_codes = ch.get("sic_codes", []) or []
    for sic in sic_codes:
        if any(str(sic).startswith(p) for p in HIGH_FINANCE_SIC_PREFIXES):
            return 15, f"High-finance-need sector{f' ({industry})' if industry else ''}"
    return 0, industry or "Sector not finance-heavy"


def _score_company_age(ch: dict) -> tuple[int, str]:
    days = _days_since(ch.get("incorporation_date", ""))
    if days is None:
        return 0, "Incorporation date unknown"
    years = days / 365
    if years >= 5:
        return 10, f"Established ({years:.0f}y old)"
    if years >= 2:
        return 5, f"Trading {years:.0f}y — past startup risk"
    return 0, f"Young company ({years:.1f}y)"


def _score_charge_volume(ch: dict) -> tuple[int, str]:
    total = ch.get("charges_total") or len(ch.get("charges", []) or [])
    if total >= 3:
        return 10, f"{total} charges — active user of finance"
    return 0, f"{total} charge(s)"


def _score_contact_history(lead_id: str, contact_status: str) -> tuple[int, str]:
    """Reachability + engagement from call/email history. Capped at 20."""
    call_rows = db.list_call_logs_for_lead(lead_id)
    sent_emails = [d for d in db.list_email_drafts(lead_id) if d["status"] == "sent"]
    attempts = len(call_rows) + len(sent_emails)
    last_outcome = call_rows[0]["outcome"] if call_rows else None
    missed = sum(1 for c in call_rows if c["outcome"] in _MISSED_OUTCOMES)

    if last_outcome == "connected":
        points, detail = 15, "Last call connected — reachable & engaged"
    elif attempts == 0:
        points, detail = 8, "No prior contact — fresh lead"
    elif missed >= 3 and last_outcome in _MISSED_OUTCOMES:
        points, detail = 2, f"{missed} missed attempts — hard to reach"
    else:
        points, detail = 5, "Some prior contact"

    if (contact_status or "").strip() == "Replied":
        points = min(20, points + 5)
        detail += "; replied previously"
    return points, detail


def _score_recent_activity(lead_id: str) -> tuple[int, str]:
    """Recency of Companies House filings/events. Capped at 15."""
    summary = db.get_lead_activity_summary(lead_id)
    if summary.get("has_recent_24h"):
        return 15, "New filing in last 24h"
    if summary.get("count"):
        latest = summary.get("latest_detected_at")
        days = _days_since(latest) if latest else None
        if days is not None and days <= 30:
            return 8, f"Activity {days}d ago"
        return 3, "Older activity on file"
    return 0, "No recent activity"


def compute_priority_score(lead: Any) -> tuple[int, dict]:
    """Return (score 0–100, breakdown dict keyed by signal → {points, detail})."""
    lead_id = lead["id"]
    ch = _parse_ch_data(lead["ch_data"] if "ch_data" in lead.keys() else None)
    industry = (lead["industry"] if "industry" in lead.keys() else "") or ""
    contact_status = (lead["contact_status"] if "contact_status" in lead.keys() else "") or ""

    components: dict[str, tuple[int, str]] = {
        "charges": _score_charges(ch),
        "industry": _score_industry(ch, industry),
        "company_age": _score_company_age(ch),
        "charge_volume": _score_charge_volume(ch),
        "contact_history": _score_contact_history(lead_id, contact_status),
        "recent_activity": _score_recent_activity(lead_id),
    }

    total = min(100, sum(pts for pts, _ in components.values()))
    breakdown = {"total": total, **{k: {"points": p, "detail": d} for k, (p, d) in components.items()}}
    return total, breakdown


def score_lead(lead_id: str) -> int | None:
    """Score a single lead and persist it. Returns the score, or None if the
    lead no longer exists. Safe to call from enrichment paths."""
    lead = db.get_lead(lead_id)
    if lead is None:
        return None
    score, breakdown = compute_priority_score(lead)
    db.set_lead_priority(lead_id, score, json.dumps(breakdown))
    return score


def score_list(list_id: str) -> int:
    """Score every lead in a list, persisting each. Returns the count scored."""
    leads = db.list_leads(list_id)
    count = 0
    for lead in leads:
        try:
            score, breakdown = compute_priority_score(lead)
            db.set_lead_priority(lead["id"], score, json.dumps(breakdown))
            count += 1
        except Exception:
            logger.exception("Failed to score lead %s", lead["id"])
    return count
