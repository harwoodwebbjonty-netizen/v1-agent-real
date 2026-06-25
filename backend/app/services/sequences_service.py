"""Sales Sequences — multi-channel automation. Email steps send for real
through the existing OAuth path; call/follow-up/reminder steps create a
real calendar task rather than performing anything themselves, since those
channels can't be automated. The scheduler is a single in-process loop —
correct for the single-worker systemd deployment this backend actually
runs under (see backend/DEPLOY.md); running multiple uvicorn workers would
need a real lock to avoid double-sends, which is out of scope until that's
actually how this gets deployed."""

import logging
from datetime import datetime, timedelta, timezone

from app import db
from app.services.auth_service import new_id, now_iso
from app.services.email_oauth_service import OAuthError, send_email
from app.services.template_variables import build_lead_context, substitute_variables

logger = logging.getLogger("app.sequences")

CALENDAR_TASK_TYPES = {"call_task": "call", "followup_task": "followup", "reminder_task": "task"}


def add_days_iso(base_iso: str, days: int) -> str:
    base = datetime.fromisoformat(base_iso)
    return (base + timedelta(days=days)).isoformat()


def _render_lead_context(lead_row) -> dict:
    phones = db.list_phones(lead_row["id"])
    emails = db.list_emails(lead_row["id"])
    intelligence = db.get_latest_lead_intelligence(lead_row["id"])
    owner = db.get_user_by_id(lead_row["owner_user_id"]) if lead_row["owner_user_id"] else None
    brand_voice_row = db.get_brand_voice(lead_row["owner_user_id"]) if lead_row["owner_user_id"] else None
    brand_voice = dict(brand_voice_row) if brand_voice_row else {}
    return build_lead_context(lead_row, phones, emails, intelligence, owner["name"] if owner else "", brand_voice)


async def _execute_email_step_async(lead_row, step_row, owner_user_id: str) -> str:
    emails = db.list_emails(lead_row["id"])
    to = emails[0]["email"] if emails else None
    if not to:
        return "Lead has no email address on file"

    account = db.get_email_oauth_account(owner_user_id, "google") or db.get_email_oauth_account(owner_user_id, "microsoft")
    if account is None:
        return "No connected email account (Gmail/Microsoft) for the sequence owner"
    provider = account["provider"]

    context = _render_lead_context(lead_row)
    subject = substitute_variables(step_row["subject_template"], context)
    body = substitute_variables(step_row["body_template"], context)

    draft_id = new_id()
    created_at = now_iso()
    db.create_email_draft(
        draft_id,
        lead_row["id"],
        owner_user_id,
        {
            "subject": subject,
            "body": body,
            "tone": "Sequence",
            "length": "",
            "estimated_open_rate": None,
            "estimated_reply_rate": None,
            "estimated_readability_score": None,
        },
        created_at,
    )

    try:
        await send_email(account, to, subject, body)
    except OAuthError as exc:
        return f"Send failed: {exc}"

    db.mark_email_draft_sent(draft_id, provider, now_iso())
    return ""


def _execute_task_step(lead_row, step_row, owner_user_id: str) -> str:
    event_type = CALENDAR_TASK_TYPES[step_row["step_type"]]
    context = _render_lead_context(lead_row)
    title = substitute_variables(step_row["subject_template"], context) or f"{event_type.title()}: {lead_row['company']}"
    today = now_iso()[:10]
    db.create_calendar_event(
        id=new_id(),
        owner_user_id=owner_user_id,
        title=title,
        date=today,
        time="",
        type=event_type,
        lead_id=lead_row["id"],
        description=substitute_variables(step_row["body_template"], context),
        created_at=now_iso(),
    )
    return ""


async def process_due_enrollments() -> int:
    """Returns the number of enrollments processed — called by the
    background loop, and callable directly from tests/an admin action."""
    now = now_iso()
    due = db.list_due_enrollments(now)
    for enrollment in due:
        sequence = db.get_sequence(enrollment["sequence_id"])
        if sequence is None or sequence["status"] != "active":
            db.update_enrollment(enrollment["id"], {"status": "stopped", "last_error": "Sequence is no longer active"})
            continue

        steps = db.list_sequence_steps(enrollment["sequence_id"])
        step_index = enrollment["current_step"]
        if step_index >= len(steps):
            db.update_enrollment(enrollment["id"], {"status": "completed", "next_run_at": None})
            continue

        step = steps[step_index]
        lead = db.get_lead(enrollment["lead_id"])
        if lead is None:
            db.update_enrollment(enrollment["id"], {"status": "stopped", "last_error": "Lead no longer exists"})
            continue

        try:
            if step["step_type"] == "email":
                error = await _execute_email_step_async(lead, step, sequence["owner_user_id"])
            else:
                error = _execute_task_step(lead, step, sequence["owner_user_id"])
        except Exception as exc:  # noqa: BLE001 — never let one bad enrollment break the whole batch
            logger.exception("Sequence step failed for enrollment %s", enrollment["id"])
            error = str(exc)

        if error:
            db.update_enrollment(enrollment["id"], {"status": "stopped", "last_error": error})
            logger.warning("Enrollment %s stopped: %s", enrollment["id"], error)
            continue

        next_index = step_index + 1
        if next_index >= len(steps):
            db.update_enrollment(enrollment["id"], {"current_step": next_index, "status": "completed", "next_run_at": None})
        else:
            next_run_at = add_days_iso(now, steps[next_index]["delay_days"])
            db.update_enrollment(enrollment["id"], {"current_step": next_index, "next_run_at": next_run_at})

    return len(due)
