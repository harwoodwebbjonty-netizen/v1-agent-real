import asyncio
import json
import logging
import sqlite3
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.services.auth_service import new_id, now_iso
from app.services.email_oauth_service import OAuthError, send_email as send_email_via_oauth
from app.services.mailchimp_service import (
    MailchimpError,
    MailchimpNotConfiguredError,
    export_win_back_campaign,
)
from app.services.sales_intelligence_service import generate_sales_intelligence
from app.services.template_variables import build_lead_context
from app.services.win_back_email_service import generate_win_back_email

logger = logging.getLogger("app.win_back")

router = APIRouter(prefix="/win-back", tags=["win-back"])


# --- Pydantic schemas ---

DEPTH_TO_MAX_USES: dict[str, int] = {"quick": 3, "standard": 5, "deep": 10}
CAMPAIGN_CONCURRENCY = 8


class CreateCampaignRequest(BaseModel):
    name: str
    lead_ids: List[str]
    depth: str = "standard"


class CsvLeadRow(BaseModel):
    company: str
    contact_name: str = ""
    email: str = ""
    phone: str = ""
    website: str = ""
    linkedin: str = ""
    notes: str = ""
    industry: str = ""


class CreateCampaignFromCsvRequest(BaseModel):
    name: str
    rows: List[CsvLeadRow]
    depth: str = "standard"


class SendEmailRequest(BaseModel):
    provider: str = "gmail"


class MailchimpExportRequest(BaseModel):
    provider: str = "gmail"


# --- Background generation ---

def _days_since(iso_ts: str) -> float:
    try:
        ts = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - ts).total_seconds() / 86400
    except Exception:
        return 999.0


async def _generate_campaign(campaign_id: str, lead_ids: list, user_id: str, depth: str = "standard") -> None:
    max_uses = DEPTH_TO_MAX_USES.get(depth, 5)
    semaphore = asyncio.Semaphore(CAMPAIGN_CONCURRENCY)
    completed = 0

    try:
        brand_voice_row = db.get_brand_voice(user_id)
        brand_voice = dict(brand_voice_row) if brand_voice_row else {}
        user_row = db.get_user_by_id(user_id)
        sender_name = user_row["name"] if user_row else ""

        async def _process_lead(lead_id: str) -> None:
            nonlocal completed
            async with semaphore:
                try:
                    lead = db.get_lead(lead_id)
                    if lead is None:
                        logger.warning("Win-back: lead %s not found, skipping", lead_id)
                        return

                    intel = db.get_latest_lead_intelligence(lead_id)
                    if not intel or _days_since(intel["created_at"]) > 30:
                        try:
                            result = await generate_sales_intelligence(
                                lead["company"], lead["website"] or "", max_uses=max_uses
                            )
                            db.add_lead_intelligence_version(
                                new_id(), lead_id,
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
                            intel = db.get_latest_lead_intelligence(lead_id)
                        except Exception:
                            logger.exception("Win-back: intelligence generation failed for %s", lead_id)

                    phones = db.list_phones(lead_id)
                    emails_list = db.list_emails(lead_id)
                    ctx = build_lead_context(lead, phones, emails_list, intel, sender_name, brand_voice)
                    if intel:
                        ctx["ch_data"] = _format_ch_data(lead)

                    try:
                        allowed, spent, limit = db.check_credit_limit(user_id, "win_back")
                        if not allowed:
                            logger.warning(
                                "Win-back: credit limit £%.2f reached (spent £%.2f) — skipping %s",
                                limit, spent, lead_id,
                            )
                        else:
                            email_result = await generate_win_back_email(ctx)
                            db.upsert_win_back_email(
                                campaign_id, lead_id, new_id(),
                                email_result["subject"], email_result["body"], now_iso(),
                            )
                            db.record_credit_spend(new_id(), user_id, "win_back", db.CREDIT_COST["win_back"], now_iso())
                    except Exception:
                        logger.exception("Win-back: email generation failed for %s", lead_id)

                except Exception:
                    logger.exception("Win-back: unexpected error processing lead %s", lead_id)
                finally:
                    completed += 1
                    is_last = completed == len(lead_ids)
                    db.update_win_back_campaign_progress(
                        campaign_id, completed, "ready" if is_last else "generating"
                    )

        await asyncio.gather(*[_process_lead(lid) for lid in lead_ids], return_exceptions=True)

    except Exception:
        logger.exception("Win-back: campaign generation task crashed for %s", campaign_id)
        db.update_win_back_campaign_progress(campaign_id, 0, "error")


def _format_ch_data(lead: sqlite3.Row) -> str:
    """Returns a readable string of CH data to enrich the email context."""
    raw = lead["ch_data"] if "ch_data" in lead.keys() else None
    if not raw:
        return ""
    try:
        cd = json.loads(raw)
        parts = []
        if cd.get("company_status"):
            parts.append(f"Status: {cd['company_status']}")
        if cd.get("incorporation_date"):
            parts.append(f"Incorporated: {cd['incorporation_date']}")
        if cd.get("directors"):
            parts.append(f"Directors: {', '.join(cd['directors'][:3])}")
        if cd.get("charges_total"):
            parts.append(f"Charges registered: {cd['charges_total']}")
        if cd.get("sic_codes"):
            parts.append(f"SIC codes: {', '.join(str(s) for s in cd['sic_codes'])}")
        return "; ".join(parts)
    except Exception:
        return ""


# --- Response helpers ---

def _campaign_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "status": row["status"],
        "total": row["total"],
        "generated": row["generated"],
        "created_at": row["created_at"],
    }


def _email_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "campaign_id": row["campaign_id"],
        "lead_id": row["lead_id"],
        "subject": row["subject"] or "",
        "body": row["body"] or "",
        "send_status": row["send_status"],
        "sent_at": row["sent_at"],
        "send_method": row["send_method"],
        "company": row["company"] if "company" in row.keys() else "",
        "contact_name": row["contact_name"] if "contact_name" in row.keys() else "",
        "contact_email": row["contact_email"] if "contact_email" in row.keys() else "",
        "created_at": row["created_at"],
    }


# --- Endpoints ---

@router.post("/campaigns")
async def create_campaign(
    body: CreateCampaignRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    if not body.lead_ids:
        raise HTTPException(status_code=400, detail="At least one lead is required.")
    campaign_id = new_id()
    db.create_win_back_campaign(
        id=campaign_id,
        name=body.name,
        created_by=current_user.id,
        total=len(body.lead_ids),
        created_at=now_iso(),
    )
    asyncio.create_task(_generate_campaign(campaign_id, body.lead_ids, current_user.id, body.depth))
    campaign = db.get_win_back_campaign(campaign_id)
    return _campaign_dict(campaign)


@router.get("/campaigns")
def list_campaigns(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    rows = db.get_win_back_campaigns(current_user.id)
    return {"campaigns": [_campaign_dict(r) for r in rows]}


@router.post("/campaigns/from-csv")
async def create_campaign_from_csv(
    body: CreateCampaignFromCsvRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    if not body.rows:
        raise HTTPException(status_code=400, detail="At least one row is required.")

    lead_ids: list[str] = []
    ts = now_iso()
    for row in body.rows:
        lead_id = db.create_lead(
            id=new_id(),
            timestamp=ts,
            company=row.company,
            phone_number=row.phone,
            source_url=row.website,
            status="New",
            notes=row.notes,
            owner_user_id=current_user.id,
            created_at=ts,
        )
        extra = {k: v for k, v in {
            "contact_name": row.contact_name,
            "website": row.website,
            "linkedin": row.linkedin,
            "industry": row.industry,
        }.items() if v}
        if extra:
            db.update_lead_fields(lead_id, extra, ts)
        if row.email:
            db.add_email_ignore_duplicate(new_id(), lead_id, row.email, "csv_import", ts)
        lead_ids.append(lead_id)

    campaign_id = new_id()
    db.create_win_back_campaign(
        id=campaign_id,
        name=body.name,
        created_by=current_user.id,
        total=len(lead_ids),
        created_at=ts,
    )
    asyncio.create_task(_generate_campaign(campaign_id, lead_ids, current_user.id, body.depth))
    campaign = db.get_win_back_campaign(campaign_id)
    return _campaign_dict(campaign)


@router.get("/campaigns/{campaign_id}")
def get_campaign(campaign_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    campaign = db.get_win_back_campaign(campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign["created_by"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")
    emails = db.get_win_back_emails(campaign_id)
    return {
        "campaign": _campaign_dict(campaign),
        "emails": [_email_dict(e) for e in emails],
    }


@router.post("/campaigns/{campaign_id}/send/{email_id}")
async def send_one_email(
    campaign_id: str,
    email_id: str,
    body: SendEmailRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    campaign = db.get_win_back_campaign(campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign["created_by"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")

    emails = db.get_win_back_emails(campaign_id)
    email_row = next((e for e in emails if e["id"] == email_id), None)
    if email_row is None:
        raise HTTPException(status_code=404, detail="Email not found")
    if email_row["send_status"] == "sent":
        raise HTTPException(status_code=400, detail="Already sent")

    to = email_row["contact_email"] if "contact_email" in email_row.keys() else None
    if not to:
        raise HTTPException(status_code=400, detail="This lead has no email address on file.")

    account = db.get_email_oauth_account(current_user.id, body.provider)
    if account is None:
        raise HTTPException(status_code=400, detail=f"Connect a {body.provider} account in Settings first.")

    try:
        await send_email_via_oauth(account, to, email_row["subject"], email_row["body"])
    except OAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    db.mark_win_back_email_sent(email_id, body.provider, now_iso())
    return {"status": "sent"}


@router.post("/campaigns/{campaign_id}/send-all")
async def send_all_emails(
    campaign_id: str,
    body: SendEmailRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    campaign = db.get_win_back_campaign(campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign["created_by"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")

    account = db.get_email_oauth_account(current_user.id, body.provider)
    if account is None:
        raise HTTPException(status_code=400, detail=f"Connect a {body.provider} account in Settings first.")

    emails = db.get_win_back_emails(campaign_id)
    sent = 0
    failed = 0
    for email_row in emails:
        if email_row["send_status"] == "sent":
            continue
        to = email_row["contact_email"] if "contact_email" in email_row.keys() else None
        if not to:
            continue
        try:
            await send_email_via_oauth(account, to, email_row["subject"], email_row["body"])
            db.mark_win_back_email_sent(email_row["id"], body.provider, now_iso())
            sent += 1
        except OAuthError:
            failed += 1
        await asyncio.sleep(1)

    return {"sent": sent, "failed": failed}


@router.post("/campaigns/{campaign_id}/export-mailchimp")
async def export_mailchimp(
    campaign_id: str,
    body: MailchimpExportRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    campaign = db.get_win_back_campaign(campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign["created_by"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")

    account = db.get_email_oauth_account(current_user.id, body.provider)
    from_name = current_user.name
    from_email = account["email_address"] if account else ""

    emails = db.get_win_back_emails(campaign_id)
    email_dicts = [_email_dict(e) for e in emails]

    try:
        mailchimp_url = await export_win_back_campaign(
            campaign_name=campaign["name"],
            from_name=from_name,
            from_email=from_email,
            emails=email_dicts,
        )
    except MailchimpNotConfiguredError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except MailchimpError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return {"mailchimp_url": mailchimp_url}
