from typing import Literal, Optional

from pydantic import BaseModel


class IdentifyRequest(BaseModel):
    name: str


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
