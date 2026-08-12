"""Companies House real-time filing stream consumer.

Connects to stream.companieshouse.gov.uk/filings and captures ALL filing
events. Runs as a long-lived background asyncio task in main.py.
Reconnects automatically with the saved timepoint so no events are missed
across restarts.
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import httpx
import sentry_sdk

from app import db
from app.services.auth_service import new_id

logger = logging.getLogger("app.ch_stream")

STREAM_BASE = "https://stream.companieshouse.gov.uk"
CH_BASE = "https://api.company-information.service.gov.uk"

# The filing stream can process several events a second, each wanting up to
# two REST lookups (name + charge detail) — enough on its own to exhaust CH's
# whole account-wide REST rate limit (~600/5min) and 429 every other feature
# sharing the same key (AI Prospecting, Lead Activity refresh, phone lookup).
# This caps the stream's own REST usage well below that, leaving the rest of
# the budget for everything else. Deliberately conservative over precise.
_REST_CALL_MIN_INTERVAL_SECONDS = 2.0
_last_rest_call_at = 0.0
_rest_call_lock = asyncio.Lock()


async def _throttle_rest_call() -> None:
    global _last_rest_call_at
    async with _rest_call_lock:
        wait = _last_rest_call_at + _REST_CALL_MIN_INTERVAL_SECONDS - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        _last_rest_call_at = time.monotonic()

_FILING_TYPE_LABEL: dict[str, str] = {
    # Accounts
    "AA":    "Annual Accounts",
    "AA01":  "Amended Annual Accounts",
    "AAMD":  "Amended Annual Accounts",
    # Confirmation statement
    "CS01":  "Confirmation Statement",
    # Directors
    "AP01":  "Director Appointed",
    "AP02":  "Corporate Director Appointed",
    "AP03":  "Secretary Appointed",
    "AP04":  "Corporate Secretary Appointed",
    "TM01":  "Director Resigned",
    "TM02":  "Corporate Director Resigned",
    "TM03":  "Secretary Resigned",
    "TM04":  "Corporate Secretary Resigned",
    "CH01":  "Director Details Changed",
    "CH02":  "Corporate Director Details Changed",
    "CH03":  "Secretary Details Changed",
    "CH04":  "Corporate Secretary Details Changed",
    # PSC (Persons of Significant Control)
    "PSC01": "PSC Registered",
    "PSC02": "Corporate PSC Registered",
    "PSC03": "Legal Entity PSC Registered",
    "PSC07": "PSC Ceased",
    "PSC08": "Corporate PSC Ceased",
    "PSC09": "Legal Entity PSC Ceased",
    # Charges / mortgages
    "MR01":  "New Charge",
    "MR02":  "New Charge",
    "MR03":  "New Charge (Overseas)",
    "MR04":  "Charge Satisfied",
    "MR05":  "Charge Part-Satisfied",
    # Shares
    "SH01":  "Shares Allotted",
    "SH06":  "Shares Cancelled",
    "SH07":  "Shares Redenominated",
    "SH08":  "Share Class Changed",
    # Address & name
    "AD01":  "Registered Address Changed",
    "AD02":  "SAIL Address Changed",
    "NM01":  "Company Name Changed",
    "NM04":  "Company Name Changed (Court Order)",
    # Dissolution / strike off
    "DISS40": "Voluntary Strike Off",
    "DISS16": "Strike Off Suspended",
    "GAZ1":   "First Gazette Notice (Strike Off)",
    "GAZ2":   "Final Gazette Notice (Strike Off)",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


async def _get_company_name(api_key: str, company_number: str) -> str:
    """Fetch company name from CH REST API. Falls back to company number on error."""
    cached = db.get_company_name_from_leads(company_number)
    if cached:
        return cached
    try:
        await _throttle_rest_call()
        async with httpx.AsyncClient(auth=(api_key, ""), base_url=CH_BASE, timeout=8.0) as c:
            r = await c.get(f"/company/{company_number}")
            if r.status_code == 200:
                return r.json().get("company_name") or company_number
    except Exception:
        pass
    return company_number


_CHARGE_FILING_TYPES = {"MR01", "MR02", "MR03", "MR04", "MR05"}


async def _charge_detail_desc(api_key: str, company_number: str, desc_vals: dict) -> Optional[str]:
    """For charge filings, pull the real charge detail from the charges API —
    'Debenture — in favour of Barclays Bank PLC (fixed, floating)' is what
    makes the feed useful; the filing event itself only says 'a charge was
    registered'."""
    try:
        await _throttle_rest_call()
        async with httpx.AsyncClient(auth=(api_key, ""), base_url=CH_BASE, timeout=8.0) as c:
            r = await c.get(f"/company/{company_number}/charges", params={"items_per_page": 25})
            if r.status_code != 200:
                return None
            items = r.json().get("items") or []
    except Exception:
        return None
    if not items:
        return None

    # Match the specific charge by number when the event gives one; otherwise
    # take the newest (the list is newest-first).
    target = None
    want = str(desc_vals.get("charge_number") or "")
    if want:
        for it in items:
            if str(it.get("charge_number") or "") == want:
                target = it
                break
    if target is None:
        target = items[0]

    parts = []
    classification = (target.get("classification") or {}).get("description")
    if classification:
        parts.append(str(classification))
    lenders = [p.get("name") for p in (target.get("persons_entitled") or []) if p.get("name")]
    if lenders:
        parts.append(f"— in favour of {', '.join(lenders[:2])}")
    particulars = target.get("particulars") or {}
    flags = []
    if particulars.get("contains_fixed_charge"):
        flags.append("fixed")
    if particulars.get("contains_floating_charge"):
        flags.append("floating")
    if particulars.get("floating_charge_covers_all"):
        flags.append("covers all assets")
    if flags:
        parts.append(f"({', '.join(flags)})")
    return " ".join(parts) if parts else None


async def _process_event(event: dict, rest_api_key: str) -> None:
    """Store all filing events in DB — no category filter."""
    data = event.get("data") or {}
    filing_type = str(data.get("type") or "")
    if not filing_type:
        return

    resource_uri = str(event.get("resource_uri") or "")
    # /company/{company_number}/filing-history/{transaction_id}
    parts = resource_uri.strip("/").split("/")
    company_number = parts[1] if len(parts) >= 2 else ""
    transaction_id = parts[3] if len(parts) >= 4 else event.get("resource_id", "")
    if not company_number:
        return

    company_name = await _get_company_name(rest_api_key, company_number)

    # Use our label map if we recognise the type, otherwise fall back to the
    # human-readable description CH provides in the event itself.
    charge_desc = _FILING_TYPE_LABEL.get(filing_type) or str(data.get("description") or filing_type)

    # description_values sometimes has extra context (e.g. charge number)
    desc_vals = data.get("description_values") or {}
    if "charge_number" in desc_vals:
        charge_desc += f" #{desc_vals['charge_number']}"

    # Charge filings get the real detail (debenture/lender/fixed-floating)
    # from the charges API — the headline signal this feed exists for.
    if filing_type in _CHARGE_FILING_TYPES:
        detail = await _charge_detail_desc(rest_api_key, company_number, desc_vals)
        if detail:
            charge_desc = f"{_FILING_TYPE_LABEL.get(filing_type, 'Charge')}: {detail}"

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


async def _consume_stream(stream_key: str, rest_api_key: str) -> None:
    timepoint = db.get_stream_state("ch_filing_timepoint")
    url = "/filings"
    if timepoint:
        url += f"?timepoint={timepoint}"
    logger.info("CH stream: connecting (timepoint=%s)", timepoint or "start")

    async with httpx.AsyncClient(
        auth=(stream_key, ""),
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

                await _process_event(event, rest_api_key)


FEED_RETENTION_DAYS = 30
_PRUNE_INTERVAL_SECONDS = 6 * 3600


async def _prune_loop() -> None:
    """The stream inserts thousands of rows a day — without retention the
    feed table grows unboundedly and slows every feed query."""
    while True:
        try:
            deleted = db.prune_ch_charge_feed(FEED_RETENTION_DAYS)
            if deleted:
                logger.info("CH feed: pruned %d event(s) older than %d days", deleted, FEED_RETENTION_DAYS)
        except Exception:
            logger.exception("CH feed prune failed")
            sentry_sdk.capture_exception()
        await asyncio.sleep(_PRUNE_INTERVAL_SECONDS)


async def run_filing_stream(stream_key: str, rest_api_key: str) -> None:
    """Outer loop: reconnect with backoff whenever the stream drops.

    Two separate keys: `stream_key` authenticates the long-lived streaming
    connection itself (CH's Streaming API); `rest_api_key` is used for the
    follow-up REST lookups per event (company name, charge detail) — CH's
    REST and Streaming keys are different credentials and are not
    interchangeable, so passing one key for both silently 401s the REST
    calls while the stream itself keeps working fine."""
    asyncio.create_task(_prune_loop())
    backoff = 10
    while True:
        try:
            await _consume_stream(stream_key, rest_api_key)
            logger.info("CH stream: connection closed cleanly, reconnecting in %ds", backoff)
        except Exception:
            logger.exception("CH stream: connection error, reconnecting in %ds", backoff)
            sentry_sdk.capture_exception()
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 300)  # cap at 5 min
