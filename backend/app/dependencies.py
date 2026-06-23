from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app import db
from app.services.auth_service import is_expired

bearer_scheme = HTTPBearer(auto_error=False)


@dataclass
class CurrentUser:
    id: str
    name: str
    role: str


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

    return CurrentUser(id=user["id"], name=user["name"], role=user["role"])


def require_admin(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return current_user
