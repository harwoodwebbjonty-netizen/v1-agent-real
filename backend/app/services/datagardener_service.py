"""DataGardener API client and snapshot diff engine.

API: GET https://api.datagardener.com/companies/{company_number}
Auth: x-api-key header with the user's API token.

diff_snapshots() compares the previous and new DataGardener snapshots and
returns structured activity_event dicts for each detected change.
"""

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import httpx

logger = logging.getLogger("app.datagardener")

DG_BASE_URL = "https://api.datagardener.com"


def _client(api_key: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=DG_BASE_URL,
        headers={"x-api-key": api_key},
        timeout=20.0,
    )


async def get_company_data(api_key: str, company_number: str) -> Optional[dict]:
    """Fetch the full company profile from DataGardener. Returns None on error."""
    try:
        async with _client(api_key) as client:
            r = await client.get(f"/companies/{company_number}")
            if r.status_code == 404:
                logger.debug("DG: company %s not found", company_number)
                return None
            if r.status_code != 200:
                logger.warning("DG: company %s returned %d: %s", company_number, r.status_code, r.text[:200])
                return None
            return r.json()
    except Exception as exc:
        logger.warning("DG: failed to fetch company %s: %s", company_number, exc)
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _today() -> str:
    return date.today().isoformat()


def _get(obj: dict, *keys: str, default="") -> str:
    """Try each key in order, return first truthy value as string, else default."""
    for k in keys:
        v = obj.get(k)
        if v is not None:
            return str(v)
    return str(default)


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


# ---------------------------------------------------------------------------
# Field-name aliases: DG uses camelCase; we handle both for robustness
# ---------------------------------------------------------------------------

def _mortgage_key(m: dict) -> str:
    return str(m.get("chargeNumber") or m.get("charge_number") or m.get("mortgageId") or "")


def _mortgage_date(m: dict) -> str:
    return str(m.get("chargeDate") or m.get("charge_date") or m.get("createdOn") or m.get("created_on") or _today())


def _mortgage_status(m: dict) -> str:
    return str(m.get("status") or "").lower()


def _mortgage_type(m: dict) -> str:
    return str(m.get("type") or m.get("chargeType") or m.get("classification", {}).get("description") or "charge")


def _mortgage_creditor(m: dict) -> str:
    return str(m.get("creditor") or m.get("chargeHolder") or m.get("holderName") or "")


def _director_key(d: dict) -> str:
    name = str(d.get("directorName") or d.get("name") or "")
    appt = str(d.get("appointedDate") or d.get("appointed_on") or d.get("appointmentDate") or "")
    return f"{name}|{appt}"


def _director_name(d: dict) -> str:
    return str(d.get("directorName") or d.get("name") or "Unknown")


def _director_role(d: dict) -> str:
    return str(d.get("role") or d.get("officerRole") or d.get("officer_role") or "director")


def _director_resigned(d: dict) -> str:
    return str(d.get("resignationDate") or d.get("resigned_on") or "")


def _director_appt(d: dict) -> str:
    return str(d.get("appointedDate") or d.get("appointed_on") or d.get("appointmentDate") or _today())


def _psc_key(p: dict) -> str:
    return str(p.get("name") or p.get("pscName") or "")


def _alert_key(a: dict) -> str:
    return str(a.get("code") or a.get("alertCode") or a.get("type") or a.get("description") or "")


def _alert_desc(a: dict) -> str:
    return str(a.get("description") or a.get("alertDescription") or a.get("code") or "Risk alert")


def _latest_accounts_year(data: dict) -> Optional[dict]:
    accounts = data.get("statutoryAccounts") or data.get("accounts") or []
    if not accounts:
        return None
    return sorted(accounts, key=lambda a: str(a.get("year") or a.get("periodEnd") or ""), reverse=True)[0]


def _zscore(data: dict) -> Optional[float]:
    v = data.get("zscore") or data.get("zScore") or data.get("z_score")
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _iscore(data: dict) -> Optional[float]:
    v = data.get("iscore") or data.get("iScore") or data.get("i_score") or data.get("insolvencyScore")
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Main diff engine
# ---------------------------------------------------------------------------

def diff_snapshots(
    prev: Optional[dict],
    new: dict,
    company_number: str,
    company_name: str,
    lead_id: Optional[str] = None,
) -> list[dict]:
    """Compare prev and new DataGardener snapshots; return list of activity events.

    If prev is None (first fetch), only emit events for outstanding charges so
    existing context is surfaced without flooding with fake 'new' events for
    old directors/alerts that have been there for years.
    """
    events: list[dict] = []

    # --- Mortgages / Charges ---
    prev_mortgages = {_mortgage_key(m): m for m in (prev or {}).get("mortgages", []) if _mortgage_key(m)}
    new_mortgages = {_mortgage_key(m): m for m in new.get("mortgages", []) if _mortgage_key(m)}

    if prev is None:
        # Initial load: emit outstanding charges so the user sees current state
        for key, m in new_mortgages.items():
            if _mortgage_status(m) not in ("satisfied", "fully_satisfied"):
                creditor = _mortgage_creditor(m)
                ctype = _mortgage_type(m)
                desc = f"{creditor + ' — ' if creditor else ''}Outstanding {ctype}"
                events.append(_make_event(
                    company_number, company_name, lead_id,
                    "NEW_CHARGE", desc, _mortgage_date(m), {"charge": m},
                ))
    else:
        for key, m in new_mortgages.items():
            if key not in prev_mortgages:
                creditor = _mortgage_creditor(m)
                ctype = _mortgage_type(m)
                desc = f"{creditor + ' registered a new ' + ctype if creditor else 'New ' + ctype + ' registered'}"
                events.append(_make_event(
                    company_number, company_name, lead_id,
                    "NEW_CHARGE", desc, _mortgage_date(m), {"charge": m},
                ))
            else:
                old_m = prev_mortgages[key]
                old_status = _mortgage_status(old_m)
                new_status = _mortgage_status(m)
                if old_status != new_status and new_status in ("satisfied", "fully_satisfied"):
                    creditor = _mortgage_creditor(m)
                    desc = f"{creditor + ' charge satisfied' if creditor else 'Charge satisfied and closed'}"
                    events.append(_make_event(
                        company_number, company_name, lead_id,
                        "CHARGE_SATISFIED", desc, _today(), {"charge": m},
                    ))
                elif old_status != new_status:
                    desc = f"Charge status changed from {old_status} to {new_status}"
                    events.append(_make_event(
                        company_number, company_name, lead_id,
                        "CHARGE_UPDATED", desc, _today(), {"charge": m},
                    ))

    if prev is not None:
        # --- Directors ---
        prev_directors = {_director_key(d): d for d in (prev or {}).get("directorsData", [])}
        new_directors = {_director_key(d): d for d in new.get("directorsData", [])}

        for key, d in new_directors.items():
            if key not in prev_directors:
                name = _director_name(d)
                role = _director_role(d)
                appt = _director_appt(d)
                events.append(_make_event(
                    company_number, company_name, lead_id,
                    "DIRECTOR_APPOINTMENT", f"{name} appointed as {role}",
                    appt, {"director": d},
                ))
            else:
                old_d = prev_directors[key]
                if not _director_resigned(old_d) and _director_resigned(d):
                    name = _director_name(d)
                    role = _director_role(d)
                    resigned = _director_resigned(d)
                    events.append(_make_event(
                        company_number, company_name, lead_id,
                        "DIRECTOR_RESIGNATION", f"{name} resigned as {role}",
                        resigned or _today(), {"director": d},
                    ))

        # --- PSC changes ---
        prev_pscs = set(_psc_key(p) for p in (prev or {}).get("pscData", []))
        new_pscs_list = new.get("pscData", [])
        new_pscs = set(_psc_key(p) for p in new_pscs_list)

        for p in new_pscs_list:
            key = _psc_key(p)
            if key and key not in prev_pscs:
                events.append(_make_event(
                    company_number, company_name, lead_id,
                    "PSC_CHANGE", f"New person with significant control: {key}",
                    _today(), {"psc": p},
                ))
        for key in (prev_pscs - new_pscs):
            if key:
                events.append(_make_event(
                    company_number, company_name, lead_id,
                    "PSC_CHANGE", f"PSC removed: {key}",
                    _today(), {"psc_name": key},
                ))

        # --- Risk alerts ---
        prev_alerts = set(_alert_key(a) for a in (prev or {}).get("safealertsinformation", []))
        for a in new.get("safealertsinformation", []):
            key = _alert_key(a)
            if key and key not in prev_alerts:
                desc = _alert_desc(a)
                events.append(_make_event(
                    company_number, company_name, lead_id,
                    "RISK_INCREASE", f"New risk alert: {desc}",
                    _today(), {"alert": a},
                ))

        # --- Z-score / I-score deterioration ---
        prev_z = _zscore(prev or {})
        new_z = _zscore(new)
        if prev_z is not None and new_z is not None and (prev_z - new_z) > 10:
            events.append(_make_event(
                company_number, company_name, lead_id,
                "RISK_INCREASE", f"Risk score deteriorated (z-score: {prev_z:.0f} → {new_z:.0f})",
                _today(), {"prev_zscore": prev_z, "new_zscore": new_z},
            ))

        prev_i = _iscore(prev or {})
        new_i = _iscore(new)
        if prev_i is not None and new_i is not None and (prev_i - new_i) > 10:
            events.append(_make_event(
                company_number, company_name, lead_id,
                "RISK_INCREASE", f"Insolvency risk score worsened ({prev_i:.0f} → {new_i:.0f})",
                _today(), {"prev_iscore": prev_i, "new_iscore": new_i},
            ))

        # --- Financial accounts ---
        prev_accts = _latest_accounts_year(prev or {})
        new_accts = _latest_accounts_year(new)
        if new_accts and prev_accts:
            prev_year = str(prev_accts.get("year") or prev_accts.get("periodEnd") or "")
            new_year = str(new_accts.get("year") or new_accts.get("periodEnd") or "")
            if new_year and new_year != prev_year:
                turnover = new_accts.get("turnover") or new_accts.get("revenue")
                desc = f"New accounts filed: {new_year}"
                if turnover:
                    desc += f" (turnover: £{turnover:,.0f})" if isinstance(turnover, (int, float)) else f" (turnover: {turnover})"
                events.append(_make_event(
                    company_number, company_name, lead_id,
                    "FINANCIAL_CHANGE", desc, _today(), {"accounts": new_accts},
                ))

    return events
