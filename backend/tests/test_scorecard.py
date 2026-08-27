"""Tests for the weekly BDE performance scorecard (merged in from the
standalone wcf-scorecard.web.app Firebase app — see PROJECT_CONTEXT.md).
Covers db-layer CRUD, the /scorecard router (permissions, week validation,
auto-tracking merge for Qualified Leads Passed / Mass Email Campaigns), and
the one-off Firestore migration tool. `routers/scorecard.py` doesn't import
`app.routers.leads`, so — unlike test_custom_fields.py/test_lead_tags.py —
most fixtures here import it at module level; only the update_lead hook
test needs the deferred-import pattern, since that one does touch leads.py
(schemas_leads.py's `X | None` syntax needs Python 3.10+, so that one test
only collects on CI, not this repo's local 3.9 venv)."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.routers import scorecard as scorecard_router
from app.services import scorecard_service


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


def _mk_user(user_id="u1", name="Rep One"):
    with db.get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO users (id, name, role, created_at) VALUES (?, ?, 'member', 't')",
            (user_id, name),
        )


@pytest.fixture
def client(isolated_db):
    app = FastAPI()
    app.include_router(scorecard_router.router)
    yield app, TestClient(app)


def _as(app, user):
    app.dependency_overrides[get_current_user] = lambda: user
    return app


MEMBER = CurrentUser(id="u1", name="Rep One", role="member", permissions=frozenset({"view_scorecard"}))
MANAGER = CurrentUser(id="mgr", name="Manager", role="member", permissions=frozenset({"view_scorecard", "view_scorecard_manager"}))
ADMIN = CurrentUser(id="admin1", name="Admin", role="admin", permissions=frozenset())


# --- db-layer: weeks/entries CRUD ---


def test_create_and_get_scorecard_week(isolated_db):
    db.create_scorecard_week("w1", "u1", "2026-08-24", "t", "t")
    row = db.get_scorecard_week("u1", "2026-08-24")
    assert row["id"] == "w1"
    assert row["saved_at"] is None


def test_upsert_scorecard_entry_then_update(isolated_db):
    db.create_scorecard_week("w1", "u1", "2026-08-24", "t", "t")
    db.upsert_scorecard_entry("e1", "w1", "calls", 100.0, "n", "a", "manual", "t1")
    db.upsert_scorecard_entry("e2", "w1", "calls", 150.0, "n2", "", "manual", "t2")

    entries = {e["metric_key"]: dict(e) for e in db.list_scorecard_entries_for_week("w1")}
    assert entries["calls"]["actual"] == 150.0
    assert entries["calls"]["notes"] == "n2"


def test_mark_scorecard_week_saved(isolated_db):
    db.create_scorecard_week("w1", "u1", "2026-08-24", "t", "t")
    db.mark_scorecard_week_saved("w1", "2026-08-25T10:00:00")
    assert db.get_scorecard_week("u1", "2026-08-24")["saved_at"] == "2026-08-25T10:00:00"


def test_default_targets_seeded_on_migration(isolated_db):
    targets = {t["metric_key"]: dict(t) for t in db.list_scorecard_metric_targets()}
    assert targets["calls"]["target_value"] == 675.0
    assert targets["leads"]["auto_tracked"] == 1
    assert targets["campaigns"]["auto_tracked"] == 1
    assert targets["calls"]["auto_tracked"] == 0
    assert targets["talk_time"]["auto_tracked"] == 0


def test_default_permissions_seeded_on_migration(isolated_db):
    with db.get_connection() as conn:
        member_perms = conn.execute("SELECT permissions FROM roles WHERE id = 'role-member'").fetchone()["permissions"]
        admin_perms = conn.execute("SELECT permissions FROM roles WHERE id = 'role-admin'").fetchone()["permissions"]
    assert "view_scorecard" in member_perms
    assert "view_scorecard_manager" not in member_perms
    assert "view_scorecard_manager" in admin_perms


# --- validation ---


def test_validate_week_commencing_rejects_non_monday():
    with pytest.raises(ValueError):
        scorecard_service.validate_week_commencing("2026-08-25")  # a Tuesday


def test_validate_week_commencing_accepts_monday():
    assert scorecard_service.validate_week_commencing("2026-08-24") == "2026-08-24"


# --- router: settings ---


def test_member_can_read_settings_but_not_write(client):
    app, http = client
    _as(app, MEMBER)
    assert http.get("/scorecard/settings").status_code == 200
    resp = http.put("/scorecard/settings", json={"green_threshold": 90})
    assert resp.status_code == 403


def test_manager_can_update_settings_and_targets(client):
    app, http = client
    _as(app, MANAGER)
    resp = http.put("/scorecard/settings", json={"green_threshold": 90, "notes_visibility": "team", "targets": {"calls": 700}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["green_threshold"] == 90
    assert body["notes_visibility"] == "team"
    assert next(t["target_value"] for t in body["targets"] if t["metric_key"] == "calls") == 700


# --- router: weeks (own vs other, notes visibility) ---


def test_member_can_edit_own_week(client):
    app, http = client
    _as(app, MEMBER)
    resp = http.put("/scorecard/weeks/u1/2026-08-24", json={"entries": {"calls": {"actual": 42, "notes": "", "action": ""}}})
    assert resp.status_code == 200
    assert resp.json()["entries"]["calls"]["actual"] == 42.0
    assert resp.json()["entries"]["calls"]["source"] == "manual"


def test_member_cannot_edit_others_week(client):
    app, http = client
    _as(app, MEMBER)
    resp = http.put("/scorecard/weeks/mgr/2026-08-24", json={"entries": {"calls": {"actual": 1, "notes": "", "action": ""}}})
    assert resp.status_code == 403


def test_week_commencing_must_be_a_monday(client):
    app, http = client
    _as(app, MEMBER)
    resp = http.put("/scorecard/weeks/u1/2026-08-25", json={"entries": {}})
    assert resp.status_code == 400


def test_member_cannot_view_others_week_by_default(client):
    app, http = client
    _as(app, MEMBER)
    resp = http.get("/scorecard/weeks", params={"user_id": "mgr"})
    assert resp.status_code == 403


def test_member_can_view_others_week_when_visibility_is_team(client):
    app, http = client
    _as(app, MANAGER)
    http.put("/scorecard/settings", json={"notes_visibility": "team"})
    _as(app, MEMBER)
    resp = http.get("/scorecard/weeks", params={"user_id": "mgr"})
    assert resp.status_code == 200


def test_manager_can_view_and_edit_others_week(client):
    app, http = client
    _as(app, MANAGER)
    resp = http.put("/scorecard/weeks/u1/2026-08-24", json={"entries": {"calls": {"actual": 10, "notes": "", "action": ""}}})
    assert resp.status_code == 200
    resp = http.get("/scorecard/weeks", params={"user_id": "u1"})
    assert resp.status_code == 200


def test_save_week_sets_saved_at_without_locking_edits(client):
    app, http = client
    _as(app, MEMBER)
    http.put("/scorecard/weeks/u1/2026-08-24", json={"entries": {"calls": {"actual": 10, "notes": "", "action": ""}}})
    saved = http.post("/scorecard/weeks/u1/2026-08-24/save").json()
    assert saved["saved_at"] is not None

    # still editable after "saving" — no history/lock split, per user decision
    resp = http.put("/scorecard/weeks/u1/2026-08-24", json={"entries": {"calls": {"actual": 20, "notes": "", "action": ""}}})
    assert resp.status_code == 200
    assert resp.json()["entries"]["calls"]["actual"] == 20.0
    assert resp.json()["saved_at"] is not None  # save marker survives the edit


def test_delete_week_removes_it_and_its_entries(isolated_db, client):
    app, http = client
    _as(app, MEMBER)
    http.put("/scorecard/weeks/u1/2026-08-24", json={"entries": {"calls": {"actual": 10, "notes": "", "action": ""}}})
    assert db.get_scorecard_week("u1", "2026-08-24") is not None

    resp = http.delete("/scorecard/weeks/u1/2026-08-24")
    assert resp.status_code == 200
    assert db.get_scorecard_week("u1", "2026-08-24") is None

    resp = http.delete("/scorecard/weeks/u1/2026-08-24")
    assert resp.status_code == 404


def test_member_cannot_delete_others_week(client):
    app, http = client
    _as(app, MANAGER)
    http.put("/scorecard/weeks/mgr/2026-08-24", json={"entries": {"calls": {"actual": 10, "notes": "", "action": ""}}})
    _as(app, MEMBER)
    resp = http.delete("/scorecard/weeks/mgr/2026-08-24")
    assert resp.status_code == 403


# --- auto-tracking: Qualified Leads Passed + Mass Email Campaigns ---


def _seed_qualifying_history(isolated_db):
    _mk_user("u1", "Rep One")
    _mk_user("u2", "Rep Two")
    db.record_lead_status_change("h1", "l1", "opportunity_stage", "engaged", "opportunity", "u1", "2026-08-24T10:00:00")
    # re-touching an already-qualified lead later in the same week must not double-count
    db.record_lead_status_change("h2", "l1", "opportunity_stage", "opportunity", "proposal", "u1", "2026-08-26T10:00:00")
    db.record_lead_status_change("h3", "l2", "opportunity_stage", "engaged", "opportunity", "u1", "2026-08-25T10:00:00")
    db.record_lead_status_change("h4", "l3", "opportunity_stage", "engaged", "opportunity", "u2", "2026-09-01T10:00:00")
    # an unrelated field change must not count toward "leads"
    db.record_lead_status_change("h5", "l1", "contact_status", "Contacted", "Replied", "u1", "2026-08-24T11:00:00")

    with db.get_connection() as conn:
        for draft_id, lead_id, campaign_id, sent_at, status in (
            ("d1", "l1", "c1", "2026-08-24T12:00:00", "sent"),
            ("d2", "l2", "c1", "2026-08-25T12:00:00", "sent"),
            ("d3", "l3", "c2", "2026-08-26T12:00:00", "sent"),
            ("d4", "l1", "c3", None, "draft"),  # unsent — must not count
        ):
            conn.execute(
                "INSERT INTO email_drafts (id, lead_id, owner_user_id, subject, body, status, sent_at, campaign_id, created_at, updated_at) "
                "VALUES (?, ?, 'u1', 's', 'b', ?, ?, ?, 't', 't')",
                (draft_id, lead_id, status, sent_at, campaign_id),
            )


def test_compute_auto_values_counts_correctly_without_double_counting(isolated_db):
    _seed_qualifying_history(isolated_db)
    auto = scorecard_service.compute_auto_values()
    assert auto[("u1", "2026-08-24", "leads")] == 2.0  # l1 + l2, not 3 (l1's second touch doesn't recount)
    assert auto[("u2", "2026-08-31", "leads")] == 1.0  # week-bucketed correctly (Mon of 2026-09-01)
    assert auto[("u1", "2026-08-24", "campaigns")] == 2.0  # distinct campaigns c1, c2 — c3 excluded (unsent)


def test_get_weeks_synthesizes_auto_values_with_no_stored_row(isolated_db, client):
    _seed_qualifying_history(isolated_db)
    app, http = client
    _as(app, MEMBER)
    resp = http.get("/scorecard/weeks", params={"user_id": "u1", "since": "2026-08-24", "until": "2026-08-24"})
    assert resp.status_code == 200
    weeks = resp.json()["weeks"]
    assert len(weeks) == 1
    entries = weeks[0]["entries"]
    assert entries["leads"]["actual"] == 2.0
    assert entries["leads"]["source"] == "auto"
    assert entries["campaigns"]["actual"] == 2.0
    assert entries["campaigns"]["source"] == "auto"


def test_manual_override_wins_over_auto_value(isolated_db, client):
    _seed_qualifying_history(isolated_db)
    app, http = client
    _as(app, MEMBER)
    resp = http.put("/scorecard/weeks/u1/2026-08-24", json={"entries": {"leads": {"actual": 99, "notes": "override", "action": ""}}})
    entries = resp.json()["entries"]
    assert entries["leads"]["actual"] == 99.0
    assert entries["leads"]["source"] == "manual"
    assert entries["campaigns"]["actual"] == 2.0  # untouched metric still auto
    assert entries["campaigns"]["source"] == "auto"


def test_weeks_all_merges_manual_and_auto_across_users(isolated_db, client):
    _seed_qualifying_history(isolated_db)
    app, http = client
    _as(app, MEMBER)
    http.put("/scorecard/weeks/u1/2026-08-24", json={"entries": {"leads": {"actual": 99, "notes": "", "action": ""}}})

    resp = http.get("/scorecard/weeks/all")
    assert resp.status_code == 200
    by_key = {(e["user_id"], e["week_commencing"], e["metric_key"]): e for e in resp.json()["entries"]}
    assert by_key[("u1", "2026-08-24", "leads")]["actual"] == 99.0
    assert by_key[("u1", "2026-08-24", "leads")]["source"] == "manual"
    assert by_key[("u1", "2026-08-24", "campaigns")]["actual"] == 2.0
    assert by_key[("u1", "2026-08-24", "campaigns")]["source"] == "auto"
    # u2 never created a scorecard_weeks row at all — still surfaces from auto data alone
    assert by_key[("u2", "2026-08-31", "leads")]["actual"] == 1.0
    assert by_key[("u2", "2026-08-31", "leads")]["source"] == "auto"
    # no notes/action leak into the summary endpoint
    assert not any(hasattr(e, "notes") for e in resp.json()["entries"])


# --- one-off Firestore migration ---


SAMPLE_BACKUP = {
    "app": "wcf-scorecard",
    "store": {
        "profiles": {
            "p1": {
                "id": "p1",
                "name": "Jane Smith",
                "weekCommencing": "2026-08-24",
                "reviewDate": "",
                "rows": {"calls": {"actual": "500", "notes": "", "action": ""}, "leads": {"actual": "2", "notes": "n1", "action": "a1"}},
                "history": {
                    "2026-08-17": {
                        "weekCommencing": "2026-08-17",
                        "reviewDate": "",
                        "savedAt": "2026-08-18T10:00:00",
                        "rows": {"talkTime": {"actual": "9.5", "notes": "", "action": ""}},
                    }
                },
            },
            "p2": {"id": "p2", "name": "Unknown Person", "weekCommencing": "2026-08-24", "rows": {}, "history": {}},
        }
    },
    "settings": {"targets": {"calls": 700}, "green": 90, "amber": 80},
}


def test_migrate_preview_matches_by_name_and_flags_unknown(isolated_db):
    _mk_user("u1", "Jane Smith")
    preview = scorecard_service.preview_migration(SAMPLE_BACKUP)
    assert preview["total_weeks"] == 3
    p1 = next(p for p in preview["profiles"] if p["profile_id"] == "p1")
    assert p1["suggested_user_id"] == "u1"
    p2 = next(p for p in preview["profiles"] if p["profile_id"] == "p2")
    assert p2["suggested_user_id"] is None


def test_migrate_commit_imports_weeks_notes_and_settings(isolated_db):
    _mk_user("u1", "Jane Smith")
    result = scorecard_service.commit_migration(SAMPLE_BACKUP, {"p1": "u1", "p2": None})
    assert result == {"profiles_imported": 1, "weeks_imported": 2, "settings_imported": True}

    live = db.get_scorecard_week("u1", "2026-08-24")
    live_entries = {e["metric_key"]: dict(e) for e in db.list_scorecard_entries_for_week(live["id"])}
    assert live_entries["calls"]["actual"] == 500.0
    assert live_entries["leads"]["notes"] == "n1"

    hist = db.get_scorecard_week("u1", "2026-08-17")
    assert hist["saved_at"] == "2026-08-18T10:00:00"
    hist_entries = {e["metric_key"]: dict(e) for e in db.list_scorecard_entries_for_week(hist["id"])}
    assert hist_entries["talk_time"]["actual"] == 9.5

    assert db.get_scorecard_week("u2", "2026-08-24") is None  # p2 was mapped to None (skip)

    targets = {t["metric_key"]: t["target_value"] for t in db.list_scorecard_metric_targets()}
    assert targets["calls"] == 700.0


def test_migrate_commit_is_idempotent(isolated_db):
    _mk_user("u1", "Jane Smith")
    scorecard_service.commit_migration(SAMPLE_BACKUP, {"p1": "u1"})
    first_week_id = db.get_scorecard_week("u1", "2026-08-24")["id"]
    scorecard_service.commit_migration(SAMPLE_BACKUP, {"p1": "u1"})
    assert db.get_scorecard_week("u1", "2026-08-24")["id"] == first_week_id


def test_migrate_endpoints_require_true_admin_not_just_manager(client):
    app, http = client
    _as(app, MANAGER)  # has view_scorecard_manager, but isn't an admin
    resp = http.post("/scorecard/migrate/preview", json={"backup_json": {"store": {"profiles": {}}}})
    assert resp.status_code == 403

    _as(app, ADMIN)
    resp = http.post("/scorecard/migrate/preview", json={"backup_json": {"store": {"profiles": {}}}})
    assert resp.status_code == 200


# --- the update_lead hook (leads.py) — deferred import, CI-only locally ---


def test_update_lead_records_status_history_on_real_transition(isolated_db):
    from app.routers import leads as leads_router  # noqa: local import, see module docstring

    _mk_user("u1", "Rep One")
    lead_id = db.secrets.token_hex(8)
    db.create_lead(
        id=lead_id, timestamp="t", company="Acme", phone_number="", source_url="",
        status="u", notes="", owner_user_id="u1", created_at="t",
    )

    app = FastAPI()
    app.include_router(leads_router.router)
    app.dependency_overrides[get_current_user] = lambda: MEMBER
    http = TestClient(app)

    resp = http.patch(f"/leads/{lead_id}", json={"opportunity_stage": "opportunity"})
    assert resp.status_code == 200

    rows = db.qualified_leads_passed_by_week("opportunity_stage", "opportunity")
    assert any(r["user_id"] == "u1" for r in rows)

    # a second PATCH that doesn't change the status must not add another row
    resp2 = http.patch(f"/leads/{lead_id}", json={"lead_notes": "just a note"})
    assert resp2.status_code == 200
    rows_after = db.qualified_leads_passed_by_week("opportunity_stage", "opportunity")
    assert sum(r["value"] for r in rows_after) == sum(r["value"] for r in rows)
