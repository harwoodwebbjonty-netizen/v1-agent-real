import asyncio
import logging

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.responses import JSONResponse

from app import db
from app.core.config import get_settings
from app.core.rate_limit import limiter
from app.dependencies import CurrentUser, get_current_user
from app.routers import (
    activity,
    ai_prospecting,
    audit,
    auth,
    brand_voice,
    calendar,
    call_logs,
    ch_feed,
    credit_settings,
    email_oauth,
    email_templates,
    email_writer,
    lead_lists,
    leads,
    list_campaigns,
    roles,
    sequences,
    users,
    win_back,
)
from app.schemas import LookupRequest, LookupResult
from app.schemas_chat import LeadChatRequest, LeadChatResponse
from app.schemas_enrichment import EnrichLeadRequest, EnrichLeadResult
from app.services import usage_log
from app.services.activity_refresh_service import process_due_refreshes
from app.services.anthropic_service import lookup_company_phone
from app.services.ch_stream_service import run_filing_stream
from app.services.chat_service import chat_about_lead
from app.services.enrichment_service import enrich_lead
from app.services.sequences_service import process_due_enrollments

logger = logging.getLogger("app.main")
SEQUENCE_POLL_INTERVAL_SECONDS = 15 * 60
ACTIVITY_REFRESH_POLL_SECONDS = 30 * 60

app = FastAPI(title="Company Phone Lookup Backend")
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)

# CORS is defence-in-depth only — the desktop app calls via native reqwest, not a
# browser. Default (empty setting) allows no cross-origin browser access.
_cors_origins = [o.strip() for o in get_settings().cors_allow_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(leads.router)
app.include_router(lead_lists.router)
app.include_router(calendar.router)
app.include_router(call_logs.router)
app.include_router(brand_voice.router)
app.include_router(email_templates.router)
app.include_router(email_writer.router)
app.include_router(email_oauth.router)
app.include_router(sequences.router)
app.include_router(list_campaigns.router)
app.include_router(ai_prospecting.router)
app.include_router(activity.router)
app.include_router(ch_feed.router)
app.include_router(win_back.router)
app.include_router(credit_settings.router)
app.include_router(audit.router)
app.include_router(roles.router)


async def _sequence_scheduler_loop() -> None:
    """Single in-process loop — see services/sequences_service.py's module
    docstring for why this is correct for the current single-worker
    deployment and what would need to change for multiple workers."""
    while True:
        try:
            processed = await process_due_enrollments()
            if processed:
                logger.info("Sequence scheduler processed %d enrollment(s)", processed)
        except Exception:  # noqa: BLE001 — the loop must never die from one bad cycle
            logger.exception("Sequence scheduler cycle failed")
        await asyncio.sleep(SEQUENCE_POLL_INTERVAL_SECONDS)


async def _activity_refresh_loop() -> None:
    """Tiered background refresh for Companies House company snapshots.
    A-tier leads (hot/engaged) refresh every 6h; B-tier every 2d; C-tier every 7d.
    The scheduler only runs when COMPANIES_HOUSE_API_KEY is configured."""
    while True:
        try:
            detected = await process_due_refreshes()
            if detected:
                logger.info("Activity refresh detected %d new event(s)", detected)
        except Exception:  # noqa: BLE001
            logger.exception("Activity refresh cycle failed")
        await asyncio.sleep(ACTIVITY_REFRESH_POLL_SECONDS)


@app.on_event("startup")
def on_startup() -> None:
    from app.services.auth_service import now_iso

    db.init_db()
    # One-time backfill — gated by a flag so it doesn't full-scan `leads` on every
    # boot (audit M7). New/enriched leads set industry at creation, so once done
    # it never needs to run again.
    if db.get_app_flag("industry_backfilled") != "1":
        _backfill_industry_unclassified()
        db.set_app_flag("industry_backfilled", "1", now_iso())
    asyncio.create_task(_sequence_scheduler_loop())
    asyncio.create_task(_activity_refresh_loop())
    settings = get_settings()
    stream_key = settings.companies_house_stream_key or settings.companies_house_api_key
    if stream_key:
        asyncio.create_task(run_filing_stream(stream_key, settings.companies_house_api_key))


def _backfill_industry_unclassified() -> None:
    """One-time migration: set industry='Unclassified' for fully-enriched leads with no SIC codes."""
    import json
    from app.services.auth_service import now_iso
    now = now_iso()
    updated = 0
    with db.get_connection() as conn:
        rows = conn.execute(
            "SELECT id, ch_data FROM leads WHERE (industry IS NULL OR industry = '') AND ch_data IS NOT NULL"
        ).fetchall()
        for row in rows:
            try:
                cd = json.loads(row[1])
                if "charges" in cd and not cd.get("not_found") and not cd.get("partial") and not cd.get("sic_codes"):
                    conn.execute("UPDATE leads SET industry = ? WHERE id = ?", ("Unclassified", row[0]))
                    updated += 1
            except Exception:
                pass
    if updated:
        logging.getLogger("app").info("Backfilled industry=Unclassified for %d leads", updated)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded. Try again shortly."})


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Never leak internals to clients. HTTPException (with its intended detail)
    is handled by FastAPI before reaching here; this catches everything else,
    logs the full trace server-side, and returns a generic message."""
    if isinstance(exc, HTTPException):
        raise exc
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def _require_budget(user_id: str, feature: str, label: str) -> None:
    from fastapi import HTTPException

    allowed, spent, limit = db.check_credit_limit(user_id, feature)
    if not allowed:
        raise HTTPException(
            status_code=402,
            detail=f"Monthly credit limit reached for {label} (spent £{spent:.2f} of £{limit:.2f}). "
            "Ask your administrator to raise it.",
        )


def _record_spend(user_id: str, feature: str) -> None:
    from app.services.auth_service import new_id, now_iso

    db.record_credit_spend(new_id(), user_id, feature, db.CREDIT_COST[feature], now_iso())


@app.post("/lookup-company-phone", response_model=LookupResult)
@limiter.limit(get_settings().rate_limit)
async def lookup_company_phone_route(
    request: Request,
    body: LookupRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> LookupResult:
    _require_budget(current_user.id, "phone_lookup", "Phone Lookup")
    result = await lookup_company_phone(body.company)
    _record_spend(current_user.id, "phone_lookup")
    usage_log.record_usage(
        user_id=current_user.id,
        company=body.company,
        status=result.status,
        success=result.status != "not_found",
    )
    return result


@app.post("/enrich-lead", response_model=EnrichLeadResult)
@limiter.limit(get_settings().rate_limit)
async def enrich_lead_route(
    request: Request,
    body: EnrichLeadRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> EnrichLeadResult:
    _require_budget(current_user.id, "enrichment", "Enrichment")
    result = await enrich_lead(body.company, body.notes, body.industry)
    _record_spend(current_user.id, "enrichment")
    return result


@app.post("/lead-chat", response_model=LeadChatResponse)
@limiter.limit(get_settings().rate_limit)
async def lead_chat_route(
    request: Request,
    body: LeadChatRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> LeadChatResponse:
    _require_budget(current_user.id, "lead_chat", "Lead Chat")
    reply = await chat_about_lead(body.context, body.message, body.history)
    _record_spend(current_user.id, "lead_chat")
    return LeadChatResponse(reply=reply)
