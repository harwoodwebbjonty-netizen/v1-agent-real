from typing import Literal, Optional

from pydantic import BaseModel

ListCampaignStatus = Literal["generating", "ready", "stopped", "error"]


class CreateListCampaignRequest(BaseModel):
    # Exactly one of list_id (a saved cold-call list) or lead_ids (an ad-hoc,
    # hand-picked set of leads) must be given — see create_campaign().
    list_id: str = ""
    lead_ids: list[str] = []
    name: str = ""
    idea: str
    offers: str = ""
    link_url: str = ""
    link_text: str = ""
    signature: str = ""


class ListCampaignOut(BaseModel):
    id: str
    list_id: str
    name: str
    status: ListCampaignStatus
    total_target: int
    generated: int
    created_at: str
    updated_at: str


class ListCampaignsResponse(BaseModel):
    campaigns: list[ListCampaignOut]


class CampaignDraftOut(BaseModel):
    id: str
    lead_id: str
    company: str
    contact_name: str
    contact_status: str
    contact_email: str
    subject: str
    body: str
    status: str
    sent_via: Optional[str]
    sent_at: Optional[str]


class CampaignDraftsResponse(BaseModel):
    drafts: list[CampaignDraftOut]


class SendCampaignRequest(BaseModel):
    provider: Literal["gmail", "microsoft"]
