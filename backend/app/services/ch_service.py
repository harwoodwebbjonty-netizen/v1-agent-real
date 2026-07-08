"""Companies House API client and snapshot diff engine.

Replaces DataGardener as the activity-feed data source.
Auth: API key as HTTP Basic auth username, empty password.

Endpoints used per company:
  GET /company/{number}                                   company profile + status
  GET /company/{number}/charges                          charge register
  GET /company/{number}/filing-history?items_per_page=20 recent filings
  GET /company/{number}/officers?items_per_page=50       active/resigned officers
  GET /company/{number}/persons-with-significant-control PSCs
"""

import asyncio
import json
import logging
from datetime import date, datetime, timezone
from typing import Optional

import httpx

logger = logging.getLogger("app.ch_service")

CH_BASE_URL = "https://api.company-information.service.gov.uk"


def _client(api_key: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=CH_BASE_URL,
        auth=(api_key, ""),
        timeout=20.0,
    )


async def _get(client: httpx.AsyncClient, path: str) -> Optional[dict]:
    try:
        r = await client.get(path)
        if r.status_code == 200:
            return r.json()
        if r.status_code not in (404, 410):
            logger.warning("CH: %s returned %d", path, r.status_code)
        return None
    except Exception as exc:
        logger.warning("CH: failed %s: %s", path, exc)
        return None


async def get_company_data(api_key: str, company_number: str) -> Optional[dict]:
    """Fetch profile, charges, filings, officers and PSCs from CH.
    Returns a unified snapshot dict, or None if the company is not found."""
    async with _client(api_key) as c:
        company_r, charges_r, filings_r, officers_r, psc_r = await asyncio.gather(
            _get(c, f"/company/{company_number}"),
            _get(c, f"/company/{company_number}/charges?items_per_page=100"),
            _get(c, f"/company/{company_number}/filing-history?items_per_page=20"),
            _get(c, f"/company/{company_number}/officers?items_per_page=100"),
            _get(c, f"/company/{company_number}/persons-with-significant-control?items_per_page=50"),
        )

    if not company_r:
        return None

    return {
        "company": company_r,
        "charges": (charges_r or {}).get("items", []),
        "filings": (filings_r or {}).get("items", []),
        "officers": (officers_r or {}).get("items", []),
        "pscs": (psc_r or {}).get("items", []),
    }


# ---------------------------------------------------------------------------
# Diff engine
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _today() -> str:
    return date.today().isoformat()


def _make_event(
    company_number: str,
    company_name: str,
    lead_id: Optional[str],
    event_type: str,
    description: str,
    occurred_at: str,
    event_data: Optional[dict] = None,
) -> dict:
    from app.services.auth_service import new_id
    return {
        "id": new_id(),
        "company_number": company_number,
        "company_name": company_name,
        "lead_id": lead_id,
        "event_type": event_type,
        "description": description,
        "event_data": json.dumps(event_data) if event_data else None,
        "occurred_at": occurred_at,
        "detected_at": _now_iso(),
    }


# --- Charge helpers ---

def _charge_key(c: dict) -> str:
    return str(c.get("charge_number") or c.get("etag") or "")


def _charge_status(c: dict) -> str:
    return str(c.get("status") or "").lower()


def _charge_date(c: dict) -> str:
    return str(c.get("created_on") or c.get("delivered_on") or _today())


def _charge_type(c: dict) -> str:
    return str(c.get("classification", {}).get("description") or "charge")


def _charge_creditor(c: dict) -> str:
    persons = c.get("persons_entitled", [])
    if persons:
        return str(persons[0].get("name") or "")
    return ""


# --- Officer helpers ---

def _officer_key(o: dict) -> str:
    return str(o.get("links", {}).get("self") or f"{o.get('name','')}|{o.get('appointed_on','')}")


def _officer_name(o: dict) -> str:
    return str(o.get("name") or "Unknown")


def _officer_role(o: dict) -> str:
    return str(o.get("officer_role") or "director").replace("_", " ")


def _officer_resigned(o: dict) -> str:
    return str(o.get("resigned_on") or "")


# --- PSC helpers ---

def _psc_key(p: dict) -> str:
    return str(p.get("links", {}).get("self") or p.get("name") or "")


def _psc_name(p: dict) -> str:
    return str(p.get("name") or "Unknown")


# --- Filing helpers ---

def _filing_key(f: dict) -> str:
    return str(f.get("transaction_id") or "")


def _filing_desc(f: dict) -> str:
    return str(f.get("description_values", {}).get("description") or f.get("description") or f.get("type") or "Filing")


def _filing_date(f: dict) -> str:
    return str(f.get("date") or _today())


def _filing_category(f: dict) -> str:
    return str(f.get("category") or "").lower()


# --- Company status helpers ---

def _company_status(data: dict) -> str:
    return str((data.get("company") or {}).get("company_status") or "")


def diff_snapshots(
    prev: Optional[dict],
    new: dict,
    company_number: str,
    company_name: str,
    lead_id: Optional[str] = None,
) -> list[dict]:
    """Compare prev and new CH snapshots; return list of activity events.

    If prev is None (first fetch), emit only outstanding charges so the user
    sees current exposure without flooding the feed with stale events.
    """
    events: list[dict] = []

    # --- Charges ---
    prev_charges: dict[str, dict] = {_charge_key(c): c for c in (prev or {}).get("charges", []) if _charge_key(c)}
    new_charges: dict[str, dict] = {_charge_key(c): c for c in new.get("charges", []) if _charge_key(c)}

    if prev is None:
        # First fetch: surface existing outstanding charges
        for key, c in new_charges.items():
            if _charge_status(c) not in ("fully-satisfied", "satisfied"):
                creditor = _charge_creditor(c)
                ctype = _charge_type(c)
                desc = f"{creditor + ' — ' if creditor else ''}Outstanding {ctype}"
                events.append(_make_event(company_number, company_name, lead_id, "NEW_CHARGE", desc, _charge_date(c), {"charge": c}))
    else:
        for key, c in new_charges.items():
            if key not in prev_charges:
                creditor = _charge_creditor(c)
                ctype = _charge_type(c)
                desc = f"{creditor + ' registered a new ' + ctype if creditor else 'New ' + ctype + ' registered'}"
                events.append(_make_event(company_number, company_name, lead_id, "NEW_CHARGE", desc, _charge_date(c), {"charge": c}))
            else:
                old_status = _charge_status(prev_charges[key])
                new_status = _charge_status(c)
                if old_status != new_status:
                    if new_status in ("fully-satisfied", "satisfied"):
                        creditor = _charge_creditor(c)
                        desc = f"{creditor + ' charge satisfied' if creditor else 'Charge satisfied and closed'}"
                        events.append(_make_event(company_number, company_name, lead_id, "CHARGE_SATISFIED", desc, _today(), {"charge": c}))
                    else:
                        desc = f"Charge status changed: {old_status} → {new_status}"
                        events.append(_make_event(company_number, company_name, lead_id, "CHARGE_UPDATED", desc, _today(), {"charge": c}))

    if prev is not None:
        # --- Officers ---
        prev_officers: dict[str, dict] = {_officer_key(o): o for o in (prev or {}).get("officers", [])}
        new_officers: dict[str, dict] = {_officer_key(o): o for o in new.get("officers", [])}

        for key, o in new_officers.items():
            if key not in prev_officers:
                if not _officer_resigned(o):
                    name = _officer_name(o)
                    role = _officer_role(o)
                    appt = str(o.get("appointed_on") or _today())
                    events.append(_make_event(company_number, company_name, lead_id, "DIRECTOR_APPOINTMENT", f"{name} appointed as {role}", appt, {"officer": o}))
            else:
                old_o = prev_officers[key]
                if not _officer_resigned(old_o) and _officer_resigned(o):
                    name = _officer_name(o)
                    role = _officer_role(o)
                    resigned = _officer_resigned(o)
                    events.append(_make_event(company_number, company_name, lead_id, "DIRECTOR_RESIGNATION", f"{name} resigned as {role}", resigned or _today(), {"officer": o}))

        # --- PSCs ---
        prev_psc_keys = {_psc_key(p) for p in (prev or {}).get("pscs", [])}
        for p in new.get("pscs", []):
            key = _psc_key(p)
            if key and key not in prev_psc_keys:
                events.append(_make_event(company_number, company_name, lead_id, "PSC_CHANGE", f"New person with significant control: {_psc_name(p)}", _today(), {"psc": p}))
        new_psc_keys = {_psc_key(p) for p in new.get("pscs", [])}
        for key in (prev_psc_keys - new_psc_keys):
            if key:
                events.append(_make_event(company_number, company_name, lead_id, "PSC_CHANGE", f"PSC removed: {key}", _today(), {"psc_key": key}))

        # --- Notable filings (accounts, confirmation statements, significant events) ---
        prev_filing_keys = {_filing_key(f) for f in (prev or {}).get("filings", [])}
        _notable = {"accounts", "confirmation-statement", "dissolution", "insolvency", "mortgage"}
        for f in new.get("filings", []):
            key = _filing_key(f)
            if key and key not in prev_filing_keys:
                cat = _filing_category(f)
                if any(n in cat for n in _notable):
                    desc = _filing_desc(f)
                    fdate = _filing_date(f)
                    etype = "FINANCIAL_CHANGE" if cat == "accounts" else "COMPANY_EVENT"
                    events.append(_make_event(company_number, company_name, lead_id, etype, f"Filing: {desc}", fdate, {"filing": f}))

        # --- Company status change ---
        old_status = _company_status(prev)
        new_status = _company_status(new)
        if old_status and new_status and old_status != new_status:
            events.append(_make_event(
                company_number, company_name, lead_id,
                "COMPANY_EVENT", f"Company status changed: {old_status} → {new_status}",
                _today(), {"old_status": old_status, "new_status": new_status},
            ))

    return events
