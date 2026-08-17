"""Tests for the /calendar-events router, including the best-effort push to
a connected external calendar added alongside calendar OAuth (Stage 4
roadmap item) — a failed/absent push must never fail the local event
creation the rep is actually waiting on."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.routers import calendar as calendar_router


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


@pytest.fixture
def client(isolated_db):
    app = FastAPI()
    app.include_router(calendar_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(id="user-1", name="Rep", role="member")
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_create_event_with_no_connected_calendar(client):
    """The common case: no calendar OAuth account connected — creation must
    still succeed, with no attempt to push anywhere."""
    resp = client.post(
        "/calendar-events",
        json={"title": "Call Acme", "date": "2026-09-01", "time": "14:00", "type": "call", "description": "Follow up"},
    )

    assert resp.status_code == 200
    assert resp.json()["title"] == "Call Acme"


def test_create_event_push_failure_does_not_fail_creation(client, monkeypatch):
    """A connected-but-broken calendar (e.g. expired/revoked grant) must not
    prevent the local event from being created."""
    db.upsert_calendar_oauth_account(
        "acct-1", "user-1", "gmail", "rep@example.com", "enc-access", "enc-refresh", "2030-01-01T00:00:00+00:00", "t",
    )

    async def _boom(*args, **kwargs):
        from app.services.calendar_oauth_service import OAuthError

        raise OAuthError("token refresh failed")

    monkeypatch.setattr("app.routers.calendar.push_event_to_calendar", _boom)

    resp = client.post(
        "/calendar-events",
        json={"title": "Call Acme", "date": "2026-09-01", "time": "14:00", "type": "call", "description": ""},
    )

    assert resp.status_code == 200
    assert resp.json()["title"] == "Call Acme"


def test_create_event_pushes_to_each_connected_provider(client, monkeypatch):
    db.upsert_calendar_oauth_account(
        "acct-1", "user-1", "gmail", "rep@example.com", "enc-access", "enc-refresh", "2030-01-01T00:00:00+00:00", "t",
    )
    db.upsert_calendar_oauth_account(
        "acct-2", "user-1", "microsoft", "rep@example.com", "enc-access", "enc-refresh", "2030-01-01T00:00:00+00:00", "t",
    )
    calls = []

    async def _record(account, title, description, date, time):
        calls.append(account["provider"])

    monkeypatch.setattr("app.routers.calendar.push_event_to_calendar", _record)

    resp = client.post(
        "/calendar-events",
        json={"title": "Call Acme", "date": "2026-09-01", "time": "14:00", "type": "call", "description": ""},
    )

    assert resp.status_code == 200
    assert sorted(calls) == ["gmail", "microsoft"]
