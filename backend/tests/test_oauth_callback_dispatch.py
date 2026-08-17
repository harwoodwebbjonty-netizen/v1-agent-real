"""Tests for the shared OAuth callback (email_oauth.py) dispatching on the
state row's `purpose` to either email_oauth_service or
calendar_oauth_service — the fix that lets every OAuth-based connector
this app has (email, calendar, anything added later) reuse one already-
registered redirect URI instead of each needing its own manual Google
Cloud Console / Azure App Registration entry. See migration 038."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import email_oauth as email_oauth_router


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


@pytest.fixture
def client(isolated_db):
    app = FastAPI()
    app.include_router(email_oauth_router.router)
    yield TestClient(app)


def test_callback_dispatches_to_email_service_by_default(client, monkeypatch):
    db.create_oauth_state("state-1", "user-1", "gmail", "t")  # purpose defaults to "email"
    calls = []

    async def _record(provider, code, user_id):
        calls.append(("email", provider, code, user_id))

    monkeypatch.setattr(email_oauth_router, "handle_oauth_callback", _record)

    resp = client.get("/email-oauth/gmail/callback", params={"code": "auth-code", "state": "state-1"})

    assert resp.status_code == 200
    assert "Connected" in resp.text
    assert calls == [("email", "gmail", "auth-code", "user-1")]


def test_callback_dispatches_to_calendar_service_for_calendar_purpose(client, monkeypatch):
    db.create_oauth_state("state-2", "user-1", "gmail", "t", purpose="calendar")
    calls = []

    async def _record(provider, code, user_id):
        calls.append(("calendar", provider, code, user_id))

    monkeypatch.setattr(email_oauth_router.calendar_oauth_service, "handle_oauth_callback", _record)

    resp = client.get("/email-oauth/gmail/callback", params={"code": "auth-code", "state": "state-2"})

    assert resp.status_code == 200
    assert "Connected" in resp.text
    assert calls == [("calendar", "gmail", "auth-code", "user-1")]


def test_callback_state_is_single_use(client, monkeypatch):
    db.create_oauth_state("state-3", "user-1", "gmail", "t")

    async def _noop(*args):
        return None

    monkeypatch.setattr(email_oauth_router, "handle_oauth_callback", _noop)

    client.get("/email-oauth/gmail/callback", params={"code": "c", "state": "state-3"})
    resp = client.get("/email-oauth/gmail/callback", params={"code": "c", "state": "state-3"})

    assert "failed" in resp.text.lower()


def test_callback_rejects_unknown_state(client):
    resp = client.get("/email-oauth/gmail/callback", params={"code": "c", "state": "does-not-exist"})
    assert "failed" in resp.text.lower()


def test_callback_rejects_provider_mismatch(client):
    db.create_oauth_state("state-4", "user-1", "gmail", "t")
    resp = client.get("/email-oauth/microsoft/callback", params={"code": "c", "state": "state-4"})
    assert "failed" in resp.text.lower()
