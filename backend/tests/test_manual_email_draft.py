"""Tests for the manual (non-AI) email draft endpoint — lets a rep start a
draft without spending a generation call, since Save/Send/Preview in the
frontend all key off a draft_id that previously only ever came from AI
generation. See POST /leads/{lead_id}/email-drafts/manual in email_writer.py.

Router import is deferred into the fixture (not module-level) because
email_writer.py transitively imports app.routers.leads, which uses `X | None`
union syntax requiring Python 3.10+ — this Mac's .venv is 3.9. Matches the
existing pattern in test_custom_fields.py / test_lead_tags.py. CI runs 3.11
and is the real verification path for these."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.dependencies import CurrentUser, get_current_user


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


def _mk_lead(owner="user-1"):
    lid = db.secrets.token_hex(8)
    db.create_lead(
        id=lid, timestamp="t", company="Acme", phone_number="", source_url="",
        status="u", notes="", owner_user_id=owner, created_at="t",
    )
    return lid


@pytest.fixture
def client(isolated_db):
    from app.routers import email_writer as email_writer_router

    app = FastAPI()
    app.include_router(email_writer_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(id="user-1", name="Rep", role="member")
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_create_manual_draft_returns_blank_draft(client):
    lead_id = _mk_lead()

    resp = client.post(f"/leads/{lead_id}/email-drafts/manual")

    assert resp.status_code == 200
    body = resp.json()
    assert body["lead_id"] == lead_id
    assert body["subject"] == ""
    assert body["body"] == ""
    assert body["status"] == "draft"


def test_create_manual_draft_no_credit_spend(client):
    lead_id = _mk_lead()

    client.post(f"/leads/{lead_id}/email-drafts/manual")

    allowed, spent, _ = db.check_credit_limit("user-1", "email_writer")
    assert allowed is True
    assert spent == 0


def test_create_manual_draft_then_update_and_send_path_exists(client):
    """The manual draft's id must work with the ordinary update endpoint —
    that's the entire point (Save/Send only require a draft_id to exist)."""
    lead_id = _mk_lead()
    draft_id = client.post(f"/leads/{lead_id}/email-drafts/manual").json()["id"]

    resp = client.patch(f"/email-drafts/{draft_id}", json={"subject": "Hi", "body": "Hand-written body"})

    assert resp.status_code == 200
    assert resp.json()["subject"] == "Hi"
    assert resp.json()["body"] == "Hand-written body"


def test_create_manual_draft_404_on_unknown_lead(client):
    resp = client.post("/leads/does-not-exist/email-drafts/manual")
    assert resp.status_code == 404
