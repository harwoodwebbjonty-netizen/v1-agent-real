import logging
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request

from app import db
from app.core.config import get_settings
from app.core.rate_limit import limiter
from app.dependencies import CurrentUser, get_current_user
from app.routers.leads import _require_lead_access
from app.schemas_email_writer import (
    CtaSuggestionsRequest,
    CtaSuggestionsResponse,
    EmailDraftOut,
    EmailDraftsResponse,
    GenerateEmailRequest,
    OutreachMailchimpExportRequest,
    PendingEmailDraftOut,
    PendingEmailDraftsResponse,
    PersonalisationRequest,
    PersonalisationResponse,
    RefineEmailRequest,
    SendEmailDraftRequest,
    TimelineEntryOut,
    TimelineResponse,
    UpdateEmailDraftRequest,
)
from app.services.auth_service import new_id, now_iso
from app.services.email_oauth_service import OAuthError, send_email as send_email_via_oauth
from app.services.mailchimp_service import (
    MailchimpError,
    MailchimpNotConfiguredError,
    export_outreach_campaign,
)
from app.services.email_writer_service import (
    generate_cta_suggestions,
    generate_email,
    generate_personalisation,
    refine_email,
)
from app.services.lead_timeline_service import build_timeline, recent_activity_summary
from app.services.template_variables import build_lead_context

router = APIRouter(tags=["email-writer"])
logger = logging.getLogger("app.email_writer")


def _to_draft_out(row: sqlite3.Row) -> EmailDraftOut:
    return EmailDraftOut(
        id=row["id"],
        lead_id=row["lead_id"],
        owner_user_id=row["owner_user_id"],
        subject=row["subject"],
        body=row["body"],
        tone=row["tone"],
        length=row["length"],
        status=row["status"],
        sent_via=row["sent_via"],
        sent_at=row["sent_at"],
        estimated_open_rate=row["estimated_open_rate"],
        estimated_reply_rate=row["estimated_reply_rate"],
        estimated_readability_score=row["estimated_readability_score"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _require_draft_access(draft_row: sqlite3.Row, current_user: CurrentUser) -> None:
    if draft_row["owner_user_id"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You don't have access to this email draft.")


def _check_email_writer_budget(user_id: str) -> None:
    allowed, spent, limit = db.check_credit_limit(user_id, "email_writer")
    if not allowed:
        raise HTTPException(
            status_code=402,
            detail=f"Monthly credit limit reached for AI Email Writer (spent £{spent:.2f} of £{limit:.2f}). "
            "Ask your administrator to raise it.",
        )


def _gather_lead_data(lead_id: str, current_user: CurrentUser):
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)

    phones = db.list_phones(lead_id)
    emails = db.list_emails(lead_id)
    intelligence = db.get_latest_lead_intelligence(lead_id)
    versions = db.list_lead_intelligence_versions(lead_id)
    drafts = db.list_email_drafts(lead_id)
    calendar_events = [e for e in db.list_calendar_events(current_user.id) if e["lead_id"] == lead_id]
    brand_voice_row = db.get_brand_voice(current_user.id)
    brand_voice = dict(brand_voice_row) if brand_voice_row else {}

    timeline = build_timeline(lead, phones, emails, drafts, versions, calendar_events)
    lead_context = build_lead_context(lead, phones, emails, intelligence, current_user.name, brand_voice)
    lead_context["recent_activity"] = recent_activity_summary(timeline)

    # Surface the actual previous emails (subject + body) so a follow-up can
    # reference them and not repeat the same pitch. Drafts are newest-first; the
    # 3 most recent sent ones are plenty of context without bloating the prompt.
    sent_drafts = [d for d in drafts if d["status"] == "sent"]
    lead_context["previous_emails"] = [
        {"subject": d["subject"] or "", "body": d["body"] or "", "sent_at": d["sent_at"] or ""}
        for d in sent_drafts[:3]
    ]

    return lead, lead_context, brand_voice


@router.post("/leads/{lead_id}/email-drafts/generate", response_model=EmailDraftOut)
@limiter.limit(get_settings().rate_limit)
async def generate_draft(
    request: Request, lead_id: str, body: GenerateEmailRequest, current_user: CurrentUser = Depends(get_current_user)
) -> EmailDraftOut:
    _check_email_writer_budget(current_user.id)
    _, lead_context, brand_voice = _gather_lead_data(lead_id, current_user)
    try:
        result = await generate_email(lead_context, brand_voice, body.instruction, body.preset, body.length)
    except Exception:
        logger.exception("Email generation failed for lead %s", lead_id)
        raise HTTPException(status_code=502, detail="AI failed to generate the email. Please try again.")

    db.record_credit_spend(new_id(), current_user.id, "email_writer", db.CREDIT_COST["email_writer"], now_iso())
    draft_id = new_id()
    created_at = now_iso()
    db.create_email_draft(
        draft_id,
        lead_id,
        current_user.id,
        {
            "subject": result.subject,
            "body": result.body,
            "tone": body.preset,
            "length": body.length,
            "estimated_open_rate": result.estimated_open_rate,
            "estimated_reply_rate": result.estimated_reply_rate,
            "estimated_readability_score": result.estimated_readability_score,
        },
        created_at,
    )
    return _to_draft_out(db.get_email_draft(draft_id))


@router.post("/leads/{lead_id}/email-drafts/manual", response_model=EmailDraftOut)
def create_manual_draft(lead_id: str, current_user: CurrentUser = Depends(get_current_user)) -> EmailDraftOut:
    """Starts a blank draft with no AI call and no credit spend — for reps who
    want to write an email by hand instead of generating one. Save/Send/Preview
    all key off draft_id existing, which otherwise only ever gets set via the
    AI generation endpoints above."""
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)

    draft_id = new_id()
    created_at = now_iso()
    db.create_email_draft(
        draft_id, lead_id, current_user.id,
        {"subject": "", "body": "", "tone": "Custom", "length": "Medium"},
        created_at,
    )
    return _to_draft_out(db.get_email_draft(draft_id))


@router.post("/leads/{lead_id}/follow-up-draft", response_model=EmailDraftOut)
@limiter.limit(get_settings().rate_limit)
async def generate_follow_up_draft(
    request: Request, lead_id: str, current_user: CurrentUser = Depends(get_current_user)
) -> EmailDraftOut:
    """One-click follow-up: draft a short follow-up from the lead's call notes,
    company, industry and previous emails (all already in lead_context). Returns
    a normal email_draft the rep reviews and sends from their own account via the
    existing send endpoint — nothing is sent automatically."""
    _check_email_writer_budget(current_user.id)
    _, lead_context, brand_voice = _gather_lead_data(lead_id, current_user)
    instruction = (
        "Write a brief, warm follow-up to our recent phone call and any previous emails. "
        "Reference the call notes and prior context specifically, add a little new value rather "
        "than repeating the earlier pitch, and end with one clear, low-friction next step. Keep it concise."
    )
    try:
        result = await generate_email(lead_context, brand_voice, instruction, "Follow Up", "Short")
    except Exception:
        logger.exception("Follow-up draft generation failed for lead %s", lead_id)
        raise HTTPException(status_code=502, detail="AI failed to generate the follow-up. Please try again.")

    db.record_credit_spend(new_id(), current_user.id, "email_writer", db.CREDIT_COST["email_writer"], now_iso())
    draft_id = new_id()
    created_at = now_iso()
    db.create_email_draft(
        draft_id,
        lead_id,
        current_user.id,
        {
            "subject": result.subject,
            "body": result.body,
            "tone": "Follow Up",
            "length": "Short",
            "estimated_open_rate": result.estimated_open_rate,
            "estimated_reply_rate": result.estimated_reply_rate,
            "estimated_readability_score": result.estimated_readability_score,
        },
        created_at,
    )
    return _to_draft_out(db.get_email_draft(draft_id))


@router.post("/email-drafts/{draft_id}/refine", response_model=EmailDraftOut)
@limiter.limit(get_settings().rate_limit)
async def refine_draft(
    request: Request, draft_id: str, body: RefineEmailRequest, current_user: CurrentUser = Depends(get_current_user)
) -> EmailDraftOut:
    draft = db.get_email_draft(draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Draft not found")
    _require_draft_access(draft, current_user)
    if draft["status"] != "draft":
        raise HTTPException(status_code=400, detail="This email has already been sent and can no longer be refined.")

    _check_email_writer_budget(current_user.id)
    _, lead_context, brand_voice = _gather_lead_data(draft["lead_id"], current_user)
    try:
        result = await refine_email(lead_context, brand_voice, draft["subject"], draft["body"], body.instruction, [])
    except Exception:
        logger.exception("Email refine failed for draft %s", draft_id)
        raise HTTPException(status_code=502, detail="AI failed to refine the email. Please try again.")

    db.record_credit_spend(new_id(), current_user.id, "email_writer", db.CREDIT_COST["email_writer"], now_iso())

    db.update_email_draft_fields(
        draft_id,
        {
            "subject": result.subject,
            "body": result.body,
            "estimated_open_rate": result.estimated_open_rate,
            "estimated_reply_rate": result.estimated_reply_rate,
            "estimated_readability_score": result.estimated_readability_score,
        },
        now_iso(),
    )
    return _to_draft_out(db.get_email_draft(draft_id))


@router.patch("/email-drafts/{draft_id}", response_model=EmailDraftOut)
def update_draft(
    draft_id: str, body: UpdateEmailDraftRequest, current_user: CurrentUser = Depends(get_current_user)
) -> EmailDraftOut:
    draft = db.get_email_draft(draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Draft not found")
    _require_draft_access(draft, current_user)

    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    db.update_email_draft_fields(draft_id, fields, now_iso())
    return _to_draft_out(db.get_email_draft(draft_id))


@router.get("/leads/{lead_id}/email-drafts", response_model=EmailDraftsResponse)
def list_drafts(lead_id: str, current_user: CurrentUser = Depends(get_current_user)) -> EmailDraftsResponse:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    return EmailDraftsResponse(drafts=[_to_draft_out(r) for r in db.list_email_drafts(lead_id)])


@router.get("/email-drafts/pending", response_model=PendingEmailDraftsResponse)
def list_pending_drafts(current_user: CurrentUser = Depends(get_current_user)) -> PendingEmailDraftsResponse:
    rows = db.list_pending_email_drafts(current_user.id)
    return PendingEmailDraftsResponse(
        drafts=[PendingEmailDraftOut(**_to_draft_out(r).model_dump(), lead_company=r["lead_company"]) for r in rows]
    )


@router.delete("/email-drafts/{draft_id}")
def delete_draft(draft_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    draft = db.get_email_draft(draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Draft not found")
    _require_draft_access(draft, current_user)
    db.delete_email_draft(draft_id)
    return {"deleted": True}


@router.post("/leads/{lead_id}/email-drafts/personalisation", response_model=PersonalisationResponse)
@limiter.limit(get_settings().rate_limit)
async def get_personalisation(
    request: Request, lead_id: str, body: PersonalisationRequest, current_user: CurrentUser = Depends(get_current_user)
) -> PersonalisationResponse:
    _check_email_writer_budget(current_user.id)
    _, lead_context, _ = _gather_lead_data(lead_id, current_user)
    try:
        options = await generate_personalisation(lead_context, body.count)
    except Exception:
        logger.exception("Personalisation generation failed for lead %s", lead_id)
        raise HTTPException(status_code=502, detail="AI failed to generate personalisation. Please try again.")
    db.record_credit_spend(new_id(), current_user.id, "email_writer", db.CREDIT_COST["email_writer"], now_iso())
    return PersonalisationResponse(options=options)


@router.post("/leads/{lead_id}/email-drafts/cta-suggestions", response_model=CtaSuggestionsResponse)
@limiter.limit(get_settings().rate_limit)
async def get_cta_suggestions(
    request: Request, lead_id: str, body: CtaSuggestionsRequest, current_user: CurrentUser = Depends(get_current_user)
) -> CtaSuggestionsResponse:
    _check_email_writer_budget(current_user.id)
    _, lead_context, _ = _gather_lead_data(lead_id, current_user)
    try:
        ctas = await generate_cta_suggestions(lead_context, body.goal)
    except Exception:
        logger.exception("CTA suggestion generation failed for lead %s", lead_id)
        raise HTTPException(status_code=502, detail="AI failed to generate CTA suggestions. Please try again.")
    db.record_credit_spend(new_id(), current_user.id, "email_writer", db.CREDIT_COST["email_writer"], now_iso())
    return CtaSuggestionsResponse(ctas=ctas)


@router.get("/leads/{lead_id}/timeline", response_model=TimelineResponse)
def get_timeline(lead_id: str, current_user: CurrentUser = Depends(get_current_user)) -> TimelineResponse:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)

    phones = db.list_phones(lead_id)
    emails = db.list_emails(lead_id)
    versions = db.list_lead_intelligence_versions(lead_id)
    drafts = db.list_email_drafts(lead_id)
    calendar_events = [e for e in db.list_calendar_events(current_user.id) if e["lead_id"] == lead_id]
    entries = build_timeline(lead, phones, emails, drafts, versions, calendar_events)
    return TimelineResponse(entries=[TimelineEntryOut(**e) for e in entries])


@router.post("/email-drafts/{draft_id}/send", response_model=EmailDraftOut)
async def send_draft(
    draft_id: str, body: SendEmailDraftRequest, current_user: CurrentUser = Depends(get_current_user)
) -> EmailDraftOut:
    draft = db.get_email_draft(draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="Draft not found")
    _require_draft_access(draft, current_user)
    if draft["status"] != "draft":
        raise HTTPException(status_code=400, detail="This email has already been sent.")

    account = db.get_email_oauth_account(current_user.id, body.provider)
    if account is None:
        raise HTTPException(status_code=400, detail=f"Connect a {body.provider} account in Settings first.")

    emails = db.list_emails(draft["lead_id"])
    to = emails[0]["email"] if emails else None
    if not to:
        raise HTTPException(status_code=400, detail="This lead has no email address on file.")

    try:
        await send_email_via_oauth(account, to, draft["subject"], draft["body"])
    except OAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    db.mark_email_draft_sent(draft_id, body.provider, now_iso())
    db.record_audit(current_user.id, current_user.name, "send", "email_draft", draft_id, detail=f"to={to} via={body.provider}")
    return _to_draft_out(db.get_email_draft(draft_id))


@router.post("/email-drafts/export-mailchimp")
async def export_drafts_to_mailchimp(
    body: OutreachMailchimpExportRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Export pending email drafts as a personalised Mailchimp campaign.

    Fetches the user's unsent drafts (or the specified subset), looks up each
    lead's contact email address, upserts all contacts into the Mailchimp
    audience with their personalised subject + body as merge tags, creates a
    campaign draft, and returns the Mailchimp edit URL.
    """
    if body.draft_ids:
        rows = [db.get_email_draft(did) for did in body.draft_ids]
        rows = [r for r in rows if r and r["owner_user_id"] == current_user.id]
    else:
        rows = db.list_pending_email_drafts(current_user.id)

    if not rows:
        raise HTTPException(status_code=400, detail="No unsent drafts found to export.")

    drafts: list[dict] = []
    for row in rows:
        lead = db.get_lead(row["lead_id"])
        if not lead:
            continue
        lead_emails = db.list_emails(row["lead_id"])
        contact_email = lead_emails[0]["email"] if lead_emails else ""
        drafts.append({
            "contact_email": contact_email,
            "contact_name": lead["contact_name"] or "",
            "company": lead["company"] or "",
            "subject": row["subject"] or "",
            "body": row["body"] or "",
        })

    account = db.get_email_oauth_account(current_user.id, "google") \
        or db.get_email_oauth_account(current_user.id, "microsoft")
    from_name = current_user.name
    settings = get_settings()
    from_email = (
        (account["email_address"] if account else "")
        or settings.mailchimp_from_email
    )
    if not from_email:
        raise HTTPException(
            status_code=422,
            detail="No from-email found. Connect a Gmail/Microsoft account in Settings, "
                   "or set MAILCHIMP_FROM_EMAIL in backend/.env.",
        )

    try:
        result = await export_outreach_campaign(
            campaign_name=body.campaign_name,
            from_name=from_name,
            from_email=from_email,
            drafts=drafts,
        )
    except MailchimpNotConfiguredError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except MailchimpError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return result
