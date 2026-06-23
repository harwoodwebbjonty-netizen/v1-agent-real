import secrets
from datetime import datetime, timedelta, timezone

SESSION_TTL = timedelta(days=30)


def generate_session_token() -> str:
    return secrets.token_urlsafe(32)


def new_id() -> str:
    return secrets.token_hex(12)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def session_expiry_iso() -> str:
    return (datetime.now(timezone.utc) + SESSION_TTL).isoformat()


def is_expired(expires_at_iso: str) -> bool:
    return datetime.fromisoformat(expires_at_iso) < datetime.now(timezone.utc)
