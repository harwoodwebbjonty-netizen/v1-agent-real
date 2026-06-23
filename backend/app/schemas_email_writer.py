from typing import Optional

from pydantic import BaseModel

PRESETS = (
    "Cold Outreach",
    "Follow Up",
    "Breakup Email",
    "Meeting Request",
    "Proposal Follow Up",
    "Recruitment Outreach",
    "Partnership Outreach",
    "Re-Engagement",
    "Customer Retention",
    "Custom",
)
LENGTHS = ("Short", "Medium", "Long")


class EmailDraftResult(BaseModel):
    subject: str
    body: str
    estimated_open_rate: float
    estimated_reply_rate: float
    estimated_readability_score: float


class PersonalisationOption(BaseModel):
    hook: str
    pain_point_observation: str
    growth_observation: str
    opportunity_statement: str


class GenerateEmailRequest(BaseModel):
    instruction: str
    preset: str = "Custom"
    length: str = "Medium"


class RefineEmailRequest(BaseModel):
    instruction: str


class UpdateEmailDraftRequest(BaseModel):
    subject: Optional[str] = None
    body: Optional[str] = None


class EmailDraftOut(BaseModel):
    id: str
    lead_id: str
    owner_user_id: str
    subject: str
    body: str
    tone: str
    length: str
    status: str
    sent_via: Optional[str]
    sent_at: Optional[str]
    estimated_open_rate: Optional[float]
    estimated_reply_rate: Optional[float]
    estimated_readability_score: Optional[float]
    created_at: str
    updated_at: str


class EmailDraftsResponse(BaseModel):
    drafts: list[EmailDraftOut]


class PersonalisationRequest(BaseModel):
    count: int = 3


class PersonalisationResponse(BaseModel):
    options: list[PersonalisationOption]


class CtaSuggestionsRequest(BaseModel):
    goal: str


class CtaSuggestionsResponse(BaseModel):
    ctas: list[str]


class TimelineEntryOut(BaseModel):
    timestamp: str
    type: str
    summary: str


class TimelineResponse(BaseModel):
    entries: list[TimelineEntryOut]


class SendEmailDraftRequest(BaseModel):
    provider: str
