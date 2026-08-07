import asyncio
import json
import logging
import re
import sqlite3
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import db
from app.core.config import get_settings
from app.core.import_safety import enforce_import_row_cap, sanitize_cell
from app.dependencies import CurrentUser, get_current_user, require_permission
from app.services.auth_service import days_since, new_id, now_iso
from app.services.companies_house_service import (
    CHRateLimitError,
    build_ch_data_json,
    get_company_charges,
    get_company_officers,
    get_company_profile,
    search_company_by_name,
)
from app.services.email_format import build_win_back_footer_html, build_win_back_footer_text
from app.services.email_oauth_service import OAuthError, send_email as send_email_via_oauth
from app.services.linkedin_activity_service import fetch_linkedin_posts_preview, format_posts_for_prompt, get_or_fetch_linkedin_posts
from app.services.mailchimp_service import (
    MailchimpError,
    MailchimpNotConfiguredError,
    export_win_back_campaign,
)
from app.services.sales_intelligence_service import IntelligenceExtractionError, generate_sales_intelligence
from app.services.template_variables import build_lead_context
from app.services.website_content_service import fetch_website_text
from app.services.win_back_email_service import apply_campaign_link, append_signature, build_signature, ensure_sender_subject, generate_win_back_email

logger = logging.getLogger("app.win_back")

# Win-back campaigns are admin-only: they mass-generate and mass-send emails
# on the org's API keys and OAuth accounts — not something the sales team
# needs for day-to-day calling.
router = APIRouter(prefix="/win-back", tags=["win-back"], dependencies=[Depends(require_permission("run_win_back"))])


# --- Pydantic schemas ---

DEPTH_TO_MAX_USES: dict[str, int] = {"quick": 3, "standard": 5, "deep": 10}
CAMPAIGN_CONCURRENCY = 8

# Win-back reads fewer LinkedIn posts than the calling tools' default (10):
# the email only needs a handful of recent-activity signals, and Apify bills
# per post, so a tighter cap is a direct per-lead cost saving. Threaded into
# the shared fetchers as an override, leaving leads.py / prospecting at 10.
WIN_BACK_MAX_LINKEDIN_POSTS = 5


class CreateCampaignRequest(BaseModel):
    name: str
    lead_ids: List[str]
    depth: str = "standard"
    email_instruction: str = ""
    offer_context: str = ""
    additional_context: str = ""
    campaign_links: str = ""
    campaign_link_text: str = ""
    signature: str = ""


class CsvLeadRow(BaseModel):
    company: str
    contact_name: str = ""
    email: str = ""
    phone: str = ""
    website: str = ""
    linkedin: str = ""
    notes: str = ""
    industry: str = ""
    deal_owner: str = ""  # the broker who originally arranged this deal (CSV "Deal Owner")
    stage: str = ""  # CRM deal stage — drives the relationship framing (Closed Won = funded)
    # Recipient-filter fields — persisted with the campaign's source rows so a
    # re-run ("Run again") can re-filter by deal age / amount. Client-side only
    # otherwise; generation does not use them directly.
    closing_date: str = ""
    amount: str = ""
    # If both are set, this row was already previewed under the exact same
    # generation settings — reuse it as-is in create_campaign_from_csv
    # instead of paying for research + email generation again for the same
    # company. The frontend only sends these when its cached preview's
    # settings signature still matches what's about to be generated.
    preview_subject: str = ""
    preview_body: str = ""


class CreateCampaignFromCsvRequest(BaseModel):
    name: str
    rows: List[CsvLeadRow]
    # Full uploaded CSV (all parsed rows, pre-filter) — stored on the campaign so
    # it can be re-run from the same source list. Falls back to `rows` if omitted.
    source_rows: List[CsvLeadRow] = []
    depth: str = "standard"
    email_instruction: str = ""
    offer_context: str = ""
    additional_context: str = ""
    campaign_links: str = ""
    campaign_link_text: str = ""
    signature: str = ""


class PreviewCampaignRequest(BaseModel):
    row: CsvLeadRow
    email_instruction: str = ""
    offer_context: str = ""
    additional_context: str = ""
    campaign_links: str = ""
    campaign_link_text: str = ""
    signature: str = ""
    depth: str = "standard"


class SendEmailRequest(BaseModel):
    provider: str = "gmail"


class MailchimpExportRequest(BaseModel):
    provider: str = "gmail"


# --- Background generation ---

async def _generate_campaign(
    campaign_id: str, lead_ids: list, user_id: str, depth: str = "standard", already_done: int = 0,
    email_instruction: str = "", offer_context: str = "", additional_context: str = "", campaign_links: str = "", campaign_link_text: str = "", signature: str = "",
    owner_by_lead: Optional[dict] = None,
    stage_by_lead: Optional[dict] = None,
) -> None:
    """already_done offsets the progress counter when resuming a campaign that
    stopped partway (credit ceiling, crash) — only the missing leads are in
    lead_ids, but the campaign's generated/total counts cover the whole run."""
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

                    # One credit gate for the whole per-email pipeline. The flat
                    # win_back charge (£0.20) covers research + LinkedIn + the
                    # email write, so we check it once here and, past this point,
                    # never record sales_intel or linkedin_scrape separately.
                    allowed, spent, limit = db.check_credit_limit(user_id, "win_back")
                    if not allowed:
                        logger.warning(
                            "Win-back: credit limit £%.2f reached (spent £%.2f) — skipping %s",
                            limit, spent, lead_id,
                        )
                        return

                    # Companies House data is fetched for EVERY lead (free,
                    # government-verified, works with no website/LinkedIn) so
                    # the email can always be personalised — falling back to CH
                    # facts and industry when there is no other signal. Prefer
                    # data already stored on the lead to avoid a redundant call.
                    ch_context = _format_ch_data(lead) or await _fetch_ch_data_for_company(lead["company"])

                    intel = db.get_latest_lead_intelligence(lead_id)
                    if not intel or days_since(intel["created_at"]) > 30:
                        try:
                            linkedin_posts = await get_or_fetch_linkedin_posts(
                                lead, user_id, max_posts=WIN_BACK_MAX_LINKEDIN_POSTS, charge=False,
                            )
                            website_content = await fetch_website_text(lead["website"] or "")
                            result = await generate_sales_intelligence(
                                lead["company"], lead["website"] or "", max_uses=max_uses,
                                linkedin_context=format_posts_for_prompt(linkedin_posts),
                                website_content=website_content, ch_context=ch_context,
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
                            # Research failing must NOT stop the email — it is
                            # still written, personalised from CH data + industry.
                            logger.exception("Win-back: intelligence generation failed for %s", lead_id)

                    phones = db.list_phones(lead_id)
                    emails_list = db.list_emails(lead_id)
                    ctx = build_lead_context(lead, phones, emails_list, intel, sender_name, brand_voice)
                    ctx["email_instruction"] = email_instruction
                    ctx["offer_context"] = offer_context
                    ctx["additional_context"] = additional_context
                    ctx["campaign_links"] = campaign_links
                    ctx["ch_data"] = ch_context
                    imported_owner = (owner_by_lead.get(lead_id) if owner_by_lead else "") or (lead["deal_owner"] if "deal_owner" in lead.keys() else "")
                    lead_sender = imported_owner.strip() or sender_name
                    ctx["sender_name"] = lead_sender
                    # CRM deal stage decides whether the email may reference a
                    # completed funding deal. Absent on resume → safe default
                    # (never claims funding). See _relationship_note.
                    ctx["deal_stage"] = (stage_by_lead.get(lead_id) if stage_by_lead else "") or ""
                    # Earlier win-back emails to this lead (other campaigns) so
                    # this one doesn't repeat the same subject/opening/hook.
                    ctx["prior_emails"] = _format_prior_emails(lead_id, campaign_id)

                    try:
                        # The imported broker owns this relationship. Do not let
                        # the global Brand Voice signature overwrite their name.
                        email_result = ensure_sender_subject(await generate_win_back_email(ctx), lead_sender)
                        email_result = append_signature(apply_campaign_link(email_result, campaign_links, campaign_link_text), build_signature(lead_sender))
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
                        campaign_id, already_done + completed, "ready" if is_last else "generating"
                    )

        await asyncio.gather(*[_process_lead(lid) for lid in lead_ids], return_exceptions=True)

    except Exception:
        logger.exception("Win-back: campaign generation task crashed for %s", campaign_id)
        db.update_win_back_campaign_progress(campaign_id, 0, "error")


def _format_ch_data_json(raw: Optional[str]) -> str:
    """Returns a readable string of CH data from a raw ch_data JSON string."""
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


def _format_ch_data(lead: sqlite3.Row) -> str:
    """Returns a readable string of CH data to enrich the email context."""
    raw = lead["ch_data"] if "ch_data" in lead.keys() else None
    return _format_ch_data_json(raw)


async def _fetch_ch_data_for_company(company_name: str) -> str:
    """Looks up a company on Companies House by name and returns formatted
    text for the research prompt — free, real, government-verified data
    that works regardless of whether a lead has a website or LinkedIn
    presence, and is directly relevant for a finance broker (existing
    charges/debentures are a real lending signal). Best-effort: returns ""
    on any failure (no API key configured, no match found, rate limited,
    company not found on CH at all, etc.) — never raises."""
    settings = get_settings()
    api_key = settings.companies_house_api_key
    if not api_key or not company_name:
        return ""
    try:
        result = await search_company_by_name(api_key, company_name)
        if not result:
            return ""
        company_number = result.get("company_number", "")
        if not company_number:
            return ""
        profile = await get_company_profile(api_key, company_number) or {}
        charges, charges_total = await get_company_charges(api_key, company_number)
        officers = await get_company_officers(api_key, company_number)
        ch_data_json = build_ch_data_json(profile, charges, officers, charges_total)
        return _format_ch_data_json(ch_data_json)
    except CHRateLimitError:
        logger.warning("Win-back: CH rate limited looking up '%s'", company_name)
        return ""
    except Exception:
        logger.debug("Win-back: CH lookup failed for '%s'", company_name, exc_info=True)
        return ""


# --- Prior-email context ---

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_URL_ONLY_LINE_RE = re.compile(r"^\s*https?://\S+\s*$")
# Strips the standard sign-off block (from "Best/Kind regards" to the end) so a
# prior email's repeated signature isn't fed back as context on every lead.
_SIGNATURE_RE = re.compile(
    r"\n+(?:best regards|kind regards|best wishes|many thanks|warm regards|regards|thanks|cheers)\b.*$",
    re.IGNORECASE | re.DOTALL,
)


def _clean_prior_body(body: str) -> str:
    """Reduce a stored win-back body to just its message prose for use as
    context: drop the HTML anchor markup, the bare CTA link line, and the
    trailing signature — all of which repeat on every email and only add noise
    (and tokens) to the next email's prompt."""
    text = _HTML_TAG_RE.sub("", body or "")
    text = _SIGNATURE_RE.sub("", text)
    text = "\n".join(l for l in text.splitlines() if not _URL_ONLY_LINE_RE.match(l))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _format_prior_emails(lead_id: str, exclude_campaign_id: Optional[str]) -> str:
    """Formats up to three earlier win-back emails for this lead into a compact
    'already sent' brief the writer uses to avoid repeating itself. Empty string
    when the lead has no prior emails."""
    rows = db.get_prior_win_back_emails_for_lead(lead_id, exclude_campaign_id, limit=3)
    if not rows:
        return ""
    blocks = []
    for i, r in enumerate(rows, 1):
        when = ((r["sent_at"] if "sent_at" in r.keys() else None) or r["created_at"] or "")[:10]
        subject = (r["subject"] or "").strip()
        prose = _clean_prior_body(r["body"] or "")
        blocks.append(f"[{i}] {when} — Subject: {subject}\n{prose}".strip())
    return "\n\n".join(blocks)


# --- Response helpers ---

def _campaign_dict(row: sqlite3.Row) -> dict:
    # Report the total as DISTINCT leads. A pre-fix campaign's stored lead list
    # can contain the same lead several times (duplicate CSV rows), which used to
    # inflate the denominator so "X of Y" could never reach 100%.
    stored_ids = None
    if "lead_ids" in row.keys() and row["lead_ids"]:
        try:
            stored_ids = json.loads(row["lead_ids"])
        except (json.JSONDecodeError, TypeError):
            stored_ids = None
    total = len(set(stored_ids)) if stored_ids else row["total"]
    return {
        "id": row["id"],
        "name": row["name"],
        "status": row["status"],
        "total": total,
        # Report the real number of saved emails, not the stored progress
        # counter — the counter advances even for leads skipped at the credit
        # ceiling, so it could read a full "X of X" for a partial run and hide
        # the Resume button. Counting actual emails can never over-report.
        "generated": db.count_win_back_emails(row["id"]),
        "created_at": row["created_at"],
        "email_instruction": row["email_instruction"] if "email_instruction" in row.keys() else "",
        "offer_context": row["offer_context"] if "offer_context" in row.keys() else "",
        "additional_context": row["additional_context"] if "additional_context" in row.keys() else "",
        "campaign_links": row["campaign_links"] if "campaign_links" in row.keys() else "",
        "campaign_link_text": row["campaign_link_text"] if "campaign_link_text" in row.keys() else "",
        "signature": row["signature"] if "signature" in row.keys() else "",
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
        lead_ids_json=json.dumps(body.lead_ids),
        depth=body.depth,
        email_instruction=body.email_instruction.strip(),
        offer_context=body.offer_context.strip(),
        additional_context=body.additional_context.strip(),
        campaign_links=body.campaign_links.strip(),
        campaign_link_text=body.campaign_link_text.strip(),
        signature=body.signature.strip(),
    )
    asyncio.create_task(_generate_campaign(campaign_id, body.lead_ids, current_user.id, body.depth, email_instruction=body.email_instruction.strip(), offer_context=body.offer_context.strip(), additional_context=body.additional_context.strip(), campaign_links=body.campaign_links.strip(), campaign_link_text=body.campaign_link_text.strip(), signature=body.signature.strip()))
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
    enforce_import_row_cap(body.rows)

    lead_ids: list[str] = []
    to_generate_lead_ids: list[str] = []
    owner_by_lead: dict = {}
    stage_by_lead: dict = {}
    seen_lead_ids: set[str] = set()
    pre_generated_count = 0
    ts = now_iso()
    campaign_id = new_id()
    for row in body.rows:
        lead_id = db.create_lead(
            id=new_id(),
            timestamp=ts,
            company=sanitize_cell(row.company),
            phone_number=row.phone,
            source_url=row.website,
            status="New",
            notes=sanitize_cell(row.notes),
            owner_user_id=current_user.id,
            created_at=ts,
        )
        extra = {k: sanitize_cell(v) for k, v in {
            "contact_name": row.contact_name,
            "website": row.website,
            "linkedin": row.linkedin,
            "industry": row.industry,
            "deal_owner": row.deal_owner,
        }.items() if v}
        if extra:
            db.update_lead_fields(lead_id, extra, ts)
        if row.email:
            db.add_email_ignore_duplicate(new_id(), lead_id, row.email, "csv_import", ts)

        # A CSV often lists the same company on several deal rows; create_lead
        # merges those into ONE lead, so queue each distinct lead only once.
        # Otherwise the same company is generated (and charged £0.20) several
        # times and ends up with duplicate emails. First row's owner/stage win.
        if lead_id in seen_lead_ids:
            continue
        seen_lead_ids.add(lead_id)
        owner_by_lead[lead_id] = row.deal_owner.strip()
        stage_by_lead[lead_id] = row.stage.strip()
        lead_ids.append(lead_id)

        # Row was already previewed under the exact same generation settings
        # (frontend only sends these when its signature still matches) —
        # reuse that result as-is instead of paying for research + email
        # generation again for the same company.
        if row.preview_subject.strip() and row.preview_body.strip():
            db.upsert_win_back_email(
                campaign_id, lead_id, new_id(), row.preview_subject, row.preview_body, ts,
            )
            pre_generated_count += 1
        else:
            to_generate_lead_ids.append(lead_id)

    # Persist the full uploaded CSV (minus per-run preview reuse fields) so the
    # campaign can be re-run from the same source list. Fall back to the
    # generated rows when the client didn't send a separate source set.
    source_rows = body.source_rows or body.rows
    source_rows_json = json.dumps([
        r.model_dump(exclude={"preview_subject", "preview_body"}) for r in source_rows
    ])
    db.create_win_back_campaign(
        id=campaign_id,
        name=body.name,
        created_by=current_user.id,
        total=len(lead_ids),
        created_at=ts,
        lead_ids_json=json.dumps(lead_ids),
        depth=body.depth,
        email_instruction=body.email_instruction.strip(),
        offer_context=body.offer_context.strip(),
        additional_context=body.additional_context.strip(),
        campaign_links=body.campaign_links.strip(),
        campaign_link_text=body.campaign_link_text.strip(),
        signature=body.signature.strip(),
        source_rows_json=source_rows_json,
    )
    if pre_generated_count:
        db.update_win_back_campaign_progress(
            campaign_id, pre_generated_count, "ready" if not to_generate_lead_ids else "generating",
        )
    if to_generate_lead_ids:
        asyncio.create_task(_generate_campaign(campaign_id, to_generate_lead_ids, current_user.id, body.depth, already_done=pre_generated_count, email_instruction=body.email_instruction.strip(), offer_context=body.offer_context.strip(), additional_context=body.additional_context.strip(), campaign_links=body.campaign_links.strip(), campaign_link_text=body.campaign_link_text.strip(), signature=body.signature.strip(), owner_by_lead=owner_by_lead, stage_by_lead=stage_by_lead))
    campaign = db.get_win_back_campaign(campaign_id)
    return _campaign_dict(campaign)


@router.post("/campaigns/preview")
async def preview_campaign_email(
    body: PreviewCampaignRequest,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Generate one representative draft using the same enrichment and email
    generation as a campaign lead, without creating or sending a campaign."""
    row = body.row
    contact_parts = row.contact_name.strip().split(maxsplit=1)
    # Single gate: the flat win_back charge covers the whole preview pipeline
    # (research + LinkedIn + email), so there's no separate sales_intel check.
    allowed, spent, limit = db.check_credit_limit(current_user.id, "win_back")
    if not allowed:
        raise HTTPException(status_code=402, detail=f"Win-back credit limit reached (spent £{spent:.2f} of £{limit:.2f}). Raise it in Settings → Credit Limits.")

    linkedin_posts = await fetch_linkedin_posts_preview(row.linkedin, current_user.id, row.website, max_posts=WIN_BACK_MAX_LINKEDIN_POSTS, charge=False)
    website_content = await fetch_website_text(row.website)
    ch_context = await _fetch_ch_data_for_company(row.company)

    sender_name = row.deal_owner.strip()
    if not sender_name:
        preview_user = db.get_user_by_id(current_user.id)
        sender_name = (preview_user["name"] if preview_user else "") or ""

    context = {
        "company": row.company,
        "sender_name": sender_name,
        "first_name": contact_parts[0] if contact_parts else "",
        "job_title": "",
        "website": row.website,
        "linkedin": row.linkedin,
        "industry": row.industry,
        "email": row.email,
        "lead_notes": row.notes,
        "deal_stage": row.stage,
        "ai_summary": "",
        "ch_data": ch_context,
        "recent_activity": "",
        "email_instruction": body.email_instruction.strip(),
        "offer_context": body.offer_context.strip(),
        "additional_context": body.additional_context.strip(),
        "campaign_links": body.campaign_links.strip(),
    }

    # Research enriches the email but is not required for it: if it fails
    # (refusal, extraction mismatch, transient API error), we still write a
    # personalised email from Companies House data + industry rather than
    # dead-ending the preview with a 502.
    try:
        intel = await generate_sales_intelligence(
            row.company, row.website, max_uses=DEPTH_TO_MAX_USES.get(body.depth, 5),
            linkedin_context=format_posts_for_prompt(linkedin_posts),
            website_content=website_content, ch_context=ch_context,
        )
        context["ai_summary"] = intel.sales_summary
    except IntelligenceExtractionError:
        logger.warning("Win-back: preview research failed for %s — writing from CH/industry instead", row.company)
    except Exception:
        logger.exception("Win-back: preview research errored for %s — writing from CH/industry instead", row.company)

    try:
        # Preview follows the exact same sender rules as final generation.
        result = ensure_sender_subject(await generate_win_back_email(context), sender_name)
        result = append_signature(apply_campaign_link(result, body.campaign_links, body.campaign_link_text), build_signature(sender_name))
    except Exception as exc:
        logger.exception("Win-back: preview email generation failed for %s", row.company)
        raise HTTPException(status_code=502, detail=f"Email generation failed: {exc} Please try again.")

    db.record_credit_spend(new_id(), current_user.id, "win_back", db.CREDIT_COST["win_back"], now_iso())
    return result


@router.post("/campaigns/{campaign_id}/resume")
async def resume_campaign(campaign_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    """Picks up a campaign that stopped partway — typically at the monthly
    credit ceiling — and generates emails only for the leads that never got
    one. Fresh sales intelligence from the first pass is reused, so resumed
    leads usually cost just the email generation."""
    campaign = db.get_win_back_campaign(campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign["created_by"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")
    if campaign["status"] == "generating":
        raise HTTPException(status_code=400, detail="Campaign is still generating.")

    stored = json.loads(campaign["lead_ids"] or "null") if "lead_ids" in campaign.keys() else None
    if not stored:
        raise HTTPException(
            status_code=400,
            detail="This campaign predates resume support — its lead list wasn't saved. Create a new campaign instead.",
        )

    done_lead_ids = {e["lead_id"] for e in db.get_win_back_emails(campaign_id)}
    # Dedupe: a pre-fix campaign's stored list can contain the same lead several
    # times (duplicate CSV rows), and each should only be generated once.
    missing = list(dict.fromkeys(lid for lid in stored if lid not in done_lead_ids))
    if not missing:
        raise HTTPException(status_code=400, detail="Nothing to resume — every lead already has an email.")

    allowed, spent, limit = db.check_credit_limit(campaign["created_by"], "win_back")
    if not allowed:
        raise HTTPException(
            status_code=402,
            detail=f"Still over the Win-back credit limit (spent £{spent:.2f} of £{limit:.2f}). "
            "Raise the limit in Settings → Credit Limits first, then resume.",
        )

    depth = (campaign["depth"] if "depth" in campaign.keys() else None) or "standard"
    email_instruction = (campaign["email_instruction"] if "email_instruction" in campaign.keys() else "") or ""
    offer_context = (campaign["offer_context"] if "offer_context" in campaign.keys() else "") or ""
    additional_context = (campaign["additional_context"] if "additional_context" in campaign.keys() else "") or ""
    campaign_links = (campaign["campaign_links"] if "campaign_links" in campaign.keys() else "") or ""
    campaign_link_text = (campaign["campaign_link_text"] if "campaign_link_text" in campaign.keys() else "") or ""
    signature = (campaign["signature"] if "signature" in campaign.keys() else "") or ""
    db.update_win_back_campaign_progress(campaign_id, len(done_lead_ids), "generating")
    asyncio.create_task(
        _generate_campaign(campaign_id, missing, campaign["created_by"], depth, already_done=len(done_lead_ids), email_instruction=email_instruction, offer_context=offer_context, additional_context=additional_context, campaign_links=campaign_links, campaign_link_text=campaign_link_text, signature=signature)
    )
    return {"resumed": True, "remaining": len(missing)}


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


@router.get("/campaigns/{campaign_id}/rows")
def get_campaign_rows(campaign_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    """Returns the original uploaded CSV rows + the campaign's generation settings
    so the app can re-run the campaign ('Run again') from the same source list.
    `available` is False for campaigns created before source rows were stored."""
    campaign = db.get_win_back_campaign(campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign["created_by"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")

    raw = campaign["source_rows_json"] if "source_rows_json" in campaign.keys() else ""
    try:
        rows = json.loads(raw) if raw else []
    except (json.JSONDecodeError, TypeError):
        rows = []

    def field(name: str) -> str:
        return (campaign[name] if name in campaign.keys() else "") or ""

    return {
        "available": bool(rows),
        "rows": rows,
        "defaults": {
            "name": field("name"),
            "depth": field("depth") or "standard",
            "email_instruction": field("email_instruction"),
            "offer_context": field("offer_context"),
            "additional_context": field("additional_context"),
            "campaign_links": field("campaign_links"),
            "campaign_link_text": field("campaign_link_text"),
        },
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
        await send_email_via_oauth(
            account, to, email_row["subject"], email_row["body"],
            footer_html=build_win_back_footer_html(), footer_text=build_win_back_footer_text(),
        )
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
            await send_email_via_oauth(
                account, to, email_row["subject"], email_row["body"],
                footer_html=build_win_back_footer_html(), footer_text=build_win_back_footer_text(),
            )
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
    # Sender display name is the broker team, not whichever operator happens
    # to click export — recipients don't know the logged-in user's name, and
    # a consistent team identity reads as legitimate rather than as a random
    # personal name attached to a cold win-back email.
    from_name = "WCF Broker Team"
    from_email = (account["email_address"] if account else "") or get_settings().mailchimp_from_email.strip()
    if not from_email:
        raise HTTPException(
            status_code=422,
            detail="No sender email address available. Connect a Gmail or Outlook account, or set a verified Mailchimp 'from' address (MAILCHIMP_FROM_EMAIL) in Settings, before exporting to Mailchimp.",
        )

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
