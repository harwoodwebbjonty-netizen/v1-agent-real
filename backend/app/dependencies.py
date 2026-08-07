from dataclasses import dataclass, field
from typing import Callable, Optional

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app import db
from app.services.auth_service import is_expired
from app.services.permission_service import resolve_user_access

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass
class CurrentUser:
    id: str
    name: str
    role: str
    permissions: frozenset = field(default_factory=frozenset)
    lead_scope: str = "all_shared"
    role_name: str = ""

    def has(self, permission: str) -> bool:
        # Admin is the built-in super-role — always allowed.
        return self.role == "admin" or permission in self.permissions


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> CurrentUser:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    session = db.get_session(credentials.credentials)
    if session is None or is_expired(session["expires_at"]):
        raise HTTPException(status_code=401, detail="Session expired or invalid")

    user = db.get_user_by_id(session["user_id"])
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")

    perms, scope, role_name = resolve_user_access(user)
    return CurrentUser(
        id=user["id"], name=user["name"], role=user["role"],
        permissions=perms, lead_scope=scope, role_name=role_name,
    )


def require_admin(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return current_user


def require_permission(permission: str) -> Callable[[CurrentUser], CurrentUser]:
    """Dependency factory: allow the request only if the user's role grants
    `permission` (admin always passes)."""
    def _dep(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not current_user.has(permission):
            raise HTTPException(status_code=403, detail=f"Your role doesn't allow this ({permission}).")
        return current_user
    return _dep
