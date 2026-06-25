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
from app.services.email_writer_service import (
    generate_cta_suggestions,
    generate_email,
    generate_personalisation,
    refine_email,
)
from app.services.lead_timeline_service import build_timeline, recent_activity_summary
from app.services.template_variables import build_lead_context

router = APIRouter(tags=["email-writer"])


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

    return lead, lead_context, brand_voice


@router.post("/leads/{lead_id}/email-drafts/generate", response_model=EmailDraftOut)
@limiter.limit(get_settings().rate_limit)
async def generate_draft(
    request: Request, lead_id: str, body: GenerateEmailRequest, current_user: CurrentUser = Depends(get_current_user)
) -> EmailDraftOut:
    _, lead_context, brand_voice = _gather_lead_data(lead_id, current_user)
    try:
        result = await generate_email(lead_context, brand_voice, body.instruction, body.preset, body.length)
    except Exception:
        raise HTTPException(status_code=502, detail="AI failed to generate the email. Please try again.")

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

    _, lead_context, brand_voice = _gather_lead_data(draft["lead_id"], current_user)
    try:
        result = await refine_email(lead_context, brand_voice, draft["subject"], draft["body"], body.instruction, [])
    except Exception:
        raise HTTPException(status_code=502, detail="AI failed to refine the email. Please try again.")

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
    _, lead_context, _ = _gather_lead_data(lead_id, current_user)
    try:
        options = await generate_personalisation(lead_context, body.count)
    except Exception:
        raise HTTPException(status_code=502, detail="AI failed to generate personalisation. Please try again.")
    return PersonalisationResponse(options=options)


@router.post("/leads/{lead_id}/email-drafts/cta-suggestions", response_model=CtaSuggestionsResponse)
@limiter.limit(get_settings().rate_limit)
async def get_cta_suggestions(
    request: Request, lead_id: str, body: CtaSuggestionsRequest, current_user: CurrentUser = Depends(get_current_user)
) -> CtaSuggestionsResponse:
    _, lead_context, _ = _gather_lead_data(lead_id, current_user)
    try:
        ctas = await generate_cta_suggestions(lead_context, body.goal)
    except Exception:
        raise HTTPException(status_code=502, detail="AI failed to generate CTA suggestions. Please try again.")
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
    return _to_draft_out(db.get_email_draft(draft_id))
