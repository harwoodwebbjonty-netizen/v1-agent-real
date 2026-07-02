from typing import Optional

from pydantic import BaseModel


class ProspectingCriteria(BaseModel):
    name: str = ""
    sic_codes: list[str] = []
    locations: list[str] = []
    location: str = ""  # kept for backward compat with stored JSON
    company_type: str = "ltd"
    incorporated_from: str = ""
    incorporated_to: str = ""
    max_results: int = 50
    min_ch_score: int = 0
    run_ai_enrichment: bool = False
    # Charge filters
    charge_types: list[str] = []
    active_charges_only: bool = False
    include_satisfied: bool = True
    new_charges_only: bool = False
    charge_registered_from: str = ""
    charge_registered_to: str = ""
    min_charges: int = 0
    max_charges: int = 0


class StartProspectingResponse(BaseModel):
    run_id: str
    message: str


class ProspectingRunOut(BaseModel):
    id: str
    name: str
    status: str
    criteria: str
    found: int
    created: int
    skipped: int
    error: Optional[str]
    started_at: str
    completed_at: Optional[str]
    list_id: Optional[str] = None
