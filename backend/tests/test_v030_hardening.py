"""Tests for the v0.3.0 hardening: auth, optional-sharing access, ingest
integrity, batched reads, audit log, and SQL-guard. Encodes the checks that
were smoke-verified during development so CI keeps them honest."""

import sqlite3

import pytest

from app import db
from app.services.auth_service import lock_until_iso, is_expired


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


def _mk_lead(company, owner, list_id=None, shared=True, assignee=None, number=None):
    lid = db.create_lead(
        id=db.secrets.token_hex(8), timestamp="t", company=company, phone_number="",
        source_url="", status="unverified", notes="", owner_user_id=owner,
        created_at="t", list_id=list_id, company_number=number,
    )
    db.set_lead_shared(lid, shared, "t")
    if assignee:
        db.assign_lead(lid, assignee, "t")
    return lid


def test_schema_at_current_version(isolated_db):
    with db.get_connection() as c:
        assert c.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        indexes = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    assert {"oauth_states", "app_flags", "audit_log"} <= tables
    assert {"idx_leads_list_id", "idx_leads_owner", "idx_leads_company_number", "idx_leads_company_norm"} <= indexes


def test_login_lockout_counters_and_session_revoke(isolated_db):
    db.create_user("u", "Bob", "member", "t", password_hash="x")
    db.record_login_failure("u", None)
    db.record_login_failure("u", lock_until_iso(15))
    row = db.get_user_by_id("u")
    assert row["failed_login_attempts"] == 2
    assert row["locked_until"] and not is_expired(row["locked_until"])
    db.reset_login_failures("u")
    assert db.get_user_by_id("u")["failed_login_attempts"] == 0

    db.create_session("a", "u", "t", "t")
    db.create_session("b", "u", "t", "t")
    db.delete_other_sessions_for_user("u", keep_token="a")
    assert db.get_session("a") is not None and db.get_session("b") is None


def test_oauth_state_is_single_use(isolated_db):
    db.create_oauth_state("nonce", "u", "gmail", "t")
    row = db.consume_oauth_state("nonce")
    assert row is not None and row["user_id"] == "u"
    assert db.consume_oauth_state("nonce") is None


def test_slim_roster_has_no_ids_or_roles(isolated_db):
    db.create_user("u", "Bob", "admin", "t", password_hash="x")
    rows = db.list_user_display_names()
    assert set(rows[0].keys()) == {"name", "avatar"}


def test_optional_sharing_visibility(isolated_db):
    shared = _mk_lead("SharedCo", "alice")
    private = _mk_lead("PrivateCo", "alice", shared=False)
    assigned = _mk_lead("AssignedCo", "alice", shared=False, assignee="bob")

    bob_ids = {r["id"] for r in db.list_all_leads_for_user("bob", is_admin=False)}
    assert shared in bob_ids and assigned in bob_ids and private not in bob_ids

    admin_ids = {r["id"] for r in db.list_all_leads_for_user("alice", is_admin=True)}
    assert {shared, private, assigned} <= admin_ids


def test_index_backed_dedup(isolated_db):
    a = _mk_lead("Acme Ltd", "u")
    b = _mk_lead("  ACME LTD ", "u")
    assert a == b  # normalised company dedup
    n1 = _mk_lead("Beta One", "u", number="12345678")
    n2 = _mk_lead("Beta Renamed", "u", number="12345678")
    assert n1 == n2  # company_number dedup


def test_merge_reparents_all_children_and_fk_blocks_orphans(isolated_db):
    winner = _mk_lead("Winner", "u")
    loser = _mk_lead("Loser", "u")
    with db.get_connection() as c:
        c.execute("INSERT INTO lead_linkedin_posts (id, lead_id, linkedin_url, posts_json, created_at) VALUES (?,?,?,?,?)",
                  ("p", loser, "u", "[]", "t"))
        c.execute("INSERT INTO ch_charge_feed (id, company_number, filing_type, detected_at, lead_id) VALUES (?,?,?,?,?)",
                  ("cf", "0", "create", "t", loser))
        c.execute("INSERT INTO win_back_campaigns (id, name, created_by, created_at) VALUES (?,?,?,?)", ("camp", "C", "u", "t"))
        c.execute("INSERT INTO win_back_emails (id, campaign_id, lead_id, created_at) VALUES (?,?,?,?)", ("wb", "camp", loser, "t"))
    db.merge_lead_into(winner, loser, "t")
    with db.get_connection() as c:
        for t in ("lead_linkedin_posts", "win_back_emails", "ch_charge_feed"):
            assert c.execute(f"SELECT COUNT(*) FROM {t} WHERE lead_id=?", (loser,)).fetchone()[0] == 0
            assert c.execute(f"SELECT COUNT(*) FROM {t} WHERE lead_id=?", (winner,)).fetchone()[0] == 1
    with pytest.raises(sqlite3.IntegrityError):
        with db.get_connection() as c:
            c.execute("INSERT INTO win_back_emails (id, campaign_id, lead_id, created_at) VALUES (?,?,?,?)",
                      ("bad", "no-such-campaign", winner, "t"))


def test_delete_user_nulls_ownership(isolated_db):
    db.create_user("uid", "Temp", "member", "t", password_hash="x")
    lid = _mk_lead("Owned", "uid", shared=False, assignee="uid")
    db.delete_user("uid")
    with db.get_connection() as c:
        row = c.execute("SELECT owner_user_id, assigned_user_id FROM leads WHERE id=?", (lid,)).fetchone()
    assert row is not None and row["owner_user_id"] is None and row["assigned_user_id"] is None


def test_audit_log(isolated_db):
    db.record_audit("u1", "Alice", "update", "lead", "L1", detail="industry")
    db.record_audit("u2", "Bob", "assign", "lead", "L2")
    rows = db.list_audit_log()
    assert len(rows) == 2 and rows[0]["actor_name"] == "Bob" and rows[0]["action"] == "assign"


def test_batched_read_helpers(isolated_db):
    lid = _mk_lead("Co", "u")
    db.add_phone("ph", lid, "111", "manual", "t")
    db.add_email("em", lid, "a@x.com", "manual", "t")
    assert len(db.get_phones_for_leads([lid])[lid]) == 1
    assert len(db.get_emails_for_leads([lid])[lid]) == 1
    # empty input is safe
    assert db.get_phones_for_leads([]) == {}


def test_sql_column_guard(isolated_db):
    db._assert_safe_columns({"contact_status": "x", "lead_notes": "y"})
    with pytest.raises(ValueError):
        db._assert_safe_columns({"x=1; DROP TABLE leads--": 1})
