from pydantic import BaseModel


class EnrichLeadRequest(BaseModel):
    company: str
    notes: str
    industry: str


class EnrichLeadResult(BaseModel):
    industry_suggestion: str
    company_summary: str
    call_prep_summary: str
    confidence_note: str
