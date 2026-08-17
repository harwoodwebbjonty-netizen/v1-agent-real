"""Regression test for the win-back "Generate Campaign" 500 error.

create_campaign_from_csv wrote win_back_emails rows (FK -> win_back_campaigns.id)
for rows reusing a cached preview *before* the win_back_campaigns parent row was
inserted (that insert happened after the whole loop). Any campaign where at
least one row already had a matching cached preview hit
sqlite3.IntegrityError: FOREIGN KEY constraint failed and the whole request
500'd — confirmed against the real production logs and DB."""

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

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


def test_prior_win_back_emails_are_not_capped_at_three(isolated_db):
    """get_prior_win_back_emails_for_lead used to cap at 3 (limit=3 default).
    A lead re-approached across many campaigns should get its FULL history
    back so the writer can build on every earlier email, not just the most
    recent few."""
    ts = now_iso()
    lead_id = db.create_lead(
        id="lead-history", timestamp=ts, company="History Co", phone_number="",
        source_url="", status="New", notes="", owner_user_id="admin1", created_at=ts,
    )
    for i in range(5):
        campaign_id = f"campaign-{i}"
        db.create_win_back_campaign(campaign_id, f"Campaign {i}", "admin1", 1, ts)
        db.upsert_win_back_email(campaign_id, lead_id, f"email-{i}", f"Subject {i}", f"Body {i}", ts)

    rows = db.get_prior_win_back_emails_for_lead(lead_id)

    assert len(rows) == 5
    # Most recent (highest id, since created_at ties) first.
    assert rows[0]["subject"] == "Subject 4"
    assert rows[-1]["subject"] == "Subject 0"


def test_stale_lead_intelligence_is_reused_not_rescraped(admin_client, monkeypatch):
    """Once a lead has ANY stored research, campaign generation must reuse it
    indefinitely rather than re-running the LinkedIn scrape / website fetch /
    sales-intelligence pipeline on a 30-day expiry — the personalisation data
    already gathered for this lead is treated as durable history now, not a
    cache that goes stale."""
    ts = now_iso()
    lead_id = db.create_lead(
        id="lead-stale", timestamp=ts, company="Stale Co", phone_number="",
        source_url="", status="New", notes="", owner_user_id="admin1", created_at=ts,
    )
    old_created_at = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    db.add_lead_intelligence_version(
        "intel-stale", lead_id,
        {
            "executive_summary": "x", "sales_summary": "Existing summary", "pain_points": "{}",
            "buying_signals": "[]", "conversation_starters": "[]", "discovery_questions": "[]",
            "objection_handling": "[]", "pitch_angle": "x", "call_brief": "x",
            "score_breakdown": "{}", "lead_score": 50, "lead_temperature": "warm",
            "confidence_note": "x",
        },
        old_created_at,
    )

    campaign_id = "campaign-stale"
    db.create_win_back_campaign(campaign_id, "Stale Campaign", "admin1", 1, ts)

    mock_linkedin = AsyncMock()
    mock_intelligence = AsyncMock()
    mock_website = AsyncMock()
    monkeypatch.setattr(win_back_router, "get_or_fetch_linkedin_posts", mock_linkedin)
    monkeypatch.setattr(win_back_router, "generate_sales_intelligence", mock_intelligence)
    monkeypatch.setattr(win_back_router, "fetch_website_text", mock_website)
    monkeypatch.setattr(
        win_back_router, "generate_win_back_email",
        AsyncMock(return_value={"subject": "Test subject", "body": "Test body"}),
    )

    asyncio.run(win_back_router._generate_campaign(campaign_id, [lead_id], "admin1"))

    mock_linkedin.assert_not_called()
    mock_intelligence.assert_not_called()
    mock_website.assert_not_called()

    emails = db.get_win_back_emails(campaign_id)
    assert len(emails) == 1
    assert "Test subject" in emails[0]["subject"]
