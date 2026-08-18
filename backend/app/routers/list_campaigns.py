"""List Email Campaigns router — member-accessible (each rep runs it for their
own lists and sends from their own connected inbox). Generation happens in a
background task; per-lead drafts live in email_drafts and are edited/sent through
the existing email-writer endpoints. See services/list_campaign_service.py."""

import asyncio
import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request

from app import db
from app.core.config import get_settings
from app.core.rate_limit import limiter
from app.dependencies import CurrentUser, get_current_user
from app.schemas_list_campaigns import (
    CampaignDraftOut,
    CampaignDraftsResponse,
    CreateListCampaignRequest,
    ListCampaignOut,
    ListCampaignsResponse,
    SendCampaignRequest,
)
from app.services.auth_service import new_id, now_iso
from app.services.email_oauth_service import OAuthError, send_email as send_email_via_oauth
from app.services.list_campaign_service import generate_campaign

router = APIRouter(prefix="/list-campaigns", tags=["list-campaigns"])


def _require_campaign_access(row: sqlite3.Row, current_user: CurrentUser) -> None:
    if row["owner_user_id"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You don't have access to this campaign.")


def _to_campaign_out(row: sqlite3.Row) -> ListCampaignOut:
    return ListCampaignOut(
        id=row["id"],
        list_id=row["list_id"],
        name=row["name"],
        status=row["status"],
        total_target=row["total_target"],
        generated=db.count_list_campaign_drafts(row["id"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.post("", response_model=ListCampaignOut)
@limiter.limit(get_settings().rate_limit)
async def create_campaign(
    request: Request, body: CreateListCampaignRequest, current_user: CurrentUser = Depends(get_current_user)
) -> ListCampaignOut:
    if not body.idea.strip():
        raise HTTPException(status_code=400, detail="Add an email idea before generating.")
    if not body.list_id and not body.lead_ids:
        raise HTTPException(status_code=400, detail="Pick a list or select some leads first.")

    lead_ids_json = ""
    if body.list_id:
        lead_list = db.get_lead_list(body.list_id)
        if lead_list is None:
            raise HTTPException(status_code=404, detail="List not found")
        if lead_list["owner_user_id"] != current_user.id and current_user.role != "admin":
            raise HTTPException(status_code=403, detail="You don't have access to this list.")
        lead_ids = [lead["id"] for lead in db.list_leads(body.list_id)]
        if not lead_ids:
            raise HTTPException(status_code=400, detail="This list has no leads.")
        default_name = lead_list["name"]
    else:
        # Ad-hoc campaign — a hand-picked set of leads, not tied to a saved
        # list. Leads are a shared pool visible to every user (see
        # CLAUDE.md), so no per-lead ownership check is needed here.
        lead_ids = body.lead_ids
        lead_ids_json = json.dumps(lead_ids)
        default_name = f"{len(lead_ids)} selected lead{'' if len(lead_ids) == 1 else 's'}"

    allowed, spent, limit = db.check_credit_limit(current_user.id, "email_writer")
    if not allowed:
        raise HTTPException(
            status_code=402,
            detail=f"Monthly AI Email Writer credit limit reached (spent £{spent:.2f} of £{limit:.2f}). "
            "Ask your administrator to raise it.",
        )

    campaign_id = new_id()
    name = body.name.strip() or default_name
    db.create_list_campaign(
        campaign_id, body.list_id, current_user.id, name, body.idea.strip(), body.offers.strip(),
        body.link_url.strip(), body.link_text.strip(), body.signature.strip(), len(lead_ids), now_iso(),
        lead_ids_json,
    )
    asyncio.create_task(
        generate_campaign(
            campaign_id, lead_ids, current_user.id, body.idea.strip(), body.offers.strip(),
            body.link_url.strip(), body.link_text.strip(), body.signature.strip(),
        )
    )
    return _to_campaign_out(db.get_list_campaign(campaign_id))


@router.get("", response_model=ListCampaignsResponse)
def list_campaigns(current_user: CurrentUser = Depends(get_current_user)) -> ListCampaignsResponse:
    return ListCampaignsResponse(campaigns=[_to_campaign_out(r) for r in db.list_list_campaigns(current_user.id)])


@router.get("/{campaign_id}", response_model=ListCampaignOut)
def get_campaign(campaign_id: str, current_user: CurrentUser = Depends(get_current_user)) -> ListCampaignOut:
    row = db.get_list_campaign(campaign_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    _require_campaign_access(row, current_user)
    return _to_campaign_out(row)


@router.get("/{campaign_id}/drafts", response_model=CampaignDraftsResponse)
def get_campaign_drafts(campaign_id: str, current_user: CurrentUser = Depends(get_current_user)) -> CampaignDraftsResponse:
    row = db.get_list_campaign(campaign_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    _require_campaign_access(row, current_user)
    drafts = [
        CampaignDraftOut(
            id=d["id"],
            lead_id=d["lead_id"],
            company=d["company"] or "",
            contact_name=d["contact_name"] or "",
            contact_status=d["contact_status"] or "New",
            contact_email=d["contact_email"] or "",
            subject=d["subject"] or "",
            body=d["body"] or "",
            status=d["status"],
            sent_via=d["sent_via"],
            sent_at=d["sent_at"],
        )
        for d in db.list_campaign_drafts(campaign_id)
    ]
    return CampaignDraftsResponse(drafts=drafts)


@router.post("/{campaign_id}/resume", response_model=ListCampaignOut)
@limiter.limit(get_settings().rate_limit)
async def resume_campaign(request: Request, campaign_id: str, current_user: CurrentUser = Depends(get_current_user)) -> ListCampaignOut:
    row = db.get_list_campaign(campaign_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    _require_campaign_access(row, current_user)

    missing = db.list_campaign_lead_ids_without_draft(campaign_id, row["list_id"], row["lead_ids_json"])
    if not missing:
        return _to_campaign_out(row)

    allowed, spent, limit = db.check_credit_limit(row["owner_user_id"], "email_writer")
    if not allowed:
        raise HTTPException(
            status_code=402,
            detail=f"Still over the AI Email Writer credit limit (spent £{spent:.2f} of £{limit:.2f}). "
            "Ask your administrator to raise it, then resume.",
        )

    db.update_list_campaign_status(campaign_id, "generating", now_iso())
    asyncio.create_task(
        generate_campaign(
            campaign_id, missing, row["owner_user_id"], row["idea"], row["offers"],
            row["link_url"], row["link_text"], row["signature"],
        )
    )
    return _to_campaign_out(db.get_list_campaign(campaign_id))


@router.post("/{campaign_id}/send-all")
@limiter.limit(get_settings().rate_limit)
async def send_all(
    request: Request, campaign_id: str, body: SendCampaignRequest, current_user: CurrentUser = Depends(get_current_user)
) -> dict:
    row = db.get_list_campaign(campaign_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    _require_campaign_access(row, current_user)

    account = db.get_email_oauth_account(current_user.id, body.provider)
    if account is None:
        raise HTTPException(status_code=400, detail=f"Connect a {body.provider} account in Settings first.")

    sent = 0
    failed = 0
    skipped = 0
    for draft in db.list_campaign_drafts(campaign_id):
        if draft["status"] == "sent":
            continue
        to = draft["contact_email"]
        if not to:
            skipped += 1
            continue
        try:
            await send_email_via_oauth(account, to, draft["subject"], draft["body"])
            db.mark_email_draft_sent(draft["id"], body.provider, now_iso())
            sent += 1
        except OAuthError:
            failed += 1
        await asyncio.sleep(1)

    db.record_audit(
        current_user.id, current_user.name, "send_all", "list_campaign", campaign_id,
        detail=f"sent={sent} failed={failed} skipped={skipped} via={body.provider}",
    )
    return {"sent": sent, "failed": failed, "skipped": skipped}
