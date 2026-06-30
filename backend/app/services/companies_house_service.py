"""Companies House REST API client — free official UK government data.
Authentication: HTTP Basic with the API key as username, empty password.
Docs: https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api
"""

import json
import logging
from typing import List, Optional

import httpx

logger = logging.getLogger("app.companies_house")

CH_BASE_URL = "https://api.company-information.service.gov.uk"


def _client(api_key: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(auth=(api_key, ""), base_url=CH_BASE_URL, timeout=15.0)


async def search_companies(
    api_key: str,
    *,
    location: str = "",
    sic_codes: Optional[List[str]] = None,
    company_type: str = "ltd",
    incorporated_from: str = "",
    incorporated_to: str = "",
    size: int = 20,
) -> list[dict]:
    """Advanced Company Search — returns companies matching the given criteria.
    Results are NOT already-in-CRM-checked; dedup is the caller's responsibility."""
    params: dict = {"company_status": "active", "company_type": company_type, "size": size}
    if location:
        params["location"] = location
    if sic_codes:
        params["sic_codes"] = ",".join(sic_codes)
    if incorporated_from:
        params["incorporated_from"] = incorporated_from
    if incorporated_to:
        params["incorporated_to"] = incorporated_to

    async with _client(api_key) as client:
        r = await client.get("/advanced-search/companies", params=params)
        if r.status_code != 200:
            logger.warning("CH search returned %d: %s", r.status_code, r.text[:200])
            return []
        data = r.json()
        return data.get("items", [])


async def get_company_profile(api_key: str, company_number: str) -> Optional[dict]:
    async with _client(api_key) as client:
        r = await client.get(f"/company/{company_number}")
        if r.status_code != 200:
            return None
        return r.json()


async def get_company_charges(api_key: str, company_number: str) -> list[dict]:
    async with _client(api_key) as client:
        r = await client.get(f"/company/{company_number}/charges", params={"items_per_page": 10})
        if r.status_code != 200:
            return []
        return r.json().get("items", [])


async def get_company_officers(api_key: str, company_number: str) -> list[dict]:
    async with _client(api_key) as client:
        r = await client.get(
            f"/company/{company_number}/officers",
            params={"items_per_page": 10, "order_by": "appointed_on"},
        )
        if r.status_code != 200:
            return []
        return [o for o in r.json().get("items", []) if not o.get("resigned_on")]


def extract_county(profile: dict) -> str:
    addr = profile.get("registered_office_address", {})
    return addr.get("region") or addr.get("locality") or addr.get("postal_code", "")[:4]


def extract_sic_industry(profile: dict) -> str:
    codes = profile.get("sic_codes", [])
    return codes[0] if codes else ""


def compute_ch_score(profile: dict, charges: list[dict]) -> int:
    """Deterministic, free, zero-AI pre-filter score from Companies House data.
    Only leads clearing a threshold get the expensive AI enrichment call."""
    score = 0
    from datetime import date, datetime

    # New charge in last 90 days = strong lending trigger
    today = date.today()
    for charge in charges:
        created_on = charge.get("created_on", "")
        if created_on:
            try:
                d = datetime.fromisoformat(created_on).date()
                days_ago = (today - d).days
                if days_ago <= 90:
                    score += 30
                elif days_ago <= 365:
                    score += 15
            except ValueError:
                pass

    # Construction / manufacturing / property = typically high finance need
    sic_codes = profile.get("sic_codes", [])
    HIGH_FINANCE_SIC_PREFIXES = ("41", "42", "43", "25", "26", "28", "24", "68", "41", "49")
    for sic in sic_codes:
        if any(sic.startswith(p) for p in HIGH_FINANCE_SIC_PREFIXES):
            score += 15
            break

    # Company over 2 years = established, not startup risk
    inc_date = profile.get("date_of_creation", "")
    if inc_date:
        try:
            d = datetime.fromisoformat(inc_date).date()
            age_years = (today - d).days / 365
            if age_years >= 5:
                score += 10
            elif age_years >= 2:
                score += 5
        except ValueError:
            pass

    # Multiple charges = active user of finance, likely needs more
    if len(charges) >= 3:
        score += 10

    return min(score, 100)


def build_ch_data_json(profile: dict, charges: list[dict], officers: list[dict]) -> str:
    """Compact JSON to store on the lead — real filed data, no fabrication."""
    director_names = [
        o.get("name", "") for o in officers if o.get("officer_role") in ("director", "secretary")
    ][:5]
    latest_charge = charges[0] if charges else None

    data = {
        "company_number": profile.get("company_number", ""),
        "company_type": profile.get("type", ""),
        "company_status": profile.get("company_status", ""),
        "incorporation_date": profile.get("date_of_creation", ""),
        "registered_address": profile.get("registered_office_address", {}),
        "sic_codes": profile.get("sic_codes", []),
        "accounts": {
            "next_due": profile.get("accounts", {}).get("next_due", ""),
            "last_accounts": profile.get("accounts", {}).get("last_accounts", {}),
        },
        "charges_total": len(charges),
        "latest_charge": {
            "created_on": latest_charge.get("created_on", "") if latest_charge else "",
            "charge_number": latest_charge.get("charge_number", 0) if latest_charge else 0,
            "chargee": (
                latest_charge.get("particulars", {}).get("chargor_acting_as_bare_trustee")
                or ""
            ) if latest_charge else "",
        },
        "directors": director_names,
        "jurisdiction": profile.get("jurisdiction", ""),
    }
    return json.dumps(data)
