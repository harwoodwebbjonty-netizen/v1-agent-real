import json
import sqlite3
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from app import db
from app.core.config import get_settings
from app.core.rate_limit import limiter
from app.dependencies import CurrentUser, get_current_user, require_admin
from app.schemas_contacts import (
    AddEmailRequest,
    AddPhoneRequest,
    EmailOut,
    PhoneOut,
    UpdateEmailRequest,
    UpdatePhoneRequest,
)
from app.schemas_leads import (
    AssignLeadRequest,
    CreateLeadRequest,
    LeadListResponse,
    LeadOut,
    MigrateRequest,
    MigrateResponse,
    UpdateLeadRequest,
)
from app.schemas_sales_intelligence import (
    LeadIntelligenceHistoryResponse,
    LeadIntelligenceOut,
    LeadIntelligenceVersionOut,
)
from app.services.anthropic_service import lookup_company_phone
from app.services.auth_service import new_id, now_iso
from app.services.email_scraper_service import scrape_emails
from app.services.next_best_action import compute_next_best_action
from app.services.sales_intelligence_service import (
    IntelligenceExtractionError,
    generate_sales_intelligence,
)

router = APIRouter(prefix="/leads", tags=["leads"])


class ActivityContext:
    """Bulk activity data needed for Next Best Action, fetched once per
    request (3 grouped queries total) — never once per lead, so list views
    stay cheap regardless of how many leads exist."""

    def __init__(self) -> None:
        self.today = now_iso()[:10]
        self.call_log_dates = db.get_latest_call_log_dates()
        self.email_dates = db.get_latest_sent_email_dates()
        self.calendar_dates = db.get_latest_past_calendar_dates(self.today)
        self.calls_today = db.get_lead_ids_with_call_scheduled(self.today)

    def last_contact_date(self, lead_id: str) -> Optional[str]:
        candidates = [
            self.call_log_dates.get(lead_id),
            self.email_dates.get(lead_id),
            self.calendar_dates.get(lead_id),
        ]
        present = [c for c in candidates if c]
        return max(present) if present else None


def get_activity_context() -> ActivityContext:
    return ActivityContext()

_INTELLIGENCE_JSON_COLUMNS = (
    "pain_points",
    "buying_signals",
    "conversation_starters",
    "discovery_questions",
    "objection_handling",
    "score_breakdown",
)


def _intelligence_fields_from_row(row: sqlite3.Row) -> dict:
    fields = {col: row[col] for col in ("executive_summary", "sales_summary", "pitch_angle", "call_brief", "lead_score", "lead_temperature", "confidence_note")}
    for col in _INTELLIGENCE_JSON_COLUMNS:
        fields[col] = json.loads(row[col])
    return fields


def _to_intelligence_out(lead_id: str, row: sqlite3.Row) -> Optional[LeadIntelligenceOut]:
    if row is None:
        return None
    versions = db.list_lead_intelligence_versions(lead_id)
    return LeadIntelligenceOut(
        **_intelligence_fields_from_row(row),
        generated_at=db.get_lead_intelligence_first_generated_at(lead_id) or row["created_at"],
        updated_at=row["created_at"],
        version_count=len(versions),
    )


def _to_intelligence_version_out(row: sqlite3.Row) -> LeadIntelligenceVersionOut:
    return LeadIntelligenceVersionOut(
        id=row["id"],
        **_intelligence_fields_from_row(row),
        created_at=row["created_at"],
    )


def _user_name_map() -> dict[str, str]:
    return {u["id"]: u["name"] for u in db.list_users()}


def _to_lead_out(row: sqlite3.Row, names: dict[str, str], activity: ActivityContext) -> LeadOut:
    intelligence = _to_intelligence_out(row["id"], db.get_latest_lead_intelligence(row["id"]))
    next_best_action = compute_next_best_action(
        status=row["status"],
        contact_status=row["contact_status"],
        opportunity_stage=row["opportunity_stage"],
        lead_score=intelligence.lead_score if intelligence else None,
        has_intelligence=intelligence is not None,
        call_scheduled_today=row["id"] in activity.calls_today,
        last_contact_date=activity.last_contact_date(row["id"]),
        today=activity.today,
    )
    return LeadOut(
        id=row["id"],
        timestamp=row["timestamp"],
        company=row["company"],
        phone_number=row["phone_number"],
        source_url=row["source_url"],
        status=row["status"],
        notes=row["notes"],
        industry=row["industry"],
        contact_status=row["contact_status"],
        lead_notes=row["lead_notes"],
        contact_name=row["contact_name"] or "",
        contact_title=row["contact_title"] or "",
        website=row["website"] or "",
        linkedin=row["linkedin"] or "",
        owner_user_id=row["owner_user_id"],
        owner_name=names.get(row["owner_user_id"]) if row["owner_user_id"] else None,
        assigned_user_id=row["assigned_user_id"],
        assigned_name=names.get(row["assigned_user_id"]) if row["assigned_user_id"] else None,
        list_id=row["list_id"],
        opportunity_stage=row["opportunity_stage"],
        next_best_action=next_best_action,
        phones=[PhoneOut(id=p["id"], phone_number=p["phone_number"], source=p["source"]) for p in db.list_phones(row["id"])],
        emails=[EmailOut(id=e["id"], email=e["email"], source=e["source"]) for e in db.list_emails(row["id"])],
        intelligence=intelligence,
    )


def _duplicate_error(kind: str) -> HTTPException:
    return HTTPException(status_code=400, detail=f"That {kind} is already on this lead.")


def _require_lead_access(row: sqlite3.Row, current_user: CurrentUser) -> None:
    """Leads outside any list are part of the shared pool — visible/editable
    by everyone, unchanged. Leads inside a list are private to their owner,
    except admins, who can reach everything."""
    if row["list_id"] and row["owner_user_id"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You don't have access to this lead.")


@router.get("", response_model=LeadListResponse)
def list_leads(current_user: CurrentUser = Depends(get_current_user), activity: ActivityContext = Depends(get_activity_context)) -> LeadListResponse:
    names = _user_name_map()
    return LeadListResponse(leads=[_to_lead_out(r, names, activity) for r in db.list_leads()])


@router.post("", response_model=LeadOut)
@limiter.limit(get_settings().rate_limit)
async def create_lead(
    request: Request, body: CreateLeadRequest, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    # Default path (body.list_id is None): identical to before — lead lands
    # in the shared pool, owned by whoever ran the lookup.
    owner_user_id = current_user.id
    if body.list_id is not None:
        lead_list = db.get_lead_list(body.list_id)
        if lead_list is None:
            raise HTTPException(status_code=404, detail="List not found")
        if lead_list["owner_user_id"] != current_user.id and current_user.role != "admin":
            raise HTTPException(status_code=403, detail="You don't have access to this list.")
        owner_user_id = lead_list["owner_user_id"]

    # Calls the existing, unchanged AI pipeline function — this router is the
    # only place that persists its result, the service itself stays pure.
    result = await lookup_company_phone(body.company)

    lead_id = new_id()
    created_at = now_iso()
    db.create_lead(
        id=lead_id,
        timestamp=created_at,
        company=result.company,
        phone_number=result.phone_number,
        source_url=result.source_url,
        status=result.status,
        notes=result.notes,
        owner_user_id=owner_user_id,
        created_at=created_at,
        list_id=body.list_id,
    )

    # The only touch point added to this flow: mirror the AI-found number
    # into the new multi-value table too, so it shows up alongside anything
    # added manually later. Skipped when there's no real number to mirror.
    if result.status != "not_found" and result.phone_number:
        db.add_phone_ignore_duplicate(
            id=new_id(), lead_id=lead_id, phone_number=result.phone_number, source="scraped", created_at=created_at
        )

    row = db.get_lead(lead_id)
    return _to_lead_out(row, _user_name_map(), activity)


@router.get("/{lead_id}", response_model=LeadOut)
def get_lead(lead_id: str, current_user: CurrentUser = Depends(get_current_user), activity: ActivityContext = Depends(get_activity_context)) -> LeadOut:
    row = db.get_lead(lead_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(row, current_user)
    return _to_lead_out(row, _user_name_map(), activity)


@router.patch("/{lead_id}", response_model=LeadOut)
def update_lead(
    lead_id: str, body: UpdateLeadRequest, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    row = db.get_lead(lead_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(row, current_user)

    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    db.update_lead_fields(lead_id, fields, now_iso())

    updated = db.get_lead(lead_id)
    return _to_lead_out(updated, _user_name_map(), activity)


@router.post("/{lead_id}/assign", response_model=LeadOut)
def assign_lead(
    lead_id: str, body: AssignLeadRequest, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    row = db.get_lead(lead_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(row, current_user)

    if body.assigned_user_id is not None and db.get_user_by_id(body.assigned_user_id) is None:
        raise HTTPException(status_code=400, detail="assigned_user_id does not match a known user")

    db.assign_lead(lead_id, body.assigned_user_id, now_iso())

    updated = db.get_lead(lead_id)
    return _to_lead_out(updated, _user_name_map(), activity)


# --- Phone numbers (manual CRUD — independent of the AI phone-lookup pipeline above) ---

@router.post("/{lead_id}/phones", response_model=LeadOut)
def add_phone(
    lead_id: str, body: AddPhoneRequest, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    try:
        db.add_phone(id=new_id(), lead_id=lead_id, phone_number=body.phone_number, source="manual", created_at=now_iso())
    except sqlite3.IntegrityError:
        raise _duplicate_error("phone number")
    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


@router.patch("/{lead_id}/phones/{phone_id}", response_model=LeadOut)
def update_phone(
    lead_id: str, phone_id: str, body: UpdatePhoneRequest, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    phone = db.get_phone(phone_id)
    if phone is None or phone["lead_id"] != lead_id:
        raise HTTPException(status_code=404, detail="Phone number not found on this lead")
    try:
        db.update_phone(phone_id, body.phone_number)
    except sqlite3.IntegrityError:
        raise _duplicate_error("phone number")
    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


@router.delete("/{lead_id}/phones/{phone_id}", response_model=LeadOut)
def delete_phone(lead_id: str, phone_id: str, current_user: CurrentUser = Depends(get_current_user), activity: ActivityContext = Depends(get_activity_context)) -> LeadOut:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    phone = db.get_phone(phone_id)
    if phone is None or phone["lead_id"] != lead_id:
        raise HTTPException(status_code=404, detail="Phone number not found on this lead")
    db.delete_phone(phone_id)
    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


# --- Email addresses (manual CRUD — fully independent of phones and of the email scraper) ---

@router.post("/{lead_id}/emails", response_model=LeadOut)
def add_email(
    lead_id: str, body: AddEmailRequest, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    try:
        db.add_email(id=new_id(), lead_id=lead_id, email=body.email, source="manual", created_at=now_iso())
    except sqlite3.IntegrityError:
        raise _duplicate_error("email address")
    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


@router.patch("/{lead_id}/emails/{email_id}", response_model=LeadOut)
def update_email(
    lead_id: str, email_id: str, body: UpdateEmailRequest, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    email = db.get_email(email_id)
    if email is None or email["lead_id"] != lead_id:
        raise HTTPException(status_code=404, detail="Email address not found on this lead")
    try:
        db.update_email(email_id, body.email)
    except sqlite3.IntegrityError:
        raise _duplicate_error("email address")
    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


@router.delete("/{lead_id}/emails/{email_id}", response_model=LeadOut)
def delete_email(lead_id: str, email_id: str, current_user: CurrentUser = Depends(get_current_user), activity: ActivityContext = Depends(get_activity_context)) -> LeadOut:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    email = db.get_email(email_id)
    if email is None or email["lead_id"] != lead_id:
        raise HTTPException(status_code=404, detail="Email address not found on this lead")
    db.delete_email(email_id)
    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


# --- Independent AI email scraper — manual trigger only, never automatic ---

@router.post("/{lead_id}/scrape-email", response_model=LeadOut)
@limiter.limit(get_settings().rate_limit)
async def scrape_email_route(
    request: Request, lead_id: str, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)

    result = await scrape_emails(lead["company"])
    created_at = now_iso()
    for email in result.emails:
        db.add_email_ignore_duplicate(id=new_id(), lead_id=lead_id, email=email, source="scraped", created_at=created_at)

    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


# --- AI Sales Intelligence — manual trigger only, full version history kept ---

@router.post("/{lead_id}/generate-intelligence", response_model=LeadOut)
@limiter.limit(get_settings().rate_limit)
async def generate_intelligence_route(
    request: Request, lead_id: str, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)

    try:
        db.acquire_intelligence_lock(lead_id, now_iso())
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Intelligence generation already in progress")

    try:
        result = await generate_sales_intelligence(lead["company"], lead["website"] or "")
        db.add_lead_intelligence_version(
            new_id(),
            lead_id,
            {
                "executive_summary": result.executive_summary,
                "sales_summary": result.sales_summary,
                "pain_points": json.dumps(result.pain_points.model_dump()),
                "buying_signals": json.dumps(result.buying_signals),
                "conversation_starters": json.dumps(result.conversation_starters),
                "discovery_questions": json.dumps(result.discovery_questions),
                "objection_handling": json.dumps([o.model_dump() for o in result.objection_handling]),
                "pitch_angle": result.pitch_angle,
                "call_brief": result.call_brief,
                "score_breakdown": json.dumps(result.score_breakdown.model_dump()),
                "lead_score": result.lead_score,
                "lead_temperature": result.lead_temperature,
                "confidence_note": result.confidence_note,
            },
            now_iso(),
        )
    except IntelligenceExtractionError:
        raise HTTPException(
            status_code=502, detail="AI returned an incomplete result after retrying. Please try again."
        )
    finally:
        db.release_intelligence_lock(lead_id)

    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


@router.get("/{lead_id}/intelligence-history", response_model=LeadIntelligenceHistoryResponse)
def get_intelligence_history(
    lead_id: str, current_user: CurrentUser = Depends(get_current_user)
) -> LeadIntelligenceHistoryResponse:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    return LeadIntelligenceHistoryResponse(
        versions=[_to_intelligence_version_out(r) for r in db.list_lead_intelligence_versions(lead_id)]
    )


@router.post("/migrate", response_model=MigrateResponse)
def migrate_leads(body: MigrateRequest, admin: CurrentUser = Depends(require_admin)) -> MigrateResponse:
    """One-time import of the legacy local CSV leads, owned by the admin who
    runs the migration. Never invoked again after the local file is imported."""
    imported = 0
    created_at = now_iso()
    for entry in body.leads:
        company = entry.get("company")
        if not company:
            continue
        db.create_lead(
            id=new_id(),
            timestamp=entry.get("timestamp") or created_at,
            company=company,
            phone_number=entry.get("phone_number", ""),
            source_url=entry.get("source_url", ""),
            status=entry.get("status", "unverified"),
            notes=entry.get("notes", ""),
            owner_user_id=admin.id,
            created_at=created_at,
        )
        imported += 1
    return MigrateResponse(imported=imported)
