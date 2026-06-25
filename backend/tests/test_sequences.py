import asyncio
from pathlib import Path

import pytest

from app import db
from app.services.sequences_service import process_due_enrollments


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    """Same isolation pattern as test_db_migrations.py — never touches the
    real backend/data/team.db."""
    db_path = tmp_path / "team.db"
    backups_dir = tmp_path / "backups"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    monkeypatch.setattr(db, "BACKUPS_DIR", backups_dir)
    return db_path, backups_dir


def _seed_user_and_lead(user_id: str = "user-1", lead_id: str = "lead-1") -> None:
    db.create_user(user_id, "Jonty", "admin", "2026-01-01T00:00:00")
    db.create_lead(
        id=lead_id,
        timestamp="2026-01-01T00:00:00",
        company="Acme",
        phone_number="555",
        source_url="",
        status="verified",
        notes="",
        owner_user_id=user_id,
        created_at="2026-01-01T00:00:00",
    )


def test_task_step_creates_calendar_event_and_advances(isolated_db, monkeypatch):
    db.init_db()
    _seed_user_and_lead()

    # Freeze "now" so next_run_at math is exact and the due-enrollment query
    # deterministically picks this enrollment up.
    fixed_now = "2026-01-10T00:00:00+00:00"
    monkeypatch.setattr("app.services.sequences_service.now_iso", lambda: fixed_now)

    seq_id = "seq-1"
    db.create_sequence(seq_id, "Test Sequence", "user-1", fixed_now)
    db.update_sequence_fields(seq_id, {"status": "active"}, fixed_now)
    db.add_sequence_step("step-1", seq_id, 0, 0, "call_task", "Call {{company}}", "Follow up call", fixed_now)
    db.add_sequence_step("step-2", seq_id, 1, 5, "reminder_task", "Reminder for {{company}}", "", fixed_now)

    db.enroll_lead_in_sequence("enr-1", seq_id, "lead-1", "user-1", fixed_now, fixed_now)

    processed = asyncio.run(process_due_enrollments())
    assert processed == 1

    enrollment = db.get_sequence_enrollment("enr-1")
    assert enrollment["current_step"] == 1
    assert enrollment["status"] == "active"
    assert enrollment["next_run_at"] is not None

    events = db.list_calendar_events("user-1")
    assert len(events) == 1
    assert events[0]["type"] == "call"
    assert events[0]["title"] == "Call Acme"
    assert events[0]["lead_id"] == "lead-1"


def test_email_step_without_oauth_account_stops_safely(isolated_db, monkeypatch):
    db.init_db()
    _seed_user_and_lead()
    db.add_email(id="email-1", lead_id="lead-1", email="prospect@example.com", source="manual", created_at="2026-01-01T00:00:00")

    fixed_now = "2026-01-10T00:00:00+00:00"
    monkeypatch.setattr("app.services.sequences_service.now_iso", lambda: fixed_now)

    seq_id = "seq-2"
    db.create_sequence(seq_id, "Email Sequence", "user-1", fixed_now)
    db.update_sequence_fields(seq_id, {"status": "active"}, fixed_now)
    db.add_sequence_step("step-1", seq_id, 0, 0, "email", "Hi {{first_name}}", "Body", fixed_now)
    db.enroll_lead_in_sequence("enr-2", seq_id, "lead-1", "user-1", fixed_now, fixed_now)

    processed = asyncio.run(process_due_enrollments())
    assert processed == 1

    enrollment = db.get_sequence_enrollment("enr-2")
    # No OAuth account connected for user-1 — must fail safely, not crash,
    # not silently "succeed" without actually sending anything.
    assert enrollment["status"] == "stopped"
    assert "connected email account" in enrollment["last_error"].lower()
    # current_step must NOT have advanced — the step never actually ran.
    assert enrollment["current_step"] == 0


def test_sequence_completes_after_last_step(isolated_db, monkeypatch):
    db.init_db()
    _seed_user_and_lead()

    fixed_now = "2026-01-10T00:00:00+00:00"
    monkeypatch.setattr("app.services.sequences_service.now_iso", lambda: fixed_now)

    seq_id = "seq-3"
    db.create_sequence(seq_id, "One Step", "user-1", fixed_now)
    db.update_sequence_fields(seq_id, {"status": "active"}, fixed_now)
    db.add_sequence_step("step-1", seq_id, 0, 0, "reminder_task", "Reminder", "", fixed_now)
    db.enroll_lead_in_sequence("enr-3", seq_id, "lead-1", "user-1", fixed_now, fixed_now)

    asyncio.run(process_due_enrollments())

    enrollment = db.get_sequence_enrollment("enr-3")
    assert enrollment["status"] == "completed"
    assert enrollment["next_run_at"] is None


def test_inactive_sequence_does_not_run(isolated_db, monkeypatch):
    db.init_db()
    _seed_user_and_lead()

    fixed_now = "2026-01-10T00:00:00+00:00"
    monkeypatch.setattr("app.services.sequences_service.now_iso", lambda: fixed_now)

    seq_id = "seq-4"
    db.create_sequence(seq_id, "Still Draft", "user-1", fixed_now)  # never activated
    db.add_sequence_step("step-1", seq_id, 0, 0, "reminder_task", "Reminder", "", fixed_now)
    db.enroll_lead_in_sequence("enr-4", seq_id, "lead-1", "user-1", fixed_now, fixed_now)

    asyncio.run(process_due_enrollments())

    enrollment = db.get_sequence_enrollment("enr-4")
    assert enrollment["status"] == "stopped"
    assert db.list_calendar_events("user-1") == []
