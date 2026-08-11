"""Regression test for closing open self-registration on /auth/identify.

Before this fix, POSTing an unrecognized name+password created a brand-new
'member' account with no admin involvement — anyone reaching the backend
could grant themselves access to the shared lead pool. Only the very first
account on a fresh deployment (bootstrap-token gated) should still work this
way; every other unknown name must be rejected."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.responses import JSONResponse

from app import db
from app.core.config import get_settings
from app.core.rate_limit import limiter
from app.routers import auth as auth_router
from app.services.auth_service import hash_password


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "team.db")
    monkeypatch.setattr(db, "BACKUPS_DIR", tmp_path / "backups")
    db.init_db()
    return tmp_path


@pytest.fixture
def client(isolated_db):
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(
        RateLimitExceeded, lambda r, e: JSONResponse({"detail": "rate limited"}, status_code=429)
    )
    app.add_middleware(SlowAPIMiddleware)
    app.include_router(auth_router.router)
    get_settings.cache_clear()
    yield TestClient(app)
    get_settings.cache_clear()


def test_unknown_name_rejected_when_users_already_exist(client):
    db.create_user("u1", "Alice", "member", "t", password_hash=hash_password("longenough1"))

    resp = client.post("/auth/identify", json={"name": "Mallory", "password": "longenough1"})

    assert resp.status_code == 404
    assert db.get_user_by_name("Mallory") is None
    assert db.count_users() == 1


def test_first_account_bootstrap_still_works(client, monkeypatch):
    monkeypatch.setenv("BOOTSTRAP_ADMIN_TOKEN", "test-secret")
    get_settings.cache_clear()

    resp = client.post(
        "/auth/identify",
        json={"name": "FirstAdmin", "password": "longenough1", "bootstrap_token": "test-secret"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["user"]["role"] == "admin"
    assert db.count_users() == 1


def test_first_account_without_token_still_refused(client):
    resp = client.post("/auth/identify", json={"name": "FirstAdmin", "password": "longenough1"})

    assert resp.status_code == 403
    assert db.count_users() == 0


def test_existing_user_can_still_sign_in(client):
    db.create_user("u1", "Alice", "member", "t", password_hash=hash_password("longenough1"))

    resp = client.post("/auth/identify", json={"name": "Alice", "password": "longenough1"})

    assert resp.status_code == 200
    assert resp.json()["user"]["name"] == "Alice"
