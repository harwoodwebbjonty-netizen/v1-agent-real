from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import db
from app.core.config import get_settings
from app.dependencies import CurrentUser, get_current_user, require_admin
from app.schemas_auth import (
    SetAvatarRequest,
    UserNameOut,
    UserNamesResponse,
    UserOut,
    user_out_from_row,
)
from app.schemas_users import CreateUserRequest, UpdateUserRequest, UserListResponse
from app.services.auth_service import hash_password, new_id, now_iso

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/names", response_model=UserNamesResponse)
def list_user_names() -> UserNamesResponse:
    """Public, slim — only display names + avatars, for the pre-auth login
    picker. The full roster (ids/roles/activity) is authenticated below."""
    rows = db.list_user_display_names()
    return UserNamesResponse(users=[UserNameOut(name=r["name"], avatar=r["avatar"]) for r in rows])


@router.get("", response_model=UserListResponse)
def list_users(current_user: CurrentUser = Depends(get_current_user)) -> UserListResponse:
    """Full roster (ids/roles/last-seen) — authenticated only. Used by team
    management and owner/assignee display, not the login screen."""
    rows = db.list_users()
    return UserListResponse(users=[user_out_from_row(r) for r in rows])


class SetPasswordRequest(BaseModel):
    password: str


@router.post("/{user_id}/set-password", response_model=UserOut)
def set_user_password(
    user_id: str, body: SetPasswordRequest, admin: CurrentUser = Depends(require_admin)
) -> UserOut:
    """Admin-issued password set/reset — the safe replacement for the removed
    'first login claims a legacy account' path. Revokes the user's existing
    sessions so any stale/stolen token stops working."""
    user = db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if len(body.password) < get_settings().min_password_length:
        raise HTTPException(
            status_code=400,
            detail=f"Password must be at least {get_settings().min_password_length} characters",
        )
    db.set_user_password(user_id, hash_password(body.password))
    db.reset_login_failures(user_id)
    db.delete_other_sessions_for_user(user_id)
    return user_out_from_row(db.get_user_by_id(user_id))


@router.post("", response_model=UserOut)
def create_user(body: CreateUserRequest, admin: CurrentUser = Depends(require_admin)) -> UserOut:
    if db.get_user_by_name(body.name.strip()) is not None:
        raise HTTPException(status_code=400, detail="That name is already taken")

    user_id = new_id()
    db.create_user(user_id, body.name.strip(), body.role, now_iso())
    return user_out_from_row(db.get_user_by_id(user_id))


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: str, body: UpdateUserRequest, admin: CurrentUser = Depends(require_admin)) -> UserOut:
    user = db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if body.name is not None and db.get_user_by_name(body.name.strip()) not in (None, user):
        raise HTTPException(status_code=400, detail="That name is already taken")

    if body.role == "member" and user["role"] == "admin" and db.count_admins() <= 1:
        raise HTTPException(status_code=400, detail="Can't remove the last admin — promote someone else first")

    db.update_user(user_id, body.name.strip() if body.name else None, body.role)
    return user_out_from_row(db.get_user_by_id(user_id))


@router.patch("/{user_id}/avatar", response_model=UserOut)
def set_avatar(
    user_id: str, body: SetAvatarRequest, current_user: CurrentUser = Depends(get_current_user)
) -> UserOut:
    """Self-service — you set your own photo. Admins can also set anyone's
    (handy for cleanup), but this isn't an admin-only action by default."""
    if current_user.id != user_id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You can only change your own photo")

    user = db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    db.update_user_avatar(user_id, body.avatar)
    return user_out_from_row(db.get_user_by_id(user_id))


@router.delete("/{user_id}")
def delete_user(user_id: str, admin: CurrentUser = Depends(require_admin)) -> dict[str, str]:
    user = db.get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    if user["role"] == "admin" and db.count_admins() <= 1:
        raise HTTPException(status_code=400, detail="Can't remove the last admin — promote someone else first")

    db.delete_user(user_id)
    return {"status": "ok"}
