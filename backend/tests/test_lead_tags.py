"""Tests for freeform lead tags (Stage 3 roadmap item) — the db-layer CRUD
+ batch lookup, and the /leads/{id}/tags router endpoints including auth
and validation."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.dependencies import CurrentUser, get_current_user

# Deferred (not a module-level import): app.routers.leads pulls in
# schemas_leads.py, which uses `X | None` union syntax requiring Python
# 3.10+. CI (backend-tests.yml) runs 3.11, so this is fine there — but
# keeping the import out of this file's top level means the db-layer tests
# below can still be collected and run under an older local interpreter
# instead of the whole file failing to collect.


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


def _mk_lead(company="Acme", owner="user-1"):
    lid = db.secrets.token_hex(8)
    db.create_lead(
        id=lid, timestamp="t", company=company, phone_number="", source_url="",
        status="u", notes="", owner_user_id=owner, created_at="t",
    )
    return lid


# --- db-layer ---

def test_add_list_delete_tag(isolated_db):
    lead_id = _mk_lead()
    db.add_tag(id="tag-1", lead_id=lead_id, tag="hot-lead", created_at="t")
    db.add_tag(id="tag-2", lead_id=lead_id, tag="renewal", created_at="t")

    assert db.list_tags(lead_id) == ["hot-lead", "renewal"]

    db.delete_tag(lead_id, "hot-lead")
    assert db.list_tags(lead_id) == ["renewal"]


def test_add_tag_is_idempotent_on_duplicate(isolated_db):
    """INSERT OR IGNORE + UNIQUE(lead_id, tag) — re-adding the same tag is a
    harmless no-op, matching add_phone_ignore_duplicate's pattern, not an error."""
    lead_id = _mk_lead()
    db.add_tag(id="tag-1", lead_id=lead_id, tag="hot-lead", created_at="t")
    db.add_tag(id="tag-2", lead_id=lead_id, tag="hot-lead", created_at="t")

    assert db.list_tags(lead_id) == ["hot-lead"]


def test_get_tags_for_leads_batch(isolated_db):
    lead_a = _mk_lead("A")
    lead_b = _mk_lead("B")
    lead_c = _mk_lead("C")  # no tags at all
    db.add_tag(id="t1", lead_id=lead_a, tag="hot", created_at="t")
    db.add_tag(id="t2", lead_id=lead_a, tag="renewal", created_at="t")
    db.add_tag(id="t3", lead_id=lead_b, tag="cold", created_at="t")

    result = db.get_tags_for_leads([lead_a, lead_b, lead_c])

    assert result[lead_a] == ["hot", "renewal"]
    assert result[lead_b] == ["cold"]
    assert result[lead_c] == []


def test_get_tags_for_leads_empty_input(isolated_db):
    assert db.get_tags_for_leads([]) == {}


# --- router layer ---

@pytest.fixture
def client(isolated_db):
    from app.routers import leads as leads_router

    app = FastAPI()
    app.include_router(leads_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="user-1", name="Rep", role="admin"
    )
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_add_tag_via_api_returns_lead_with_tag(client):
    lead_id = _mk_lead()

    resp = client.post(f"/leads/{lead_id}/tags", json={"tag": "hot-lead"})

    assert resp.status_code == 200
    assert resp.json()["tags"] == ["hot-lead"]


def test_delete_tag_via_api(client):
    lead_id = _mk_lead()
    db.add_tag(id="t1", lead_id=lead_id, tag="hot-lead", created_at="t")

    resp = client.delete(f"/leads/{lead_id}/tags/hot-lead")

    assert resp.status_code == 200
    assert resp.json()["tags"] == []


def test_add_tag_rejects_empty(client):
    lead_id = _mk_lead()

    resp = client.post(f"/leads/{lead_id}/tags", json={"tag": "   "})

    assert resp.status_code == 422


def test_add_tag_rejects_too_long(client):
    lead_id = _mk_lead()

    resp = client.post(f"/leads/{lead_id}/tags", json={"tag": "x" * 41})

    assert resp.status_code == 422


def test_add_tag_404_on_unknown_lead(client):
    resp = client.post("/leads/does-not-exist/tags", json={"tag": "hot"})
    assert resp.status_code == 404


def test_list_leads_includes_tags(client):
    lead_id = _mk_lead()
    db.add_tag(id="t1", lead_id=lead_id, tag="hot-lead", created_at="t")

    resp = client.get("/leads")

    assert resp.status_code == 200
    lead = next(l for l in resp.json()["leads"] if l["id"] == lead_id)
    assert lead["tags"] == ["hot-lead"]
