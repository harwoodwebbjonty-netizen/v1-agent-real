"""List Email Campaigns — a rep picks a cold-call list, gives one overall idea
(deals/offers + a call link), and this generates a per-lead email for every lead
on the list, using that lead's own CRM notes and letting the lead's status pick
the angle. Deliberately lightweight: it reuses the generic Email Writer engine
(`generate_email`) — pure generation from context already on the lead, no web
research/scraping — so it stays cheap and fast. Structure (background generate +
credit-stop + resume) mirrors the win-back campaign task; the per-lead email
content is stored in `email_drafts` tagged with the campaign_id, so the existing
draft edit/send pipeline works unchanged."""

import asyncio
import logging

from app import db
from app.services.auth_service import new_id, now_iso
from app.services.email_writer_service import generate_email
from app.services.lead_timeline_service import build_timeline, recent_activity_summary
from app.services.template_variables import build_lead_context
from app.services.win_back_email_service import apply_campaign_link, append_signature

logger = logging.getLogger("app.list_campaign")

CAMPAIGN_CONCURRENCY = 6

# Each of the four lead statuses picks an existing Email Writer preset so the
# email's angle matches where the relationship actually is. Anything unexpected
# falls back to a first-touch cold email.
STATUS_PRESET = {
    "New": "Cold Outreach",
    "Contacted": "Follow Up",
    "Replied": "Re-Engagement",
    "Converted": "Customer Retention",
}
DEFAULT_PRESET = "Cold Outreach"
EMAIL_LENGTH = "Short"


def _build_instruction(idea: str, offers: str, link_url: str) -> str:
    parts = [idea.strip()]
    if offers.strip():
        parts.append(
            "Current offers / deals to weave in where genuinely relevant — do not "
            f"alter any figures or invent terms: {offers.strip()}"
        )
    if link_url.strip():
        parts.append(
            "End with a single clear call to action inviting them to use this exact "
            f"link (copy it verbatim, do not invent a URL): {link_url.strip()}"
        )
    return "\n\n".join(p for p in parts if p)


def _lead_context(lead, owner_user_id: str, sender_name: str, brand_voice: dict) -> dict:
    phones = db.list_phones(lead["id"])
    emails = db.list_emails(lead["id"])
    intelligence = db.get_latest_lead_intelligence(lead["id"])
    drafts = db.list_email_drafts(lead["id"])
    versions = db.list_lead_intelligence_versions(lead["id"])
    calendar_events = [e for e in db.list_calendar_events(owner_user_id) if e["lead_id"] == lead["id"]]
    ctx = build_lead_context(lead, phones, emails, intelligence, sender_name, brand_voice)
    ctx["recent_activity"] = recent_activity_summary(
        build_timeline(lead, phones, emails, drafts, versions, calendar_events)
    )
    return ctx


async def generate_campaign(
    campaign_id: str,
    lead_ids: list[str],
    owner_user_id: str,
    idea: str,
    offers: str,
    link_url: str,
    link_text: str,
    signature: str,
) -> None:
    """Background task: writes one email draft per lead, credit-gated on the
    per-user `email_writer` budget. A lead skipped at the credit ceiling simply
    gets no draft (resume fills it later). NEVER raises — one bad lead can't stop
    the batch; a crash marks the campaign 'error'."""
    semaphore = asyncio.Semaphore(CAMPAIGN_CONCURRENCY)
    stopped_by_credit = False
    instruction = _build_instruction(idea, offers, link_url)

    try:
        brand_voice_row = db.get_brand_voice(owner_user_id)
        brand_voice = dict(brand_voice_row) if brand_voice_row else {}
        user_row = db.get_user_by_id(owner_user_id)
        sender_name = user_row["name"] if user_row else ""

        async def _process_lead(lead_id: str) -> None:
            nonlocal stopped_by_credit
            async with semaphore:
                try:
                    lead = db.get_lead(lead_id)
                    if lead is None:
                        return

                    allowed, spent, limit = db.check_credit_limit(owner_user_id, "email_writer")
                    if not allowed:
                        stopped_by_credit = True
                        logger.warning(
                            "List campaign: email_writer credit limit £%.2f reached (spent £%.2f) — skipping %s",
                            limit, spent, lead_id,
                        )
                        return

                    ctx = _lead_context(lead, owner_user_id, sender_name, brand_voice)
                    status = lead["contact_status"] or "New"
                    preset = STATUS_PRESET.get(status, DEFAULT_PRESET)

                    result = await generate_email(ctx, brand_voice, instruction, preset, EMAIL_LENGTH)

                    email = {"subject": result.subject, "body": result.body}
                    email = apply_campaign_link(email, link_url, link_text)
                    email = append_signature(email, signature)

                    db.create_email_draft(
                        new_id(),
                        lead_id,
                        owner_user_id,
                        {
                            "subject": email["subject"],
                            "body": email["body"],
                            "tone": preset,
                            "length": EMAIL_LENGTH,
                            "estimated_open_rate": result.estimated_open_rate,
                            "estimated_reply_rate": result.estimated_reply_rate,
                            "estimated_readability_score": result.estimated_readability_score,
                            "campaign_id": campaign_id,
                        },
                        now_iso(),
                    )
                    db.record_credit_spend(new_id(), owner_user_id, "email_writer", db.CREDIT_COST["email_writer"], now_iso())
                except Exception:
                    logger.exception("List campaign: email generation failed for %s", lead_id)

        await asyncio.gather(*[_process_lead(lid) for lid in lead_ids], return_exceptions=True)
        db.update_list_campaign_status(campaign_id, "stopped" if stopped_by_credit else "ready", now_iso())
    except Exception:
        logger.exception("List campaign: generation task crashed for %s", campaign_id)
        db.update_list_campaign_status(campaign_id, "error", now_iso())
