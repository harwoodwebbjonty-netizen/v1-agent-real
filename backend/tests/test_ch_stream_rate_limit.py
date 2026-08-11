"""Regression test: the CH filing stream throttles its own REST calls
(company name / charge detail lookups) so it can't exhaust the whole
account-wide Companies House rate limit and starve everything else sharing
the same key (AI Prospecting, Lead Activity refresh, phone lookup) — the
stream can process several events a second, each wanting up to two REST
calls, against a account limit of ~600/5min shared by every CH-key consumer."""

import asyncio

import pytest

from app.services import ch_stream_service


@pytest.fixture(autouse=True)
def reset_throttle_state():
    ch_stream_service._last_rest_call_at = 0.0
    yield
    ch_stream_service._last_rest_call_at = 0.0


def test_throttle_enforces_minimum_interval_between_calls(monkeypatch):
    fake_now = [1000.0]
    sleeps = []

    def fake_monotonic():
        return fake_now[0]

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        fake_now[0] += seconds  # simulate time passing while "asleep"

    monkeypatch.setattr(ch_stream_service.time, "monotonic", fake_monotonic)
    monkeypatch.setattr(ch_stream_service.asyncio, "sleep", fake_sleep)

    async def run_three_calls():
        await ch_stream_service._throttle_rest_call()  # first call: no wait
        fake_now[0] += 0.1  # only 0.1s elapsed before the next call
        await ch_stream_service._throttle_rest_call()  # must wait ~1.9s
        fake_now[0] += 0.1
        await ch_stream_service._throttle_rest_call()  # must wait ~1.9s again

    asyncio.run(run_three_calls())

    assert sleeps == pytest.approx([1.9, 1.9], abs=1e-9)


def test_no_wait_when_calls_are_already_spaced_out(monkeypatch):
    fake_now = [1000.0]
    sleeps = []

    monkeypatch.setattr(ch_stream_service.time, "monotonic", lambda: fake_now[0])

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(ch_stream_service.asyncio, "sleep", fake_sleep)

    async def run_two_calls():
        await ch_stream_service._throttle_rest_call()
        fake_now[0] += 5.0  # well past the 2s minimum interval
        await ch_stream_service._throttle_rest_call()

    asyncio.run(run_two_calls())

    assert sleeps == []
