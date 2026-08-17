"""Tests for calendar OAuth accounts (Stage 4 roadmap item) — db-layer CRUD
(mirrors email_oauth_accounts' shape/pattern exactly, see migration 037's
docstring for why it's a separate table) and the pure datetime-combining
helper used when pushing a CRM event to the connected calendar. The actual
HTTP exchange with Google/Microsoft isn't mocked here, matching the existing
precedent for email_oauth_service.py — that boundary is verified live."""

import pytest

from app import db
from app.services.calendar_oauth_service import _event_datetimes


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


def test_upsert_and_get_calendar_oauth_account(isolated_db):
    db.upsert_calendar_oauth_account(
        "acct-1", "user-1", "gmail", "rep@example.com", "enc-access", "enc-refresh", "2030-01-01T00:00:00+00:00", "t",
    )

    row = db.get_calendar_oauth_account("user-1", "gmail")

    assert row["email_address"] == "rep@example.com"
    assert row["access_token"] == "enc-access"


def test_upsert_calendar_oauth_account_updates_on_reconnect(isolated_db):
    db.upsert_calendar_oauth_account(
        "acct-1", "user-1", "gmail", "old@example.com", "old-access", "old-refresh", "2030-01-01T00:00:00+00:00", "t",
    )
    db.upsert_calendar_oauth_account(
        "acct-2", "user-1", "gmail", "new@example.com", "new-access", "new-refresh", "2030-02-01T00:00:00+00:00", "t2",
    )

    row = db.get_calendar_oauth_account("user-1", "gmail")

    assert row["email_address"] == "new@example.com"
    assert row["access_token"] == "new-access"


def test_list_calendar_oauth_accounts(isolated_db):
    db.upsert_calendar_oauth_account("a1", "user-1", "gmail", "a@x.com", "t", "t", "2030-01-01T00:00:00+00:00", "t")
    db.upsert_calendar_oauth_account("a2", "user-1", "microsoft", "b@x.com", "t", "t", "2030-01-01T00:00:00+00:00", "t")
    db.upsert_calendar_oauth_account("a3", "user-2", "gmail", "c@x.com", "t", "t", "2030-01-01T00:00:00+00:00", "t")

    rows = db.list_calendar_oauth_accounts("user-1")

    assert [r["provider"] for r in rows] == ["gmail", "microsoft"]


def test_delete_calendar_oauth_account(isolated_db):
    db.upsert_calendar_oauth_account("a1", "user-1", "gmail", "a@x.com", "t", "t", "2030-01-01T00:00:00+00:00", "t")

    db.delete_calendar_oauth_account("user-1", "gmail")

    assert db.get_calendar_oauth_account("user-1", "gmail") is None


def test_delete_calendar_oauth_account_only_affects_matching_provider(isolated_db):
    db.upsert_calendar_oauth_account("a1", "user-1", "gmail", "a@x.com", "t", "t", "2030-01-01T00:00:00+00:00", "t")
    db.upsert_calendar_oauth_account("a2", "user-1", "microsoft", "b@x.com", "t", "t", "2030-01-01T00:00:00+00:00", "t")

    db.delete_calendar_oauth_account("user-1", "gmail")

    assert db.get_calendar_oauth_account("user-1", "gmail") is None
    assert db.get_calendar_oauth_account("user-1", "microsoft") is not None


def test_event_datetimes_combines_date_and_time():
    start, end = _event_datetimes("2026-09-01", "14:30")

    assert start == "2026-09-01T14:30:00"
    assert end == "2026-09-01T15:00:00"


def test_event_datetimes_rolls_over_midnight():
    start, end = _event_datetimes("2026-09-01", "23:45")

    assert start == "2026-09-01T23:45:00"
    assert end == "2026-09-02T00:15:00"
