from typing import List, Literal

from pydantic import BaseModel, field_validator

CustomFieldType = Literal["text", "number", "date"]


class CreateCustomFieldRequest(BaseModel):
    name: str
    field_type: CustomFieldType = "text"

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name can't be empty")
        if len(value) > 60:
            raise ValueError("Name is too long (max 60 characters)")
        return value


class CustomFieldOut(BaseModel):
    id: str
    name: str
    field_type: CustomFieldType
    created_at: str


class CustomFieldsResponse(BaseModel):
    fields: List[CustomFieldOut]
