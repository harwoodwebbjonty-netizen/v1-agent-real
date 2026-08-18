"""Tests for list campaigns targeting an arbitrary hand-picked set of leads
(lead_ids) as an alternative to a saved list (list_id) — added for the
Outreach merge (v0.6.24) so "select a few specific leads" reuses the exact
same generation pipeline (instruction-building, campaign link, signature)
as "pick a whole list", instead of a client-side reimplementation of that
backend-only logic. See migration 039 and db.list_campaign_lead_ids_without_draft."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.responses import JSONResponse

from app import db
from app.core.config import get_settings
from app.core.rate_limit import limiter
from app.dependencies import CurrentUser, get_current_user


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


def _mk_lead(company="Acme", owner="user-1", list_id=None):
    lid = db.secrets.token_hex(8)
    db.create_lead(
        id=lid, timestamp="t", company=company, phone_number="", source_url="",
        status="u", notes="", owner_user_id=owner, created_at="t", list_id=list_id,
    )
    return lid


# --- db layer ---

def test_create_list_campaign_stores_lead_ids_json(isolated_db):
    db.create_list_campaign(
        id="c1", list_id="", owner_user_id="user-1", name="Ad-hoc", idea="idea",
        offers="", link_url="", link_text="", signature="", total_target=2,
        created_at="t", lead_ids_json=json.dumps(["l1", "l2"]),
    )
    row = db.get_list_campaign("c1")
    assert row["list_id"] == ""
    assert json.loads(row["lead_ids_json"]) == ["l1", "l2"]


def test_missing_drafts_list_based_path_unchanged(isolated_db):
    lead_a = _mk_lead("A", list_id="list-1")
    lead_b = _mk_lead("B", list_id="list-1")
    db.create_list_campaign(
        id="c1", list_id="list-1", owner_user_id="user-1", name="List camp", idea="idea",
        offers="", link_url="", link_text="", signature="", total_target=2, created_at="t",
    )
    db.create_email_draft(
        id="d1", lead_id=lead_a, owner_user_id="user-1",
        fields={"subject": "s", "body": "b", "tone": "Custom", "length": "Medium", "campaign_id": "c1"},
        created_at="t",
    )

    missing = db.list_campaign_lead_ids_without_draft("c1", "list-1", "")

    assert missing == [lead_b]


def test_missing_drafts_ad_hoc_path(isolated_db):
    lead_a = _mk_lead("A")
    lead_b = _mk_lead("B")
    lead_ids_json = json.dumps([lead_a, lead_b])
    db.create_list_campaign(
        id="c1", list_id="", owner_user_id="user-1", name="Ad-hoc", idea="idea",
        offers="", link_url="", link_text="", signature="", total_target=2,
        created_at="t", lead_ids_json=lead_ids_json,
    )
    db.create_email_draft(
        id="d1", lead_id=lead_a, owner_user_id="user-1",
        fields={"subject": "s", "body": "b", "tone": "Custom", "length": "Medium", "campaign_id": "c1"},
        created_at="t",
    )

    missing = db.list_campaign_lead_ids_without_draft("c1", "", lead_ids_json)

    assert missing == [lead_b]


def test_missing_drafts_ad_hoc_path_no_leads(isolated_db):
    assert db.list_campaign_lead_ids_without_draft("c1", "", "") == []


# --- router layer ---

@pytest.fixture
def client(isolated_db):
    from app.routers import list_campaigns as list_campaigns_router

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(
        RateLimitExceeded, lambda r, e: JSONResponse({"detail": "rate limited"}, status_code=429)
    )
    app.add_middleware(SlowAPIMiddleware)
    app.include_router(list_campaigns_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(id="user-1", name="Rep", role="member")
    get_settings.cache_clear()
    yield TestClient(app)
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def test_create_campaign_requires_list_or_leads(client):
    resp = client.post("/list-campaigns", json={"idea": "Introduce our services"})
    assert resp.status_code == 400
    assert "list or select" in resp.json()["detail"].lower()


def test_create_campaign_requires_idea(client):
    resp = client.post("/list-campaigns", json={"lead_ids": ["l1"], "idea": ""})
    assert resp.status_code == 400
    assert "idea" in resp.json()["detail"].lower()
