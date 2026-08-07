from typing import Literal, Optional

from pydantic import BaseModel

from app.services.permission_service import resolve_user_access


class IdentifyRequest(BaseModel):
    name: str
    password: str = ""
    # Required only to mint the very first admin on a fresh deployment.
    bootstrap_token: str = ""


class UserNameOut(BaseModel):
    """Slim public profile for the pre-auth login picker — no id/role/activity."""
    name: str
    avatar: Optional[str] = None


class UserNamesResponse(BaseModel):
    users: list[UserNameOut]


class UserOut(BaseModel):
    id: str
    name: str
    role: Literal["admin", "member"]
    avatar: Optional[str] = None
    last_seen_at: Optional[str] = None
    # RBAC: the user's assigned role + resolved effective permissions, so the app
    # can gate nav/actions. Admin always resolves to every permission.
    role_id: Optional[str] = None
    role_name: str = ""
    permissions: list[str] = []
    lead_scope: str = "all_shared"


class SetAvatarRequest(BaseModel):
    avatar: Optional[str] = None


def user_out_from_row(row) -> UserOut:
    perms, scope, role_name = resolve_user_access(row)
    return UserOut(
        id=row["id"], name=row["name"], role=row["role"], avatar=row["avatar"], last_seen_at=row["last_seen_at"],
        role_id=row["role_id"] if "role_id" in row.keys() else None,
        role_name=role_name, permissions=sorted(perms), lead_scope=scope,
    )


class LoginResponse(BaseModel):
    token: str
    user: UserOut
