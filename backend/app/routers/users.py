from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.dependencies import CurrentUser, get_current_user, require_admin
from app.schemas_auth import SetAvatarRequest, UserOut, user_out_from_row
from app.schemas_users import CreateUserRequest, UpdateUserRequest, UserListResponse
from app.services.auth_service import new_id, now_iso

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=UserListResponse)
def list_users() -> UserListResponse:
    """Public — the identity switcher needs to show known names before
    anyone is signed in. There's no password boundary to protect here."""
    rows = db.list_users()
    return UserListResponse(users=[user_out_from_row(r) for r in rows])


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
