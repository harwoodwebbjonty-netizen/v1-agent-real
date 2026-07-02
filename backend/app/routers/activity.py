"""Activity Feed router — serves DataGardener-powered company event streams."""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.core.config import get_settings
from app.dependencies import CurrentUser, get_current_user
from app.services.activity_refresh_service import refresh_company

logger = logging.getLogger("app.routers.activity")

router = APIRouter(prefix="/activity", tags=["activity"])


@router.get("/status")
async def activity_status(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    settings = get_settings()
    return {"configured": bool(settings.datagardener_api_key)}


@router.get("/lead/{lead_id}")
async def list_lead_activity(
    lead_id: str,
    limit: int = Query(50, ge=1, le=200),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    lead = db.get_lead(lead_id)
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    events = db.list_lead_activity(lead_id, limit=limit)
    return {"events": [dict(e) for e in events]}


@router.get("/lead/{lead_id}/summary")
async def get_lead_activity_summary(
    lead_id: str,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    lead = db.get_lead(lead_id)
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    summary = db.get_lead_activity_summary(lead_id)
    return summary


@router.post("/lead/{lead_id}/refresh")
async def trigger_lead_refresh(
    lead_id: str,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    lead = db.get_lead(lead_id)
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")
    if not dict(lead).get("company_number"):
        raise HTTPException(status_code=422, detail="Lead has no Companies House number — cannot refresh from DataGardener")
    settings = get_settings()
    if not settings.datagardener_api_key:
        raise HTTPException(status_code=503, detail="DataGardener API key not configured")

    # Fire-and-forget in background — return immediately
    asyncio.create_task(_refresh_in_background(lead_id, settings.datagardener_api_key))
    return {"status": "refreshing"}


async def _refresh_in_background(lead_id: str, api_key: str) -> None:
    try:
        await refresh_company(lead_id, api_key)
    except Exception:
        logger.exception("Background refresh failed for lead %s", lead_id)


@router.get("/batch-summary")
async def batch_activity_summaries(
    lead_ids: str = Query(..., description="Comma-separated lead IDs"),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    ids = [lid.strip() for lid in lead_ids.split(",") if lid.strip()]
    if not ids:
        return {"summaries": {}}
    if len(ids) > 200:
        ids = ids[:200]
    summaries = db.get_batch_activity_summaries(ids)
    return {"summaries": summaries}


@router.get("/feed")
async def global_activity_feed(
    event_types: Optional[str] = Query(None, description="Comma-separated event types"),
    since: Optional[str] = Query(None, description="ISO timestamp — only events detected after this"),
    company_name: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    types_list = [t.strip() for t in event_types.split(",") if t.strip()] if event_types else None
    events = db.list_global_activity(
        event_types=types_list,
        since=since,
        company_name=company_name,
        limit=limit,
    )
    return {"events": [dict(e) for e in events]}
