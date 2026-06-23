import sqlite3
from datetime import datetime, timezone
from typing import Optional

# Single dict-based variable builder + single generic substitution function —
# adding a future variable is "add one more key here," never new logic.


def build_lead_context(
    lead: sqlite3.Row,
    phones: list[sqlite3.Row],
    emails: list[sqlite3.Row],
    intelligence: Optional[sqlite3.Row],
    sender_name: str,
    brand_voice: dict,
) -> dict:
    contact_name = lead["contact_name"] or ""
    first_name = contact_name.split(" ")[0] if contact_name else ""
    return {
        "first_name": first_name,
        "company": lead["company"] or "",
        "job_title": lead["contact_title"] or "",
        "industry": lead["industry"] or "",
        "website": lead["website"] or "",
        "linkedin": lead["linkedin"] or "",
        "phone": phones[0]["phone_number"] if phones else (lead["phone_number"] or ""),
        "email": emails[0]["email"] if emails else "",
        "lead_notes": lead["lead_notes"] or "",
        "ai_summary": intelligence["sales_summary"] if intelligence else "",
        "recent_activity": "",  # filled in by the caller once the timeline is built
        "sender_name": sender_name,
        "sender_company": brand_voice.get("company_name", ""),
        "booking_link": brand_voice.get("booking_link", ""),
        "current_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        # No such fields exist on a lead today — resolve empty rather than
        # inventing new columns nobody asked for elsewhere.
        "city": "",
        "country": "",
        # Reserved for future per-org custom fields — resolves empty for now.
        "custom_field": "",
    }


def substitute_variables(text: str, variables: dict) -> str:
    result = text
    for key, value in variables.items():
        result = result.replace(f"{{{{{key}}}}}", value or "")
    return result
