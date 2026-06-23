from typing import Optional

from pydantic import BaseModel


class CreateEmailTemplateRequest(BaseModel):
    name: str
    subject: str
    body: str
    tone: str = ""
    length: str = ""


class UpdateEmailTemplateRequest(BaseModel):
    name: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    tone: Optional[str] = None
    length: Optional[str] = None


class EmailTemplateOut(BaseModel):
    id: str
    owner_user_id: str
    owner_name: Optional[str]
    name: str
    subject: str
    body: str
    tone: str
    length: str
    created_at: str
    updated_at: str


class EmailTemplatesResponse(BaseModel):
    templates: list[EmailTemplateOut]


class ApplyEmailTemplateRequest(BaseModel):
    lead_id: str


class ApplyEmailTemplateResponse(BaseModel):
    subject: str
    body: str
