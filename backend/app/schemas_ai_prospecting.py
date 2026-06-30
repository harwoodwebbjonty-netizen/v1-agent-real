from typing import Optional

from pydantic import BaseModel


class ProspectingCriteria(BaseModel):
    sic_codes: list[str] = []
    location: str = ""
    company_type: str = "ltd"
    incorporated_from: str = ""
    incorporated_to: str = ""
    max_results: int = 50
    min_ch_score: int = 0
    run_ai_enrichment: bool = False


class StartProspectingResponse(BaseModel):
    run_id: str
    message: str


class ProspectingRunOut(BaseModel):
    id: str
    status: str
    criteria: str
    found: int
    created: int
    skipped: int
    error: Optional[str]
    started_at: str
    completed_at: Optional[str]
