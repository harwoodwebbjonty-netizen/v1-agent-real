import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.routers.leads import _require_lead_access
from app.schemas_email_templates import (
    ApplyEmailTemplateRequest,
    ApplyEmailTemplateResponse,
    CreateEmailTemplateRequest,
    EmailTemplateOut,
    EmailTemplatesResponse,
    UpdateEmailTemplateRequest,
)
from app.services.auth_service import new_id, now_iso
from app.services.lead_timeline_service import build_timeline, recent_activity_summary
from app.services.template_variables import build_lead_context, substitute_variables

router = APIRouter(prefix="/email-templates", tags=["email-templates"])


def _user_name_map() -> dict[str, str]:
    return {u["id"]: u["name"] for u in db.list_users()}


def _to_template_out(row: sqlite3.Row, names: dict[str, str]) -> EmailTemplateOut:
    return EmailTemplateOut(
        id=row["id"],
        owner_user_id=row["owner_user_id"],
        owner_name=names.get(row["owner_user_id"]),
        name=row["name"],
        subject=row["subject"],
        body=row["body"],
        tone=row["tone"],
        length=row["length"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _require_template_access(row: sqlite3.Row, current_user: CurrentUser) -> None:
    if row["owner_user_id"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You don't have access to this template.")


@router.post("", response_model=EmailTemplateOut)
def create_template(
    body: CreateEmailTemplateRequest, current_user: CurrentUser = Depends(get_current_user)
) -> EmailTemplateOut:
    template_id = new_id()
    db.create_email_template(
        template_id, current_user.id, body.name, body.subject, body.body, body.tone, body.length, now_iso()
    )
    return _to_template_out(db.get_email_template(template_id), _user_name_map())


@router.get("", response_model=EmailTemplatesResponse)
def list_templates(current_user: CurrentUser = Depends(get_current_user)) -> EmailTemplatesResponse:
    names = _user_name_map()
    rows = db.list_email_templates() if current_user.role == "admin" else db.list_email_templates(current_user.id)
    return EmailTemplatesResponse(templates=[_to_template_out(r, names) for r in rows])


@router.patch("/{template_id}", response_model=EmailTemplateOut)
def update_template(
    template_id: str, body: UpdateEmailTemplateRequest, current_user: CurrentUser = Depends(get_current_user)
) -> EmailTemplateOut:
    row = db.get_email_template(template_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Template not found")
    _require_template_access(row, current_user)

    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    db.update_email_template_fields(template_id, fields, now_iso())
    return _to_template_out(db.get_email_template(template_id), _user_name_map())


@router.delete("/{template_id}")
def delete_template(template_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    row = db.get_email_template(template_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Template not found")
    _require_template_access(row, current_user)
    db.delete_email_template(template_id)
    return {"deleted": True}


@router.post("/{template_id}/apply", response_model=ApplyEmailTemplateResponse)
def apply_template(
    template_id: str, body: ApplyEmailTemplateRequest, current_user: CurrentUser = Depends(get_current_user)
) -> ApplyEmailTemplateResponse:
    template = db.get_email_template(template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    _require_template_access(template, current_user)

    lead = db.get_lead(body.lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)

    phones = db.list_phones(lead["id"])
    emails = db.list_emails(lead["id"])
    intelligence = db.get_latest_lead_intelligence(lead["id"])
    versions = db.list_lead_intelligence_versions(lead["id"])
    drafts = db.list_email_drafts(lead["id"])
    calendar_events = [e for e in db.list_calendar_events(current_user.id) if e["lead_id"] == lead["id"]]
    brand_voice_row = db.get_brand_voice(current_user.id)
    brand_voice = dict(brand_voice_row) if brand_voice_row else {}

    variables = build_lead_context(lead, phones, emails, intelligence, current_user.name, brand_voice)
    timeline = build_timeline(lead, phones, emails, drafts, versions, calendar_events)
    variables["recent_activity"] = recent_activity_summary(timeline)

    return ApplyEmailTemplateResponse(
        subject=substitute_variables(template["subject"], variables),
        body=substitute_variables(template["body"], variables),
    )
