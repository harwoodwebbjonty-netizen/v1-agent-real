import os
import sqlite3
import time
from pathlib import Path

import pytest

from app import db


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    """Points the db module at a throwaway file for this test only —
    never touches the real backend/data/team.db."""
    db_path = tmp_path / "team.db"
    backups_dir = tmp_path / "backups"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "BACKUPS_DIR", backups_dir)
    return db_path, backups_dir


def _seed_legacy_database(db_path: Path) -> None:
    """Simulates a database created by the app before this migration system
    existed — full schema already present (idempotent SCHEMA + ALTERs
    already ran), real data inserted, but no schema_version table yet."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        db._migration_001_baseline(conn)
        conn.commit()
    finally:
        conn.close()


def test_legacy_database_upgrades_preserving_all_data(isolated_db):
    db_path, _ = isolated_db
    _seed_legacy_database(db_path)

    db.create_user("user-1", "Jonty", "admin", "2026-01-01T00:00:00")
    db.create_lead(
        id="lead-1",
        timestamp="2026-01-01T00:00:00",
        company="Acme",
        phone_number="555",
        source_url="",
        status="verified",
        notes="",
        owner_user_id="user-1",
        created_at="2026-01-01T00:00:00",
    )
    db.create_calendar_event(
        id="event-1",
        owner_user_id="user-1",
        title="Call Acme",
        date="2026-02-01",
        time="09:00",
        type="call",
        lead_id="lead-1",
        description="",
        created_at="2026-01-01T00:00:00",
    )
    db.add_lead_intelligence_version(
        "intel-1",
        "lead-1",
        {
            "executive_summary": "summary",
            "sales_summary": "sales",
            "pain_points": "{}",
            "buying_signals": "[]",
            "conversation_starters": "[]",
            "discovery_questions": "[]",
            "objection_handling": "[]",
            "pitch_angle": "",
            "call_brief": "",
            "score_breakdown": "{}",
            "lead_score": 50,
            "lead_temperature": "Warm",
            "confidence_note": "",
        },
        "2026-01-01T00:00:00",
    )
    db.create_email_draft(
        "draft-1",
        "lead-1",
        "user-1",
        {
            "subject": "Hi",
            "body": "Body",
            "tone": "Custom",
            "length": "Short",
            "estimated_open_rate": None,
            "estimated_reply_rate": None,
            "estimated_readability_score": None,
        },
        "2026-01-01T00:00:00",
    )

    # No schema_version table yet — exactly the state of an existing real database.
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    assert db.get_schema_version(conn) == 0
    conn.close()

    db.init_db()

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        assert db.get_schema_version(conn) == db.CURRENT_SCHEMA_VERSION
        assert conn.execute("SELECT * FROM users WHERE id='user-1'").fetchone()["name"] == "Jonty"
        assert conn.execute("SELECT * FROM leads WHERE id='lead-1'").fetchone()["company"] == "Acme"
        assert conn.execute("SELECT * FROM calendar_events WHERE id='event-1'").fetchone()["title"] == "Call Acme"
        assert (
            conn.execute("SELECT * FROM lead_intelligence_versions WHERE id='intel-1'").fetchone()["lead_score"] == 50
        )
        assert conn.execute("SELECT * FROM email_drafts WHERE id='draft-1'").fetchone()["subject"] == "Hi"
    finally:
        conn.close()


def test_migration_runs_only_once(isolated_db, monkeypatch):
    isolated_db_path, _ = isolated_db
    call_count = {"n": 0}
    original = db._migration_001_baseline

    def counting_migration(conn):
        call_count["n"] += 1
        original(conn)

    monkeypatch.setattr(db, "MIGRATIONS", [(1, counting_migration)])

    db.init_db()
    db.init_db()

    assert call_count["n"] == 1


def test_no_backup_on_brand_new_database(isolated_db):
    _, backups_dir = isolated_db

    db.init_db()  # nothing existed before this call — migration runs, but nothing to back up

    backups = list(backups_dir.glob("team-*.db")) if backups_dir.exists() else []
    assert len(backups) == 0


def test_backup_created_when_migration_runs_then_skipped_when_up_to_date(isolated_db):
    db_path, backups_dir = isolated_db
    _seed_legacy_database(db_path)  # file already exists, no schema_version — migration required

    db.init_db()
    backups = list(backups_dir.glob("team-*.db"))
    assert len(backups) == 1

    db.init_db()  # already up to date — no new backup
    backups_after = list(backups_dir.glob("team-*.db"))
    assert len(backups_after) == 1


def test_retention_keeps_only_latest_10(isolated_db):
    _, backups_dir = isolated_db
    backups_dir.mkdir(parents=True)
    for i in range(15):
        path = backups_dir / f"team-2026010{i:02d}-000000.db"
        path.write_bytes(b"fake")
        mtime = time.time() - (15 - i)
        os.utime(path, (mtime, mtime))

    db._prune_old_backups()

    remaining = sorted(backups_dir.glob("team-*.db"))
    assert len(remaining) == 10
    remaining_names = {p.name for p in remaining}
    for i in range(5):
        assert f"team-2026010{i:02d}-000000.db" not in remaining_names
    for i in range(5, 15):
        assert f"team-2026010{i:02d}-000000.db" in remaining_names


def test_restore_round_trip(isolated_db):
    db_path, _ = isolated_db
    db.init_db()
    db.create_user("user-1", "Original", "admin", "2026-01-01T00:00:00")

    backup_path = db.backup_database()
    assert backup_path is not None

    db.update_user("user-1", "Mutated", None)
    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT name FROM users WHERE id='user-1'").fetchone()[0] == "Mutated"
    conn.close()

    db.restore_database(backup_path)

    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute("SELECT name FROM users WHERE id='user-1'").fetchone()[0] == "Original"
    finally:
        conn.close()

    safety_copies = list(db_path.parent.glob("team-pre-restore-*.db"))
    assert len(safety_copies) == 1


def test_call_logs_migration_and_crud(isolated_db):
    db_path, _ = isolated_db
    db.init_db()

    db.create_user("user-1", "Jonty", "admin", "2026-01-01T00:00:00")
    db.create_lead(
        id="lead-1",
        timestamp="2026-01-01T00:00:00",
        company="Acme",
        phone_number="555",
        source_url="",
        status="verified",
        notes="",
        owner_user_id="user-1",
        created_at="2026-01-01T00:00:00",
    )

    db.create_call_log(
        id="call-1",
        lead_id="lead-1",
        calendar_event_id=None,
        outcome="connected",
        notes="Spoke to the owner, interested.",
        duration_seconds=180,
        created_by="user-1",
        created_at="2026-01-01T09:00:00",
    )
    db.create_call_log(
        id="call-2",
        lead_id="lead-1",
        calendar_event_id=None,
        outcome="voicemail",
        notes="",
        duration_seconds=None,
        created_by="user-1",
        created_at="2026-01-02T09:00:00",
    )

    logs = db.list_call_logs_for_lead("lead-1")
    assert len(logs) == 2
    # Most recent first.
    assert logs[0]["id"] == "call-2"
    assert logs[1]["outcome"] == "connected"
    assert logs[1]["duration_seconds"] == 180

    latest = db.get_latest_call_log_for_lead("lead-1")
    assert latest["id"] == "call-2"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        assert db.get_schema_version(conn) == db.CURRENT_SCHEMA_VERSION
    finally:
        conn.close()


def test_corrupt_backup_rejected(isolated_db):
    db_path, _ = isolated_db
    db.init_db()

    backup_path = db.backup_database()
    assert backup_path is not None

    backup_path.write_bytes(b"not a real sqlite file")

    assert db._validate_backup(backup_path) is False
    with pytest.raises(ValueError):
        db.restore_database(backup_path)
