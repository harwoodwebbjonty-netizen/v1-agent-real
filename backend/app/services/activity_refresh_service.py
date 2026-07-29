"""Activity refresh service — tiered background scheduler for Companies House snapshots.

Mirrors the sequences_service pattern: process_due_refreshes() is called from
main.py's in-process asyncio loop every 30 minutes. One failure per lead never
stops the batch.

Refresh tiers:
  A (every 6h)  — Hot leads, or contact_status in callback_requested/interested
  B (every 2d)  — Warm leads or lead_score >= 60
  C (every 7d)  — Everything else
"""

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from app import db
from app.core.config import get_settings
from app.services.auth_service import new_id, now_iso
from app.services.ch_service import diff_snapshots, get_company_data

logger = logging.getLogger("app.activity_refresh")

TIER_INTERVALS: dict[str, timedelta] = {
    "A": timedelta(hours=6),
    "B": timedelta(days=2),
    "C": timedelta(days=7),
}

_HOT_CONTACT_STATUSES = {"callback_requested", "interested", "Callback Requested", "Interested"}


def assign_tier(lead: dict, intelligence: Optional[dict] = None) -> str:
    """Return A, B, or C based on lead signals."""
    contact_status = str(lead.get("contact_status") or "").strip()
    if contact_status in _HOT_CONTACT_STATUSES:
        return "A"

    if intelligence:
        temp = str(intelligence.get("lead_temperature") or "").lower()
        if temp == "hot":
            return "A"
        score = int(intelligence.get("lead_score") or 0)
        if temp == "warm" or score >= 60:
            return "B"

    return "C"


def _next_refresh_at(tier: str) -> str:
    interval = TIER_INTERVALS.get(tier, TIER_INTERVALS["C"])
    return (datetime.now(timezone.utc) + interval).isoformat(timespec="seconds")


async def refresh_company(lead_id: str, api_key: str) -> int:
    """Fetch fresh DG data for one lead, diff, save events.
    Returns number of new activity events detected."""
    lead = db.get_lead(lead_id)
    if not lead:
        logger.warning("activity_refresh: lead %s not found", lead_id)
        return 0

    lead = dict(lead)
    company_number = lead.get("company_number")
    if not company_number:
        return 0

    company_name = lead.get("company", "")

    new_data = await get_company_data(api_key, company_number)
    if not new_data:
        logger.warning("activity_refresh: no DG data for %s (%s)", company_number, company_name)
        # Still update the refresh schedule so we don't hammer a 404
        intel_row = db.get_latest_lead_intelligence(lead_id)
        intel = dict(intel_row) if intel_row else None
        tier = assign_tier(lead, intel)
        db.update_lead_dg_refresh(lead_id, tier, _next_refresh_at(tier), now_iso())
        return 0

    prev_snapshot = db.get_latest_snapshot(company_number)
    prev_data = None
    if prev_snapshot:
        try:
            prev_data = json.loads(prev_snapshot["snapshot_json"])
        except (json.JSONDecodeError, KeyError):
            prev_data = None

    intel_row = db.get_latest_lead_intelligence(lead_id)
    intel = dict(intel_row) if intel_row else None

    events = diff_snapshots(prev_data, new_data, company_number, company_name, lead_id)

    # Always save the new snapshot (append-only)
    db.save_snapshot(new_id(), company_number, json.dumps(new_data, default=str), now_iso())

    if events:
        db.save_activity_events(events)
        logger.info(
            "activity_refresh: %s (%s) — %d new event(s)", company_name, company_number, len(events)
        )

    tier = assign_tier(lead, intel)
    db.update_lead_dg_refresh(lead_id, tier, _next_refresh_at(tier), now_iso())
    return len(events)


async def process_due_refreshes() -> int:
    """Called by the background scheduler in main.py every 30 minutes.
    Processes up to 20 leads that are due for a refresh.
    Returns total number of activity events detected across all leads."""
    settings = get_settings()
    api_key = settings.companies_house_api_key
    if not api_key:
        return 0

    due_leads = db.list_due_dg_refreshes(now_iso(), limit=20)
    if not due_leads:
        return 0

    total_events = 0
    for lead_row in due_leads:
        lead_id = lead_row["id"]
        try:
            count = await refresh_company(lead_id, api_key)
            total_events += count
        except Exception:
            logger.exception("activity_refresh: failed for lead %s", lead_id)
            # Don't let one broken lead kill the whole batch — push its next
            # refresh forward to avoid an immediate retry storm
            try:
                db.update_lead_dg_refresh(lead_id, "C", _next_refresh_at("C"), now_iso())
            except Exception:
                pass

    return total_events
