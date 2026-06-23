from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app import db
from app.dependencies import CurrentUser, bearer_scheme, get_current_user
from app.schemas_auth import IdentifyRequest, LoginResponse, UserOut, user_out_from_row
from app.services.auth_service import generate_session_token, new_id, now_iso, session_expiry_iso

router = APIRouter(prefix="/auth", tags=["auth"])


def _issue_session(user_id: str) -> str:
    token = generate_session_token()
    db.create_session(token, user_id, now_iso(), session_expiry_iso())
    return token


@router.post("/identify", response_model=LoginResponse)
def identify(body: IdentifyRequest) -> LoginResponse:
    """No passwords — this is a small trusted team. Typing an existing name
    signs in as that person; typing a new one creates a profile on the spot
    (the very first profile ever created becomes admin)."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")

    user = db.get_user_by_name(name)
    if user is None:
        role = "admin" if db.count_users() == 0 else "member"
        user_id = new_id()
        db.create_user(user_id, name, role, now_iso())
        user = db.get_user_by_id(user_id)

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
