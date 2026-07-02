"""AI Prospecting — phases 2-5 of the Companies House lead-sourcing pipeline.
Phases 2-3 (discovery + free enrichment) cost nothing: structured API data.
Phase 4 (AI narrative) and 5 (AI score) reuse the existing
generate_sales_intelligence call — only triggered for leads that cleared the
free pre-filter score, keeping per-lead AI cost minimal."""

import json
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from app import db
from app.core.config import get_settings
from app.schemas_ai_prospecting import ProspectingCriteria
from app.services.auth_service import new_id, now_iso
from app.services.companies_house_service import (
    build_ch_data_json,
    compute_ch_score,
    extract_county,
    extract_sic_industry,
    get_company_charges,
    get_company_officers,
    get_company_profile,
    search_companies,
)

logger = logging.getLogger("app.ai_prospecting")


def _passes_charge_filters(charges: list, criteria: ProspectingCriteria) -> bool:
    """Apply all charge-related post-search filters. Returns False to skip the lead."""
    # Count filters require charges to exist when a minimum is set
    if criteria.min_charges > 0 and len(charges) < criteria.min_charges:
        return False
    if criteria.max_charges > 0 and len(charges) > criteria.max_charges:
        return False

    if not charges:
        # No charges — skip if any filter requires at least one
        if criteria.active_charges_only or criteria.new_charges_only or criteria.charge_types:
            return False
        return True

    # Build the relevant subset of charges
    relevant = list(charges)
    if criteria.active_charges_only:
        relevant = [c for c in relevant if c.get("status") == "outstanding"]
        if not relevant:
            return False
    elif not criteria.include_satisfied:
        relevant = [c for c in relevant if c.get("status") != "satisfied"]

    # New charges only — registered within last 90 days
    if criteria.new_charges_only:
        cutoff = (date.today() - timedelta(days=90)).isoformat()
        relevant = [c for c in relevant if c.get("created_on", "") >= cutoff]
        if not relevant:
            return False

    # Charge registered date range
    if criteria.charge_registered_from:
        relevant = [c for c in relevant if c.get("created_on", "") >= criteria.charge_registered_from]
        if not relevant:
            return False
    if criteria.charge_registered_to:
        relevant = [c for c in relevant if c.get("created_on", "") <= criteria.charge_registered_to]
        if not relevant:
            return False

    # Charge type filter — match on classification description (case-insensitive substring)
    if criteria.charge_types:
        descriptions = [
            c.get("classification", {}).get("description", "").lower()
            for c in relevant
        ]
        wanted = [ct.lower() for ct in criteria.charge_types]
        matched = any(
            any(w in desc or desc in w for desc in descriptions)
            for w in wanted
        )
        if not matched:
            return False

    return True


async def _search_all_locations(
    api_key: str, criteria: ProspectingCriteria
) -> list[dict]:
    """Run one CH search per location and deduplicate by company_number."""
    effective_locations = criteria.locations or ([criteria.location] if criteria.location else [""])
    per_loc = max(10, min(100, criteria.max_results // max(1, len(effective_locations))))

    seen: set[str] = set()
    combined: list[dict] = []
    for loc in effective_locations:
        try:
            items = await search_companies(
                api_key,
                location=loc,
                sic_codes=criteria.sic_codes or None,
                company_type=criteria.company_type,
                incorporated_from=criteria.incorporated_from,
                incorporated_to=criteria.incorporated_to,
                size=min(per_loc, 100),
            )
        except Exception as exc:
            logger.warning("CH search failed for location %r: %s", loc, exc)
            items = []

        for item in items:
            num = item.get("company_number", "")
            if num not in seen:
                seen.add(num)
                combined.append(item)

    return combined[: criteria.max_results]


async def run_prospecting(
    run_id: str, owner_user_id: str, criteria: ProspectingCriteria, list_id: Optional[str] = None
) -> None:
    """Entry point called by the background task. Updates prospecting_runs table
    in real time so the frontend can poll for live progress."""
    settings = get_settings()
    api_key = settings.companies_house_api_key
    if not api_key:
        db.update_prospecting_run(
            run_id,
            {"status": "error", "error": "COMPANIES_HOUSE_API_KEY not configured", "completed_at": now_iso()},
        )
        return

    found = created = skipped = 0
    try:
        companies = await _search_all_locations(api_key, criteria)
        found = len(companies)
        db.update_prospecting_run(run_id, {"found": found})

        for item in companies:
            company_number = item.get("company_number", "")
            company_name = item.get("company_name") or item.get("title", "Unknown")

            # Dedup: already in CRM?
            if company_number and db.get_lead_by_company_number(company_number):
                skipped += 1
                db.update_prospecting_run(run_id, {"skipped": skipped})
                continue

            try:
                profile = await get_company_profile(api_key, company_number) or {}
                charges = await get_company_charges(api_key, company_number)
                officers = await get_company_officers(api_key, company_number)
            except Exception as exc:
                logger.warning("CH fetch failed for %s: %s", company_number, exc)
                profile, charges, officers = {}, [], []

            ch_score = compute_ch_score(profile or {}, charges)
            if criteria.min_ch_score > 0 and ch_score < criteria.min_ch_score:
                skipped += 1
                db.update_prospecting_run(run_id, {"skipped": skipped})
                continue

            # Apply charge-related post-search filters
            if not _passes_charge_filters(charges, criteria):
                skipped += 1
                db.update_prospecting_run(run_id, {"skipped": skipped})
                continue

            county = extract_county(profile) if profile else ""
            sic_industry = extract_sic_industry(profile) if profile else ""
            ch_data = build_ch_data_json(profile or {}, charges, officers)

            ch_parsed = json.loads(ch_data)
            director_name = ch_parsed.get("directors", [""])[0]

            address = (profile or {}).get("registered_office_address", {})
            address_str = ", ".join(
                filter(None, [
                    address.get("address_line_1", ""),
                    address.get("locality", ""),
                    address.get("postal_code", ""),
                ])
            )

            created_at = now_iso()
            lead_id = new_id()
            db.create_lead(
                id=lead_id,
                timestamp=created_at,
                company=company_name,
                phone_number="",
                source_url=f"https://find-and-update.company-information.service.gov.uk/company/{company_number}",
                status="unverified",
                notes=f"Via AI Prospecting | CH score: {ch_score}/100 | {address_str}",
                owner_user_id=owner_user_id,
                created_at=created_at,
                list_id=list_id,
            )

            db.update_lead_fields(
                lead_id,
                {
                    "company_number": company_number,
                    "industry": sic_industry,
                    "contact_name": director_name,
                    "website": (profile or {}).get("links", {}).get("self", ""),
                    "ch_data": ch_data,
                },
                created_at,
            )

            created += 1
            db.update_prospecting_run(run_id, {"created": created})

            if criteria.run_ai_enrichment and ch_score >= max(criteria.min_ch_score, 20):
                try:
                    from app.services.sales_intelligence_service import generate_sales_intelligence
                    import json as json_mod
                    result = await generate_sales_intelligence(company_name, "")
                    db.add_lead_intelligence_version(
                        new_id(), lead_id,
                        {
                            "executive_summary": result.executive_summary,
                            "sales_summary": result.sales_summary,
                            "pain_points": json_mod.dumps(result.pain_points.model_dump()),
                            "buying_signals": json_mod.dumps(result.buying_signals),
                            "conversation_starters": json_mod.dumps(result.conversation_starters),
                            "discovery_questions": json_mod.dumps(result.discovery_questions),
                            "objection_handling": json_mod.dumps([o.model_dump() for o in result.objection_handling]),
                            "pitch_angle": result.pitch_angle,
                            "call_brief": result.call_brief,
                            "score_breakdown": json_mod.dumps(result.score_breakdown.model_dump()),
                            "lead_score": result.lead_score,
                            "lead_temperature": result.lead_temperature,
                            "confidence_note": result.confidence_note,
                        },
                        created_at,
                    )
                except Exception as exc:
                    logger.warning("AI enrichment failed for %s: %s", company_name, exc)

        db.update_prospecting_run(
            run_id,
            {"status": "complete", "found": found, "created": created, "skipped": skipped, "completed_at": now_iso()},
        )
    except Exception as exc:
        logger.exception("Prospecting run %s failed", run_id)
        db.update_prospecting_run(
            run_id,
            {"status": "error", "error": str(exc)[:500], "completed_at": now_iso()},
        )
