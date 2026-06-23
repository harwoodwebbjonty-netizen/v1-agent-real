from typing import Literal, Optional

from pydantic import BaseModel

from app.schemas_auth import UserOut


class CreateUserRequest(BaseModel):
    name: str
    role: Literal["admin", "member"] = "member"


class UpdateUserRequest(BaseModel):
    name: Optional[str] = None
    role: Optional[Literal["admin", "member"]] = None


class UserListResponse(BaseModel):
    users: list[UserOut]
