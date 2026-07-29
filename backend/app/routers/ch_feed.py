"""CH Charge Feed router — serves live charge filings from the stream consumer."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.core.config import get_settings
from app.dependencies import CurrentUser, get_current_user
from app.services.auth_service import new_id, now_iso

router = APIRouter(prefix="/ch-feed", tags=["ch-feed"])


@router.get("/status")
async def ch_feed_status(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    settings = get_settings()
    timepoint = db.get_stream_state("ch_filing_timepoint")
    return {
        "configured": bool(settings.companies_house_api_key),
        "timepoint": timepoint,
    }


@router.get("/charges")
async def list_charges(
    company_name: Optional[str] = Query(None),
    filing_types: Optional[str] = Query(None, description="Comma-separated: MR01,MR02,MR03,MR04,MR05"),
    since: Optional[str] = Query(None, description="ISO timestamp"),
    not_added: bool = Query(False, description="Only show entries not yet added as leads"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    types_list = [t.strip() for t in filing_types.split(",") if t.strip()] if filing_types else None
    charges = db.list_ch_charges(
        company_name=company_name,
        filing_types=types_list,
        since=since,
        not_added=not_added,
        limit=limit,
        offset=offset,
    )
    return {"charges": [dict(c) for c in charges]}


@router.post("/charges/{charge_id}/add-lead")
async def add_charge_as_lead(
    charge_id: str,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    charge = db.get_ch_charge(charge_id)
    if not charge:
        raise HTTPException(status_code=404, detail="Charge not found")
    charge = dict(charge)

    if charge.get("lead_id"):
        return {"lead_id": charge["lead_id"], "created": False}

    # Check if we already have this company in leads
    company_number = charge.get("company_number") or ""
    existing_lead_id: Optional[str] = None
    if company_number:
        with db.get_connection() as conn:
            row = conn.execute(
                "SELECT id FROM leads WHERE company_number = ? LIMIT 1",
                (company_number,),
            ).fetchone()
            if row:
                existing_lead_id = row[0]

    if existing_lead_id:
        db.mark_ch_charge_added(charge_id, existing_lead_id)
        return {"lead_id": existing_lead_id, "created": False}

    # Create a minimal lead record from the charge data. Use the canonical
    # db.create_lead() helper rather than a hand-rolled INSERT: it fills every
    # NOT NULL column (timestamp/phone_number/source_url/notes/…) and dedupes by
    # company. The old raw INSERT wrote a non-existent `source` column and
    # omitted required columns, so this endpoint 500'd on every click.
    from app.services.auth_service import now_iso as _now_iso

    company_name = charge.get("company_name") or company_number or "Unknown"
    now = _now_iso()
    new_lead_id = new_id()
    lead_id = db.create_lead(
        id=new_lead_id,
        timestamp=now,
        company=company_name,
        phone_number="",
        source_url="",
        status="unverified",
        notes="Added from Companies House charge feed",
        owner_user_id=current_user.id,
        created_at=now,
        company_number=company_number or None,
    )

    db.mark_ch_charge_added(charge_id, lead_id)
    return {"lead_id": lead_id, "created": lead_id == new_lead_id}
