import asyncio
import json
import logging
import sqlite3
from typing import Optional

logger = logging.getLogger("app.leads")

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

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
    ImportLeadsRequest,
    ImportLeadsResponse,
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
from app.services.companies_house_service import (
    _SIC_DESCRIPTIONS,
    build_ch_data_json,
    build_not_found_ch_data_json,
    build_partial_ch_data_json,
    extract_sic_industry,
    get_company_charges,
    get_company_officers,
    get_company_profile,
    search_company_by_name,
)
from app.services.email_scraper_service import scrape_emails
from app.services import lead_scoring_service
from app.services.linkedin_activity_service import format_posts_for_prompt, get_or_fetch_linkedin_posts
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
        company_number=row["company_number"],
        ch_data=row["ch_data"],
        called_at=row["called_at"],
        follow_up_at=row["follow_up_at"] if "follow_up_at" in row.keys() else None,
        priority_score=row["priority_score"] if "priority_score" in row.keys() else 0,
        priority_breakdown=row["priority_breakdown"] if "priority_breakdown" in row.keys() else None,
        list_name=row["list_name"] if "list_name" in row.keys() else None,
        phones=[PhoneOut(id=p["id"], phone_number=p["phone_number"], source=p["source"]) for p in db.list_phones(row["id"])],
        emails=[
            EmailOut(
                id=e["id"], email=e["email"], source=e["source"],
                verify_status=e["verify_status"] if "verify_status" in e.keys() else "unchecked",
                person_match=e["person_match"] if "person_match" in e.keys() else "unknown",
                verify_detail=e["verify_detail"] if "verify_detail" in e.keys() else "",
            )
            for e in db.list_emails(row["id"])
        ],
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
    return LeadListResponse(leads=[_to_lead_out(r, names, activity) for r in db.list_all_leads_for_user(current_user.id, current_user.role == "admin")])


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

    # Credit limit check
    allowed, spent, limit = db.check_credit_limit(current_user.id, "phone_lookup")
    if not allowed:
        raise HTTPException(
            status_code=402,
            detail=f"Monthly credit limit reached for Phone Lookup (spent £{spent:.2f} of £{limit:.2f}). Update your limit in Settings → Credit Limits.",
        )

    # Calls the existing, unchanged AI pipeline function — this router is the
    # only place that persists its result, the service itself stays pure.
    result = await lookup_company_phone(body.company)

    created_at = now_iso()
    db.record_credit_spend(new_id(), current_user.id, "phone_lookup", db.CREDIT_COST["phone_lookup"], created_at)
    actual_lead_id = db.create_lead(
        id=new_id(),
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

    if result.status != "not_found" and result.phone_number:
        db.add_phone_ignore_duplicate(
            id=new_id(), lead_id=actual_lead_id, phone_number=result.phone_number, source="scraped", created_at=created_at
        )

    row = db.get_lead(actual_lead_id)
    return _to_lead_out(row, _user_name_map(), activity)


@router.get("/ch-enrich-status")
def ch_enrich_status_endpoint(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    return _enrich_status


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


# --- Follow-up scheduling ---

class SetFollowUpRequest(BaseModel):
    follow_up_at: Optional[str] = None  # ISO datetime string, or null to clear


@router.patch("/{lead_id}/follow-up", response_model=LeadOut)
def set_follow_up(
    lead_id: str, body: SetFollowUpRequest,
    current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    db.set_lead_follow_up(lead_id, body.follow_up_at)
    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


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

    # Verify what the scraper found straight away — free DNS + name checks
    await _verify_lead_emails(lead_id)
    return _to_lead_out(db.get_lead(lead_id), _user_name_map(), activity)


async def _verify_lead_emails(lead_id: str) -> None:
    from app.services.email_verify_service import directors_from_ch_data, verify_email

    lead = db.get_lead(lead_id)
    if lead is None:
        return
    contact_name = lead["contact_name"] if "contact_name" in lead.keys() else ""
    directors = directors_from_ch_data(lead["ch_data"] if "ch_data" in lead.keys() else None)
    emails = db.list_emails(lead_id)

    async def _one(row) -> None:
        try:
            r = await verify_email(row["email"], contact_name or "", directors)
            db.set_email_verification(row["id"], r["status"], r["person_match"], r["detail"], now_iso())
        except Exception:
            logger.exception("Email verification failed for %s", row["email"])

    await asyncio.gather(*[_one(e) for e in emails])


@router.post("/{lead_id}/verify-emails", response_model=LeadOut)
async def verify_emails_route(
    lead_id: str, current_user: CurrentUser = Depends(get_current_user),
    activity: ActivityContext = Depends(get_activity_context),
) -> LeadOut:
    """Free checks on every email of this lead: does the domain accept mail
    (DNS), and does the address match the contact/director or is it a
    generic inbox. No external paid service involved."""
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    await _verify_lead_emails(lead_id)
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

    allowed, spent, limit = db.check_credit_limit(current_user.id, "sales_intel")
    if not allowed:
        raise HTTPException(
            status_code=402,
            detail=f"Monthly credit limit reached for Sales Intelligence (spent £{spent:.2f} of £{limit:.2f}). Update your limit in Settings → Credit Limits.",
        )

    try:
        db.acquire_intelligence_lock(lead_id, now_iso())
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Intelligence generation already in progress")

    try:
        linkedin_posts = await get_or_fetch_linkedin_posts(lead, current_user.id)
        result = await generate_sales_intelligence(
            lead["company"], lead["website"] or "",
            linkedin_context=format_posts_for_prompt(linkedin_posts),
        )
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
        db.record_credit_spend(new_id(), current_user.id, "sales_intel", db.CREDIT_COST["sales_intel"], now_iso())
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


@router.get("/{lead_id}/linkedin-posts")
def get_linkedin_posts(lead_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    """Read-only — returns whatever's cached. Never triggers a fetch itself;
    fetching only happens automatically inside sales-intelligence generation
    (win-back, AI Prospecting, and this router's generate-intelligence)."""
    lead = db.get_lead(lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    _require_lead_access(lead, current_user)
    row = db.get_latest_lead_linkedin_posts(lead_id)
    if row is None:
        return {"linkedin_url": lead["linkedin"] or "", "posts": [], "fetched_at": None}
    try:
        posts = json.loads(row["posts_json"])
    except (TypeError, ValueError):
        posts = []
    return {"linkedin_url": row["linkedin_url"], "posts": posts, "fetched_at": row["created_at"]}


@router.post("/import-csv", response_model=ImportLeadsResponse)
def import_leads_csv(body: ImportLeadsRequest, current_user: CurrentUser = Depends(get_current_user)) -> ImportLeadsResponse:
    imported = 0
    created_at = now_iso()
    for entry in body.leads:
        company = entry.get("company")
        if not company:
            continue
        lead_id = new_id()
        actual_lead_id = db.create_lead(
            id=lead_id,
            timestamp=entry.get("timestamp") or created_at,
            company=company,
            phone_number=entry.get("phone_number", ""),
            source_url=entry.get("source_url", ""),
            status=entry.get("status", "unverified"),
            notes=entry.get("notes", ""),
            owner_user_id=current_user.id,
            created_at=created_at,
            company_number=entry.get("company_number") or None,
        )
        imported_details = {
            key: value.strip()
            for key, value in {
                "website": entry.get("website") or entry.get("source_url") or "",
                "linkedin": entry.get("linkedin") or "",
            }.items()
            if isinstance(value, str) and value.strip()
        }
        db.update_lead_fields(actual_lead_id, imported_details, created_at)
        phone = (entry.get("phone_number") or "").strip()
        if phone and phone != "not_found":
            db.add_phone_ignore_duplicate(
                id=new_id(), lead_id=actual_lead_id, phone_number=phone, source="imported", created_at=created_at
            )
        imported += 1
    return ImportLeadsResponse(imported=imported)


import asyncio as _asyncio

_enrich_task: "_asyncio.Task[None] | None" = None
_enrich_status: dict = {"running": False, "enriched": 0, "remaining": 0, "failed": 0}


def _needs_enrichment(lead: sqlite3.Row) -> bool:
    """True if this lead still needs a CH enrichment attempt."""
    if not lead["ch_data"]:
        return True
    try:
        stored = json.loads(lead["ch_data"])
        if stored.get("not_found") or stored.get("partial"):
            return False  # as good as we can get — don't retry
        if "charges" not in stored:
            return True   # old schema — upgrade
        # Bad company number: profile 404'd so stored ch_data has empty company_number
        # even though the leads table has a number. Re-enrich via name search.
        if lead["company_number"] and not stored.get("company_number"):
            return True
        if not lead["industry"]:
            return bool(stored.get("sic_codes"))
        return False
    except Exception:
        return True


async def _run_enrichment_batch(api_key: str, user_id: str, is_admin: bool, limit: int) -> tuple[int, int]:
    """Shared enrichment logic used by both the manual and auto endpoints."""
    leads = db.list_all_leads_for_user(user_id, is_admin)
    needs_work = [l for l in leads if _needs_enrichment(l)]
    batch = needs_work[:limit]
    remaining_after = max(0, len(needs_work) - limit)

    enriched = 0
    for lead in batch:
        try:
            company_number = lead["company_number"] or ""
            if not company_number:
                try:
                    stored = json.loads(lead["ch_data"] or "{}")
                    company_number = stored.get("company_number", "")
                except Exception:
                    pass
            if not company_number:
                result = await search_company_by_name(api_key, lead["company"])
                if not result:
                    db.update_lead_fields(lead["id"], {"ch_data": build_not_found_ch_data_json()}, now_iso())
                    logger.warning("CH enrich: no CH record for '%s' — marked not_found", lead["company"])
                    continue
                company_number = result.get("company_number", "")
                if not company_number:
                    db.update_lead_fields(lead["id"], {"ch_data": build_partial_ch_data_json(result)}, now_iso())
                    logger.warning("CH enrich: no company_number in result for '%s' — stored partial", lead["company"])
                    continue
            profile = await get_company_profile(api_key, company_number)
            if profile is None:
                # Stored company number is invalid (404) — try resolving by name
                logger.warning("CH enrich: profile 404 for number '%s' (%s) — trying name search", company_number, lead["company"])
                name_result = await search_company_by_name(api_key, lead["company"])
                if name_result:
                    company_number = name_result.get("company_number", "")
                if not company_number:
                    db.update_lead_fields(lead["id"], {"ch_data": build_not_found_ch_data_json()}, now_iso())
                    logger.warning("CH enrich: name search also failed for '%s' — marked not_found", lead["company"])
                    continue
                profile = await get_company_profile(api_key, company_number) or {}
            charges, charges_total = await get_company_charges(api_key, company_number)
            officers = await get_company_officers(api_key, company_number)
            ch_data = build_ch_data_json(profile, charges, officers, charges_total)
            industry = extract_sic_industry(profile) or ("Unclassified" if not profile.get("sic_codes") else "")
            fields: dict = {"company_number": company_number, "ch_data": ch_data}
            if industry:
                fields["industry"] = industry
            db.update_lead_fields(lead["id"], fields, now_iso())
            # Refresh the deterministic priority score now that CH data changed.
            try:
                lead_scoring_service.score_lead(lead["id"])
            except Exception:
                logger.exception("Priority scoring failed for enriched lead %s", lead["id"])
            enriched += 1
        except Exception as exc:
            logger.warning("CH enrich failed for '%s': %s", lead["company"], exc)
    return enriched, remaining_after


@router.post("/ch-enrich-all")
async def ch_enrich_all(
    limit: int = 100,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Manual batch: enriches up to `limit` leads (default 100). Skips already-done leads.
    Writes a sentinel for any company not found on CH so it stops being retried."""
    settings = get_settings()
    if not settings.companies_house_api_key:
        raise HTTPException(status_code=400, detail="Companies House API key not configured")
    enriched, remaining = await _run_enrichment_batch(
        settings.companies_house_api_key, current_user.id, current_user.role == "admin", limit
    )
    return {"enriched": enriched, "remaining": remaining}


async def _enrich_all_background(api_key: str, user_id: str, is_admin: bool) -> None:
    global _enrich_status, _enrich_task
    _enrich_status.update({"running": True, "enriched": 0, "failed": 0, "remaining": 0})
    try:
        while _enrich_status["running"]:
            enriched_batch, remaining = await _run_enrichment_batch(api_key, user_id, is_admin, 100)
            _enrich_status["enriched"] += enriched_batch
            _enrich_status["remaining"] = remaining
            if remaining == 0:
                break
            await _asyncio.sleep(30)  # ~400 CH API calls per batch; limit is 600/5min
    finally:
        _enrich_status["running"] = False
        _enrich_task = None


@router.post("/ch-enrich-auto")
async def ch_enrich_auto(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    """Starts a background job that enriches all leads in 100-lead batches until done.
    Safe to call while already running — returns current status instead of starting a duplicate."""
    global _enrich_task
    settings = get_settings()
    if not settings.companies_house_api_key:
        raise HTTPException(status_code=400, detail="Companies House API key not configured")
    if _enrich_task and not _enrich_task.done():
        return _enrich_status
    _enrich_task = _asyncio.create_task(
        _enrich_all_background(settings.companies_house_api_key, current_user.id, current_user.role == "admin")
    )
    return _enrich_status


@router.post("/ch-enrich-stop")
def ch_enrich_stop(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    _enrich_status["running"] = False
    return _enrich_status


@router.post("/backfill-industry")
def backfill_industry(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    """One-time fix: set industry='Unclassified' for fully-enriched leads that have no SIC codes on CH."""
    rows = db.list_all_leads_for_user(current_user.id, current_user.role == "admin")
    updated = 0
    now = now_iso()
    for row in rows:
        if row["industry"]:
            continue
        try:
            stored = json.loads(row["ch_data"] or "{}")
            if "charges" in stored and not stored.get("not_found") and not stored.get("partial") and not stored.get("sic_codes"):
                db.update_lead_fields(row["id"], {"industry": "Unclassified"}, now)
                updated += 1
        except Exception:
            pass
    return {"updated": updated}


@router.post("/dedup")
def dedup_leads(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    """Merges duplicate leads in the shared pool (list_id IS NULL).
    Winner = oldest created_at. All phones, emails, notes, call logs, etc. are
    absorbed into the winner; the duplicate is deleted. Also normalises any
    raw SIC codes stored in industry to human-readable names."""
    leads = db.list_leads()  # shared pool only
    now = now_iso()
    merged = 0

    # Fix existing raw SIC codes → readable names
    for lead in leads:
        industry = (lead["industry"] or "").strip()
        if industry and industry.isdigit():
            name = _SIC_DESCRIPTIONS.get(industry[:2], "")
            if name:
                db.update_lead_fields(lead["id"], {"industry": name}, now)

    # Re-fetch after fix so duplicate checks use updated data
    leads = db.list_leads()

    # Group by company_number first
    by_cn: dict[str, list] = {}
    no_cn = []
    for lead in leads:
        cn = (lead["company_number"] or "").strip()
        if cn:
            by_cn.setdefault(cn, []).append(lead)
        else:
            no_cn.append(lead)

    for cn, group in by_cn.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda r: r["created_at"])
        winner = group[0]
        for loser in group[1:]:
            db.merge_lead_into(winner["id"], loser["id"], now)
            merged += 1

    # Group remainder by normalised name
    by_name: dict[str, list] = {}
    for lead in no_cn:
        # Skip leads that were already merged into a company_number winner above
        if db.get_lead(lead["id"]) is None:
            continue
        key = lead["company"].strip().lower()
        by_name.setdefault(key, []).append(lead)

    for name, group in by_name.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda r: r["created_at"])
        winner = group[0]
        for loser in group[1:]:
            if db.get_lead(loser["id"]) is None:
                continue
            db.merge_lead_into(winner["id"], loser["id"], now)
            merged += 1

    return {"merged": merged}


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
