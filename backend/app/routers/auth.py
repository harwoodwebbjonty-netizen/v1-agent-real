from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app import db
from app.dependencies import CurrentUser, bearer_scheme, get_current_user
from app.schemas_auth import IdentifyRequest, LoginResponse, UserOut, user_out_from_row
from app.services.auth_service import (
    generate_session_token,
    hash_password,
    new_id,
    now_iso,
    session_expiry_iso,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


def _issue_session(user_id: str) -> str:
    token = generate_session_token()
    db.create_session(token, user_id, now_iso(), session_expiry_iso())
    return token


MIN_PASSWORD_LENGTH = 4


@router.post("/identify", response_model=LoginResponse)
def identify(body: IdentifyRequest) -> LoginResponse:
    """Name + password sign-in. A new name creates a profile with the given
    password (the very first profile ever created becomes admin). Accounts
    created before passwords existed have no hash yet — the first successful
    identify claims them by setting the provided password."""
    name = body.name.strip()
    password = body.password
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=400, detail=f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
        )

    user = db.get_user_by_name(name)
    if user is None:
        role = "admin" if db.count_users() == 0 else "member"
        user_id = new_id()
        db.create_user(user_id, name, role, now_iso(), password_hash=hash_password(password))
        user = db.get_user_by_id(user_id)
    elif user["password_hash"] is None:
        # Legacy account from before passwords — first login sets it.
        db.set_user_password(user["id"], hash_password(password))
    elif not verify_password(password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect password")

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
