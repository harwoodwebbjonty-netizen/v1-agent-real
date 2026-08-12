"""Regression tests for the audit-log coverage gaps flagged by the audit
(06-saas-security-scalability.md §4): user creation/deletion/password-reset
and the outbound-email-sending surface (win-back, list-campaign sends) had
no audit trail at all before this — only role/credit-limit changes did."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.routers import users as users_router
from app.services.auth_service import hash_password


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


@pytest.fixture
def client(isolated_db):
    db.create_user("admin-1", "Admin", "admin", "t", password_hash=hash_password("adminpassword1"))

    app = FastAPI()
    app.include_router(users_router.router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="admin-1", name="Admin", role="admin"
    )
    yield TestClient(app)
    app.dependency_overrides.clear()


def _last_audit_entry():
    entries = db.list_audit_log(limit=1)
    assert entries, "expected an audit_log row but found none"
    return entries[0]


def test_create_user_is_audited(client):
    resp = client.post("/users", json={"name": "New Rep", "role": "member"})
    assert resp.status_code == 200
    user_id = resp.json()["id"]

    entry = _last_audit_entry()
    assert entry["actor_id"] == "admin-1"
    assert entry["action"] == "create"
    assert entry["entity_type"] == "user"
    assert entry["entity_id"] == user_id
    assert entry["detail"] == "New Rep"


def test_delete_user_is_audited(client):
    db.create_user("u-2", "Departing Rep", "member", "t", password_hash=hash_password("longenough1"))

    resp = client.delete("/users/u-2")
    assert resp.status_code == 200

    entry = _last_audit_entry()
    assert entry["action"] == "delete"
    assert entry["entity_type"] == "user"
    assert entry["entity_id"] == "u-2"
    assert entry["detail"] == "Departing Rep"


def test_set_password_is_audited_without_leaking_the_password(client):
    db.create_user("u-3", "Some Rep", "member", "t", password_hash=hash_password("oldpassword1"))

    resp = client.post("/users/u-3/set-password", json={"password": "brandnewpassword1"})
    assert resp.status_code == 200

    entry = _last_audit_entry()
    assert entry["action"] == "set_password"
    assert entry["entity_type"] == "user"
    assert entry["entity_id"] == "u-3"
    # The password itself must never end up in the audit trail.
    assert "brandnewpassword1" not in entry["detail"]
    assert entry["detail"] == ""


def test_avatar_change_still_not_audited_by_design(client):
    """Confirms the scope of this fix — avatar changes remain unaudited
    (a low-signal, low-risk action, unlike create/delete/password-reset)
    rather than silently regressing this test if that ever changes without
    being a deliberate decision."""
    db.create_user("u-4", "Rep", "member", "t", password_hash=hash_password("longenough1"))
    before = len(db.list_audit_log(limit=1000))

    resp = client.patch("/users/u-4/avatar", json={"avatar": "data:image/png;base64,Zm9v"})
    assert resp.status_code == 200

    after = len(db.list_audit_log(limit=1000))
    assert after == before
