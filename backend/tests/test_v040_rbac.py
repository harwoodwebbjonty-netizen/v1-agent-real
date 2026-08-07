"""Tests for the v0.4.0 RBAC: roles model, permission resolution, and the
server-side lead-scope enforcement that a BDE-style role relies on."""

import json

import pytest

from app import db
from app.core.permissions import ALL_PERMISSIONS, MEMBER_PERMISSIONS
from app.services.permission_service import resolve_user_access


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


def _mk_lead(company, owner, shared=True, assignee=None):
    lid = db.create_lead(
        id=db.secrets.token_hex(8), timestamp="t", company=company, phone_number="",
        source_url="", status="u", notes="", owner_user_id=owner, created_at="t",
    )
    db.set_lead_shared(lid, shared, "t")
    if assignee:
        db.assign_lead(lid, assignee, "t")
    return lid


def test_seeds_builtin_roles_and_default(isolated_db):
    names = {r["name"] for r in db.list_roles()}
    assert names == {"Admin", "Member"}
    assert db.get_default_role()["name"] == "Member"
    admin = db.get_role("role-admin")
    assert set(json.loads(admin["permissions"])) == set(ALL_PERMISSIONS)


def test_existing_users_mapped_on_upgrade(isolated_db):
    # Simulate a pre-RBAC user then re-run the roles migration mapping.
    db.create_user("u", "Bob", "member", "t", password_hash="x")
    with db.get_connection() as c:
        c.execute("UPDATE users SET role_id = NULL WHERE id='u'")
        # The migration's mapping step (idempotent) maps by role string:
        c.execute("UPDATE users SET role_id='role-member' WHERE role!='admin' AND (role_id IS NULL OR role_id='')")
    assert db.get_user_by_id("u")["role_id"] == "role-member"


def test_resolution(isolated_db):
    db.create_user("a", "Alice", "admin", "t", password_hash="x")
    db.set_user_role("a", "role-admin")
    perms, scope, name = resolve_user_access(db.get_user_by_id("a"))
    assert perms == frozenset(ALL_PERMISSIONS) and scope == "all_shared" and name == "Admin"

    db.create_user("m", "Bob", "member", "t", password_hash="x")
    db.set_user_role("m", "role-member")
    perms, scope, name = resolve_user_access(db.get_user_by_id("m"))
    assert perms == frozenset(MEMBER_PERMISSIONS) and name == "Member"

    db.create_role("role-bde", "BDE", json.dumps(["view_leads", "send_email"]), "own_assigned", "t")
    db.create_user("c", "Carol", "member", "t", password_hash="x")
    db.set_user_role("c", "role-bde")
    perms, scope, name = resolve_user_access(db.get_user_by_id("c"))
    assert perms == frozenset(["view_leads", "send_email"]) and scope == "own_assigned" and name == "BDE"


def test_lead_scope_enforced(isolated_db):
    shared = _mk_lead("SharedCo", "alice")
    own = _mk_lead("BobOwn", "bob")
    assigned = _mk_lead("Assigned", "alice", assignee="bob")

    all_ids = {r["id"] for r in db.list_all_leads_for_user("bob", False, "all_shared")}
    assert {shared, own, assigned} <= all_ids

    own_ids = {r["id"] for r in db.list_all_leads_for_user("bob", False, "own_assigned")}
    assert own in own_ids and assigned in own_ids and shared not in own_ids


def test_delete_role_reassigns_users(isolated_db):
    db.create_role("role-x", "Temp", json.dumps(["view_leads"]), "all_shared", "t")
    db.create_user("u", "U", "member", "t", password_hash="x")
    db.set_user_role("u", "role-x")
    # emulate the router: reassign then delete
    default = db.get_default_role()
    with db.get_connection() as conn:
        conn.execute("UPDATE users SET role_id=? WHERE role_id='role-x'", (default["id"],))
    db.delete_role("role-x")
    assert db.get_role("role-x") is None
    assert db.get_user_by_id("u")["role_id"] == default["id"]


def test_system_roles_not_deletable(isolated_db):
    db.delete_role("role-admin")  # guarded by is_system=0 in the WHERE
    db.delete_role("role-member")
    names = {r["name"] for r in db.list_roles()}
    assert {"Admin", "Member"} <= names
