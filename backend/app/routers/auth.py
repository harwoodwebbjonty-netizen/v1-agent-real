from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials

from app import db
from app.core.config import get_settings
from app.core.rate_limit import limiter
from app.dependencies import CurrentUser, bearer_scheme, get_current_user
from app.schemas_auth import IdentifyRequest, LoginResponse, UserOut, user_out_from_row
from app.services.auth_service import (
    generate_session_token,
    hash_password,
    is_expired,
    lock_until_iso,
    new_id,
    now_iso,
    session_expiry_iso,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _issue_session(user_id: str) -> str:
    token = generate_session_token()
    db.create_session(token, user_id, now_iso(), session_expiry_iso(get_settings().session_ttl_days))
    return token


@router.post("/identify", response_model=LoginResponse)
@limiter.limit(get_settings().auth_rate_limit)
def identify(request: Request, body: IdentifyRequest) -> LoginResponse:
    """Name + password sign-in. A new name creates a member profile. The very
    first account on a fresh deployment becomes admin ONLY if it presents the
    BOOTSTRAP_ADMIN_TOKEN. Legacy accounts (no password yet) are NOT self-claimed
    — an admin must set their password (see POST /users/{id}/set-password).
    Rate-limited, with per-account lockout after repeated failures."""
    settings = get_settings()
    name = body.name.strip()
    password = body.password
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if len(password) < settings.min_password_length:
        raise HTTPException(
            status_code=400,
            detail=f"Password must be at least {settings.min_password_length} characters",
        )

    user = db.get_user_by_name(name)
    if user is None:
        if db.count_users() == 0:
            # First-ever account → admin, but only with the deployment secret.
            if not settings.bootstrap_admin_token or body.bootstrap_token != settings.bootstrap_admin_token:
                raise HTTPException(
                    status_code=403,
                    detail="Admin setup token required to create the first account.",
                )
            role = "admin"
        else:
            role = "member"
        user_id = new_id()
        db.create_user(user_id, name, role, now_iso(), password_hash=hash_password(password))
        user = db.get_user_by_id(user_id)
    else:
        locked_until = user["locked_until"] if "locked_until" in user.keys() else None
        if locked_until and not is_expired(locked_until):
            raise HTTPException(status_code=429, detail="Too many failed attempts — try again later.")
        if user["password_hash"] is None:
            raise HTTPException(
                status_code=403,
                detail="This account has no password yet. Ask an admin to set up your login.",
            )
        if not verify_password(password, user["password_hash"]):
            prior = user["failed_login_attempts"] if "failed_login_attempts" in user.keys() else 0
            lock = lock_until_iso(settings.login_lockout_minutes) if (prior + 1) >= settings.login_max_attempts else None
            db.record_login_failure(user["id"], lock)
            raise HTTPException(status_code=401, detail="Incorrect password")
        db.reset_login_failures(user["id"])

    token = _issue_session(user["id"])
    return LoginResponse(token=token, user=user_out_from_row(user))


@router.post("/logout")
def logout(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme)) -> dict[str, str]:
    db.delete_session(credentials.credentials)
    return {"status": "ok"}


@router.get("/me", response_model=UserOut)
def me(current_user: CurrentUser = Depends(get_current_user)) -> UserOut:
    user = db.get_user_by_id(current_user.id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user_out_from_row(user)


@router.post("/heartbeat")
def heartbeat(current_user: CurrentUser = Depends(get_current_user)) -> dict[str, str]:
    """Called periodically while the app is open — real presence, not a
    fabricated "online" flag. The frontend decides the "active" threshold
    by comparing last_seen_at to now; this endpoint just records the ping."""
    db.update_user_last_seen(current_user.id, now_iso())
    return {"status": "ok"}
