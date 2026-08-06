from typing import Literal, Optional

from pydantic import BaseModel

from app.schemas_contacts import EmailOut, PhoneOut
from app.schemas_sales_intelligence import LeadIntelligenceOut

OpportunityStage = Literal["none", "engaged", "opportunity", "proposal", "won", "lost"]


class CreateLeadRequest(BaseModel):
    company: str
    list_id: Optional[str] = None


class UpdateLeadRequest(BaseModel):
    industry: Optional[str] = None
    contact_status: Optional[str] = None
    lead_notes: Optional[str] = None
    contact_name: Optional[str] = None
    contact_title: Optional[str] = None
    website: Optional[str] = None
    linkedin: Optional[str] = None
    opportunity_stage: Optional[OpportunityStage] = None


class NextBestActionOut(BaseModel):
    action: str
    reason: str


class AssignLeadRequest(BaseModel):
    assigned_user_id: Optional[str] = None


class LeadOut(BaseModel):
    id: str
    timestamp: str
    company: str
    phone_number: str
    source_url: str
    # Phone-verification status for AI-looked-up leads is "verified"/"unverified"/
    # "not_found", but imported/migrated leads carry whatever their source CSV set
    # (commonly "New"). Keep this a plain str — a strict Literal here made a single
    # unexpected value raise ValidationError and 500 the WHOLE /leads list, wiping
    # every lead from the UI at once.
    status: str
    notes: str
    industry: str
    contact_status: str
    lead_notes: str
    contact_name: str
    contact_title: str
    website: str
    linkedin: str
    owner_user_id: Optional[str]
    owner_name: Optional[str]
    assigned_user_id: Optional[str]
    assigned_name: Optional[str]
    list_id: Optional[str]
    opportunity_stage: OpportunityStage
    next_best_action: NextBestActionOut
    company_number: Optional[str] = None
    ch_data: Optional[str] = None
    called_at: Optional[str] = None
    follow_up_at: Optional[str] = None
    priority_score: int = 0
    priority_breakdown: Optional[str] = None
    list_name: Optional[str] = None
    phones: list[PhoneOut]
    emails: list[EmailOut]
    intelligence: Optional[LeadIntelligenceOut]


class LeadListResponse(BaseModel):
    leads: list[LeadOut]


class MigrateRequest(BaseModel):
    leads: list[dict]


class MigrateResponse(BaseModel):
    imported: int


class CreateLeadListRequest(BaseModel):
    name: str
    for_user_id: str | None = None


class LeadListOut(BaseModel):
    id: str
    name: str
    owner_user_id: str
    owner_name: Optional[str]
    created_at: str
    lead_count: int


class LeadListsResponse(BaseModel):
    lists: list[LeadListOut]


class ImportLeadsRequest(BaseModel):
    leads: list[dict]


class ImportLeadsResponse(BaseModel):
    imported: int
