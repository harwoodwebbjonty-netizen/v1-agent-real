"""Regression test for the win-back "Generate Campaign" 500 error.

create_campaign_from_csv wrote win_back_emails rows (FK -> win_back_campaigns.id)
for rows reusing a cached preview *before* the win_back_campaigns parent row was
inserted (that insert happened after the whole loop). Any campaign where at
least one row already had a matching cached preview hit
sqlite3.IntegrityError: FOREIGN KEY constraint failed and the whole request
500'd — confirmed against the real production logs and DB."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.dependencies import get_current_user
from app.routers import win_back as win_back_router
from app.services.auth_service import hash_password, now_iso, session_expiry_iso


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


@pytest.fixture
def admin_client(isolated_db):
    db.create_user("admin1", "Admin", "admin", now_iso(), password_hash=hash_password("longenough1"))
    db.set_user_role("admin1", "role-admin")
    token = "test-session-token"
    db.create_session(token, "admin1", now_iso(), session_expiry_iso(30))

    app = FastAPI()
    app.include_router(win_back_router.router)
    client = TestClient(app)
    client.headers.update({"Authorization": f"Bearer {token}"})
    return client


def _row(company: str, with_cached_preview: bool) -> dict:
    row = {
        "company": company, "contact_name": "", "email": "", "phone": "",
        "website": "", "linkedin": "", "notes": "", "industry": "",
        "deal_owner": "", "stage": "", "closing_date": "", "amount": "",
    }
    if with_cached_preview:
        row["preview_subject"] = "Following up"
        row["preview_body"] = "Hi there, checking back in."
    return row


def test_campaign_with_a_reused_preview_row_does_not_500(admin_client):
    """Before the fix: this reproduced 'sqlite3.IntegrityError: FOREIGN KEY
    constraint failed' -> 500, because the win_back_emails row for the
    reused-preview row was written before win_back_campaigns existed."""
    resp = admin_client.post(
        "/win-back/campaigns/from-csv",
        json={"name": "Test Campaign", "rows": [_row("Acme Ltd", with_cached_preview=True)]},
    )

    assert resp.status_code == 200
    campaign_id = resp.json()["id"]
    assert db.get_win_back_campaign(campaign_id) is not None
    emails = db.get_win_back_emails(campaign_id)
    assert len(emails) == 1
    assert emails[0]["subject"] == "Following up"


def test_campaign_with_only_reused_previews_marks_ready(admin_client):
    resp = admin_client.post(
        "/win-back/campaigns/from-csv",
        json={
            "name": "All Cached",
            "rows": [
                _row("Acme Ltd", with_cached_preview=True),
                _row("Beta Traders", with_cached_preview=True),
            ],
        },
    )

    assert resp.status_code == 200
    campaign = db.get_win_back_campaign(resp.json()["id"])
    assert campaign["status"] == "ready"
    assert campaign["generated"] == 2
