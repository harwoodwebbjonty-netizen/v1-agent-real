from typing import Any, List

from pydantic import BaseModel, field_validator


class CreateSavedViewRequest(BaseModel):
    name: str
    is_shared: bool = False
    filters: dict[str, Any]

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name can't be empty")
        if len(value) > 60:
            raise ValueError("Name is too long (max 60 characters)")
        return value

    @field_validator("filters")
    @classmethod
    def validate_filters(cls, value: dict[str, Any]) -> dict[str, Any]:
        import json

        if len(json.dumps(value)) > 8000:
            raise ValueError("Filter set is too large")
        return value


class SavedViewOut(BaseModel):
    id: str
    name: str
    owner_user_id: str
    owner_name: str | None = None
    is_shared: bool
    filters: dict[str, Any]
    created_at: str


class SavedViewsResponse(BaseModel):
    views: List[SavedViewOut]
