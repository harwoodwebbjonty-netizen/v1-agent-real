from typing import Literal, Optional

from pydantic import BaseModel


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


class SetAvatarRequest(BaseModel):
    avatar: Optional[str] = None


def user_out_from_row(row) -> UserOut:
    return UserOut(
        id=row["id"], name=row["name"], role=row["role"], avatar=row["avatar"], last_seen_at=row["last_seen_at"]
    )


class LoginResponse(BaseModel):
    token: str
    user: UserOut
