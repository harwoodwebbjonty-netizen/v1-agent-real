"""Companies House real-time filing stream consumer.

Connects to stream.companieshouse.gov.uk/filings and filters for mortgage
(charge) events. Runs as a long-lived background asyncio task in main.py.
Reconnects automatically with the saved timepoint so no events are missed
across restarts.

Filing type codes:
  MR01  Particulars of a charge (new charge created)
  MR02  Particulars of a charge (company already entitled)
  MR03  Particulars of a charge (overseas entity)
  MR04  Statement of satisfaction in full
  MR05  Statement of satisfaction in part
"""

import asyncio
import json
import logging
from datetime import datetime, timezone

import httpx

from app import db
from app.services.auth_service import new_id

logger = logging.getLogger("app.ch_stream")

STREAM_BASE = "https://stream.companieshouse.gov.uk"
CH_BASE = "https://api.company-information.service.gov.uk"

_NEW_CHARGE_TYPES = {"MR01", "MR02", "MR03"}
_ALL_CHARGE_TYPES = {"MR01", "MR02", "MR03", "MR04", "MR05"}

_FILING_TYPE_LABEL = {
    "MR01": "New Charge",
    "MR02": "New Charge",
    "MR03": "New Charge (Overseas)",
    "MR04": "Charge Satisfied",
    "MR05": "Charge Part-Satisfied",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def _get_company_name(api_key: str, company_number: str) -> str:
    """Fetch company name from CH REST API. Falls back to company number on error."""
    cached = db.get_company_name_from_leads(company_number)
    if cached:
        return cached
    try:
        async with httpx.AsyncClient(auth=(api_key, ""), base_url=CH_BASE, timeout=8.0) as c:
            r = await c.get(f"/company/{company_number}")
            if r.status_code == 200:
                return r.json().get("company_name") or company_number
    except Exception:
        pass
    return company_number


async def _process_event(event: dict, api_key: str) -> None:
    """Filter filing events for charge types and store in DB."""
    data = event.get("data") or {}
    category = str(data.get("category") or "")
    filing_type = str(data.get("type") or "")

    if category != "mortgage" or filing_type not in _ALL_CHARGE_TYPES:
        return

    resource_uri = str(event.get("resource_uri") or "")
    # /company/{company_number}/filing-history/{transaction_id}
    parts = resource_uri.strip("/").split("/")
    company_number = parts[1] if len(parts) >= 2 else ""
    transaction_id = parts[3] if len(parts) >= 4 else event.get("resource_id", "")
    if not company_number:
        return

    company_name = await _get_company_name(api_key, company_number)
    charge_desc = _FILING_TYPE_LABEL.get(filing_type, filing_type)

    # description_values sometimes has extra context
    desc_vals = data.get("description_values") or {}
    if "charge_number" in desc_vals:
        charge_desc += f" #{desc_vals['charge_number']}"

    record = {
        "id": new_id(),
        "company_number": company_number,
        "company_name": company_name,
        "filing_type": filing_type,
        "charge_description": charge_desc,
        "filing_date": str(data.get("date") or ""),
        "transaction_id": transaction_id,
        "event_data": json.dumps(event, default=str),
        "detected_at": _now_iso(),
    }
    inserted = db.save_ch_charge(record)
    if inserted:
        logger.debug("CH stream: new %s for %s (%s)", filing_type, company_name, company_number)


async def _consume_stream(api_key: str) -> None:
    timepoint = db.get_stream_state("ch_filing_timepoint")
    url = "/filings"
    if timepoint:
        url += f"?timepoint={timepoint}"
    logger.info("CH stream: connecting (timepoint=%s)", timepoint or "start")

    async with httpx.AsyncClient(
        auth=(api_key, ""),
        base_url=STREAM_BASE,
        timeout=httpx.Timeout(connect=15.0, read=None, write=None, pool=None),
    ) as client:
        async with client.stream("GET", url) as response:
            if response.status_code != 200:
                body = await response.aread()
                logger.warning(
                    "CH stream: unexpected status %d: %s",
                    response.status_code,
                    body[:200].decode(errors="replace"),
                )
                return
            logger.info("CH stream: connected, consuming events")
            async for line in response.aiter_lines():
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Save timepoint so we can resume after a restart
                tp = event.get("timepoint")
                if tp is not None:
                    db.set_stream_state("ch_filing_timepoint", str(tp))

                await _process_event(event, api_key)


async def run_filing_stream(api_key: str) -> None:
    """Outer loop: reconnect with backoff whenever the stream drops."""
    backoff = 10
    while True:
        try:
            await _consume_stream(api_key)
            logger.info("CH stream: connection closed cleanly, reconnecting in %ds", backoff)
        except Exception:
            logger.exception("CH stream: connection error, reconnecting in %ds", backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 300)  # cap at 5 min
