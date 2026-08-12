import re

from pydantic import BaseModel, field_validator

PHONE_PATTERN = re.compile(r"^[+]?[0-9\s\-()]{7,20}$")
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class AddPhoneRequest(BaseModel):
    phone_number: str

    @field_validator("phone_number")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        value = value.strip()
        if not PHONE_PATTERN.match(value):
            raise ValueError("That doesn't look like a valid phone number")
        return value


class UpdatePhoneRequest(AddPhoneRequest):
    pass


class PhoneOut(BaseModel):
    id: str
    phone_number: str
    source: str


class AddEmailRequest(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        value = value.strip()
        if not EMAIL_PATTERN.match(value):
            raise ValueError("That doesn't look like a valid email address")
        return value


class UpdateEmailRequest(AddEmailRequest):
    pass


class EmailOut(BaseModel):
    id: str
    email: str
    source: str
    verify_status: str = "unchecked"
    person_match: str = "unknown"
    verify_detail: str = ""


class AddTagRequest(BaseModel):
    tag: str

    @field_validator("tag")
    @classmethod
    def validate_tag(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Tag can't be empty")
        if len(value) > 40:
            raise ValueError("Tag is too long (max 40 characters)")
        return value
