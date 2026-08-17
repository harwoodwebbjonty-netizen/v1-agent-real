"""Tests for saved/shared filter views (Stage 3 roadmap item) — db-layer
CRUD and the /saved-views router endpoints including sharing visibility
and delete permissions."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.dependencies import CurrentUser, get_current_user

# Deferred (not module-level): app.routers.saved_views imports
# app.routers.leads, which pulls in schemas_leads.py's `X | None` syntax
# (3.10+). See test_lead_tags.py for the same pattern/reasoning.


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


# --- db-layer ---

def test_create_and_get_saved_view(isolated_db):
    db.create_saved_view(
        id="v1", user_id="user-1", name="Hot leads", is_shared=False,
        filters_json='{"search": "acme"}', created_at="t",
    )

    row = db.get_saved_view("v1")

    assert row["name"] == "Hot leads"
    assert row["user_id"] == "user-1"
    assert row["is_shared"] == 0
    assert row["filters_json"] == '{"search": "acme"}'


def test_list_saved_views_includes_own_and_shared(isolated_db):
    db.create_saved_view(id="v1", user_id="user-1", name="Mine", is_shared=False, filters_json="{}", created_at="t")
    db.create_saved_view(id="v2", user_id="user-2", name="Shared by other", is_shared=True, filters_json="{}", created_at="t")
    db.create_saved_view(id="v3", user_id="user-2", name="Other's private", is_shared=False, filters_json="{}", created_at="t")

    rows = db.list_saved_views("user-1")

    names = {r["name"] for r in rows}
    assert names == {"Mine", "Shared by other"}


def test_delete_saved_view(isolated_db):
    db.create_saved_view(id="v1", user_id="user-1", name="Mine", is_shared=False, filters_json="{}", created_at="t")

    db.delete_saved_view("v1")

    assert db.get_saved_view("v1") is None


# --- router layer ---

@pytest.fixture
def client(isolated_db):
    from app.routers import saved_views as saved_views_router

    app = FastAPI()
    app.include_router(saved_views_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="user-1", name="Rep", role="member"
    )
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_create_saved_view_via_api(client):
    resp = client.post(
        "/saved-views",
        json={"name": "Hot leads", "is_shared": True, "filters": {"search": "acme", "industries": ["Software"]}},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "Hot leads"
    assert body["is_shared"] is True
    assert body["owner_user_id"] == "user-1"
    assert body["filters"] == {"search": "acme", "industries": ["Software"]}


def test_create_saved_view_rejects_empty_name(client):
    resp = client.post("/saved-views", json={"name": "   ", "is_shared": False, "filters": {}})
    assert resp.status_code == 422


def test_list_saved_views_via_api(client):
    db.create_saved_view(id="v1", user_id="user-1", name="Mine", is_shared=False, filters_json="{}", created_at="t")
    db.create_saved_view(id="v2", user_id="user-2", name="Shared", is_shared=True, filters_json="{}", created_at="t")
    db.create_saved_view(id="v3", user_id="user-2", name="Not visible", is_shared=False, filters_json="{}", created_at="t")

    resp = client.get("/saved-views")

    names = {v["name"] for v in resp.json()["views"]}
    assert names == {"Mine", "Shared"}


def test_delete_own_saved_view_via_api(client):
    db.create_saved_view(id="v1", user_id="user-1", name="Mine", is_shared=False, filters_json="{}", created_at="t")

    resp = client.delete("/saved-views/v1")

    assert resp.status_code == 200
    assert db.get_saved_view("v1") is None


def test_delete_others_saved_view_forbidden(client):
    """A member can't delete a view owned by someone else, even if it's shared."""
    db.create_saved_view(id="v1", user_id="user-2", name="Not mine", is_shared=True, filters_json="{}", created_at="t")

    resp = client.delete("/saved-views/v1")

    assert resp.status_code == 403
    assert db.get_saved_view("v1") is not None


def test_delete_unknown_saved_view_404(client):
    resp = client.delete("/saved-views/does-not-exist")
    assert resp.status_code == 404


@pytest.fixture
def admin_client(isolated_db):
    from app.routers import saved_views as saved_views_router

    app = FastAPI()
    app.include_router(saved_views_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="admin-1", name="Admin", role="admin"
    )
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_admin_can_delete_any_saved_view(admin_client):
    db.create_saved_view(id="v1", user_id="user-2", name="Someone's view", is_shared=False, filters_json="{}", created_at="t")

    resp = admin_client.delete("/saved-views/v1")

    assert resp.status_code == 200
    assert db.get_saved_view("v1") is None
