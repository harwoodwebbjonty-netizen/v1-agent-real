import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

SESSION_TTL = timedelta(days=30)
_PBKDF2_ITERATIONS = 200_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), _PBKDF2_ITERATIONS)
    return f"pbkdf2${_PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iterations_s, salt, expected = stored.split("$")
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations_s))
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, AttributeError):
        return False


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
