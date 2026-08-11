"""Regression test: the CH filing stream must use the STREAM key to
authenticate the streaming connection, and the separate REST key for the
per-event follow-up lookups (company name, charge detail).

Companies House's Streaming and REST APIs use different, non-interchangeable
credentials. main.py used to pass a single key into run_filing_stream() that
fed both the stream connection AND the REST follow-up calls inside
_process_event() — so as soon as a real COMPANIES_HOUSE_STREAM_KEY was
configured, every REST lookup silently 401'd (swallowed by a bare except),
leaving ch_charge_feed.company_name permanently equal to company_number.
Confirmed in production: 1,467,084 of 1,467,114 rows unresolved over a month,
while a direct call using the correct REST key resolved names immediately."""

import asyncio

import pytest

from app.services import ch_stream_service


@pytest.fixture
def captured_calls(monkeypatch):
    calls = {"name": [], "detail": []}

    async def fake_get_company_name(api_key, company_number):
        calls["name"].append(api_key)
        return "Resolved Co"

    async def fake_charge_detail_desc(api_key, company_number, desc_vals):
        calls["detail"].append(api_key)
        return "Debenture — in favour of Example Bank"

    monkeypatch.setattr(ch_stream_service, "_get_company_name", fake_get_company_name)
    monkeypatch.setattr(ch_stream_service, "_charge_detail_desc", fake_charge_detail_desc)
    return calls


def test_process_event_uses_rest_key_not_stream_key(captured_calls, monkeypatch):
    monkeypatch.setattr(ch_stream_service.db, "save_ch_charge", lambda record: True)

    event = {
        "resource_uri": "/company/12345678/filing-history/txn1",
        "resource_id": "txn1",
        "data": {
            "type": "MR01",
            "date": "2026-08-01",
            "description_values": {"charge_number": "1"},
        },
    }

    asyncio.run(ch_stream_service._process_event(event, "REST-KEY-VALUE"))

    assert captured_calls["name"] == ["REST-KEY-VALUE"]
    assert captured_calls["detail"] == ["REST-KEY-VALUE"]


def test_run_filing_stream_threads_two_distinct_keys(monkeypatch):
    """The outer entrypoint's signature must keep stream_key and rest_api_key
    as separate parameters — this is what main.py wires up from the two
    separate settings fields."""
    seen = {}

    async def fake_consume_stream(stream_key, rest_api_key):
        seen["stream_key"] = stream_key
        seen["rest_api_key"] = rest_api_key
        raise RuntimeError("stop after one iteration")

    async def fake_sleep(_seconds):
        raise SystemExit  # break out of the retry loop immediately

    async def fake_prune_loop():
        return None

    monkeypatch.setattr(ch_stream_service, "_consume_stream", fake_consume_stream)
    monkeypatch.setattr(ch_stream_service.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(ch_stream_service, "_prune_loop", fake_prune_loop)

    with pytest.raises(SystemExit):
        asyncio.run(ch_stream_service.run_filing_stream("STREAM-KEY", "REST-KEY"))

    assert seen == {"stream_key": "STREAM-KEY", "rest_api_key": "REST-KEY"}
