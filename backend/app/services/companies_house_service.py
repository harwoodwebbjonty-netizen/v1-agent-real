"""Companies House REST API client — free official UK government data.
Authentication: HTTP Basic with the API key as username, empty password.
Docs: https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api
"""

import json
import logging
import re
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


_LEGAL_SUFFIXES = re.compile(
    r"\s+(limited|ltd\.?|plc\.?|llp\.?|llc\.?|inc\.?|co\.?|company|group|holdings?|services?|solutions?|consulting|consultants?|technologies|technology|tech|associates?|partners?|partnership|enterprises?|trading|international|uk|the)\s*$",
    re.IGNORECASE,
)


def _name_variants(name: str) -> list[str]:
    """Return the original name plus progressively stripped variants to maximise CH hit rate."""
    variants = [name]
    stripped = _LEGAL_SUFFIXES.sub("", name).strip()
    if stripped and stripped != name:
        variants.append(stripped)
        # Strip again in case of "Acme Solutions Ltd" → "Acme Solutions" → "Acme"
        stripped2 = _LEGAL_SUFFIXES.sub("", stripped).strip()
        if stripped2 and stripped2 != stripped:
            variants.append(stripped2)
    return variants


async def search_company_by_name(api_key: str, name: str) -> Optional[dict]:
    """Text search by company name — tries original name then stripped variants.
    Returns the best active match, or the first result overall if none are active."""
    async with _client(api_key) as client:
        for variant in _name_variants(name):
            r = await client.get("/search/companies", params={"q": variant, "items_per_page": 10})
            if r.status_code != 200:
                continue
            items = r.json().get("items", [])
            # Prefer an active company
            for item in items:
                if item.get("company_status") == "active":
                    return item
            if items:
                return items[0]
    return None


async def get_company_profile(api_key: str, company_number: str) -> Optional[dict]:
    async with _client(api_key) as client:
        r = await client.get(f"/company/{company_number}")
        if r.status_code != 200:
            return None
        return r.json()


async def get_company_charges(api_key: str, company_number: str) -> tuple[list[dict], int]:
    """Returns (items, total_count). Fetches up to 25 charges."""
    async with _client(api_key) as client:
        r = await client.get(f"/company/{company_number}/charges", params={"items_per_page": 25})
        if r.status_code != 200:
            return [], 0
        data = r.json()
        return data.get("items", []), data.get("total_count", 0)


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


_SIC_DESCRIPTIONS: dict[str, str] = {
    "01": "Agriculture & Forestry", "02": "Forestry & Logging", "03": "Fishing & Aquaculture",
    "05": "Mining", "06": "Oil & Gas Extraction", "07": "Metal Ore Mining",
    "08": "Quarrying", "09": "Mining Support",
    "10": "Food Manufacturing", "11": "Beverages", "12": "Tobacco",
    "13": "Textiles", "14": "Clothing", "15": "Leather",
    "16": "Wood & Timber", "17": "Paper", "18": "Printing",
    "19": "Petroleum Refining", "20": "Chemicals", "21": "Pharmaceuticals",
    "22": "Rubber & Plastics", "23": "Construction Materials", "24": "Metals",
    "25": "Fabricated Metals", "26": "Electronics", "27": "Electrical Equipment",
    "28": "Machinery", "29": "Motor Vehicles", "30": "Transport Equipment",
    "31": "Furniture", "32": "Other Manufacturing", "33": "Repair & Installation",
    "35": "Energy & Utilities", "36": "Water Supply", "37": "Sewage",
    "38": "Waste Management", "39": "Remediation",
    "41": "Construction of Buildings", "42": "Civil Engineering", "43": "Specialist Construction",
    "45": "Vehicle Trade", "46": "Wholesale Trade", "47": "Retail",
    "49": "Land Transport", "50": "Water Transport", "51": "Air Transport",
    "52": "Warehousing & Storage", "53": "Postal & Courier",
    "55": "Hotels & Accommodation", "56": "Food & Beverage Service",
    "58": "Publishing", "59": "Film & TV", "60": "Broadcasting",
    "61": "Telecommunications", "62": "IT & Software", "63": "Information Services",
    "64": "Financial Services", "65": "Insurance", "66": "Financial Auxiliaries",
    "68": "Real Estate",
    "69": "Legal & Accounting", "70": "Management Consulting",
    "71": "Architecture & Engineering", "72": "Research & Development",
    "73": "Advertising & Marketing", "74": "Other Professional Services", "75": "Veterinary",
    "77": "Equipment Rental", "78": "Employment Services", "79": "Travel Agencies",
    "80": "Security Services", "81": "Facilities Management", "82": "Office Admin",
    "84": "Public Administration", "85": "Education",
    "86": "Healthcare", "87": "Residential Care", "88": "Social Work",
    "90": "Arts & Entertainment", "91": "Libraries & Museums",
    "92": "Gambling", "93": "Sports & Recreation",
    "94": "Membership Organisations", "95": "Computer Repair",
    "96": "Personal Services", "97": "Household Services",
}


def extract_sic_industry(profile: dict) -> str:
    codes = profile.get("sic_codes", [])
    if not codes:
        return ""
    code = str(codes[0]).strip()
    return _SIC_DESCRIPTIONS.get(code[:2], code)


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


def build_not_found_ch_data_json() -> str:
    """Sentinel written when a company cannot be found on Companies House at all."""
    return json.dumps({"not_found": True, "charges": [], "charges_total": 0})


def build_partial_ch_data_json(search_result: dict) -> str:
    """Partial record built from the name-search result when we have a hit but no company number."""
    return json.dumps({
        "company_number": search_result.get("company_number", ""),
        "company_type": search_result.get("company_type", ""),
        "company_status": search_result.get("company_status", ""),
        "incorporation_date": search_result.get("date_of_creation", ""),
        "registered_address": search_result.get("address", {}),
        "sic_codes": [],
        "charges_total": 0,
        "charges": [],
        "directors": [],
        "partial": True,
    })


def build_ch_data_json(profile: dict, charges: list[dict], officers: list[dict], charges_total: int = 0) -> str:
    """Compact JSON to store on the lead — real filed data, no fabrication."""
    director_names = [
        o.get("name", "") for o in officers if o.get("officer_role") in ("director", "secretary")
    ][:5]

    charge_records = []
    for charge in charges:
        holders = [p.get("name", "") for p in charge.get("persons_entitled", [])]
        charge_records.append({
            "status": charge.get("status", ""),
            "created_on": charge.get("created_on", ""),
            "delivered_on": charge.get("delivered_on", ""),
            "classification": charge.get("classification", {}).get("description", ""),
            "holders": holders,
            "description": charge.get("particulars", {}).get("description", ""),
        })

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
        "charges_total": charges_total or len(charges),
        "charges": charge_records,
        "directors": director_names,
        "jurisdiction": profile.get("jurisdiction", ""),
    }
    return json.dumps(data)
