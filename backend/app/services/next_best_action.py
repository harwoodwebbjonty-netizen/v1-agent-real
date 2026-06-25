"""Deterministic, explainable recommendation per lead — never LLM-generated
text. Every recommendation traces back to a real field so it's always
defensible: "why does it say this?" always has a concrete answer."""

from datetime import date as date_cls
from typing import Optional

from app.schemas_leads import NextBestActionOut

FOLLOW_UP_STALE_DAYS = 14


def _days_between(today: str, past: str) -> int:
    return (date_cls.fromisoformat(today) - date_cls.fromisoformat(past[:10])).days


def compute_next_best_action(
    *,
    status: str,
    contact_status: str,
    opportunity_stage: str,
    lead_score: Optional[int],
    has_intelligence: bool,
    call_scheduled_today: bool,
    last_contact_date: Optional[str],
    today: str,
) -> NextBestActionOut:
    if status in ("unverified", "not_found"):
        return NextBestActionOut(action="Verify phone", reason="Phone number not yet verified")

    if not has_intelligence:
        return NextBestActionOut(action="Generate research", reason="No AI Sales Intelligence generated yet")

    if call_scheduled_today:
        return NextBestActionOut(action="Call now", reason="A call is scheduled today")

    if opportunity_stage == "none":
        if contact_status == "Replied":
            return NextBestActionOut(action="Move to Opportunity", reason="Lead has replied")
        if lead_score is not None and lead_score >= 80:
            return NextBestActionOut(action="Move to Opportunity", reason=f"High lead score ({lead_score})")

    if contact_status == "Contacted":
        if last_contact_date is None:
            return NextBestActionOut(
                action="Send follow-up email", reason="Marked Contacted but no recorded activity yet"
            )
        days_since = _days_between(today, last_contact_date)
        if days_since > FOLLOW_UP_STALE_DAYS:
            return NextBestActionOut(action="Send follow-up email", reason=f"No contact in {days_since} days")

    if contact_status == "New":
        return NextBestActionOut(action="Schedule a call", reason="New lead, not yet contacted")

    return NextBestActionOut(action="No action needed", reason="Recently active")
