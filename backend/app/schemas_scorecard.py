from typing import Dict, List, Literal, Optional

from pydantic import BaseModel

MetricKey = Literal["calls", "talk_time", "leads", "campaigns", "follow_up", "crm"]
NotesVisibility = Literal["team", "manager_only"]


class ScorecardEntryIn(BaseModel):
    actual: Optional[float] = None
    notes: str = ""
    action: str = ""


class ScorecardEntryOut(BaseModel):
    metric_key: str
    actual: Optional[float] = None
    notes: str = ""
    action: str = ""
    source: str = "manual"
    updated_at: str


class UpsertScorecardWeekRequest(BaseModel):
    review_date: str = ""
    entries: Dict[str, ScorecardEntryIn] = {}


class ScorecardWeekOut(BaseModel):
    id: str
    user_id: str
    week_commencing: str
    review_date: str = ""
    saved_at: Optional[str] = None
    entries: Dict[str, ScorecardEntryOut] = {}


class ScorecardWeeksResponse(BaseModel):
    weeks: List[ScorecardWeekOut]


class ScorecardSummaryEntry(BaseModel):
    user_id: str
    week_commencing: str
    saved_at: Optional[str] = None
    metric_key: str
    actual: Optional[float] = None
    source: str = "manual"


class ScorecardSummaryResponse(BaseModel):
    entries: List[ScorecardSummaryEntry]


class ScorecardMetricTargetOut(BaseModel):
    metric_key: str
    target_value: float
    auto_tracked: bool


class ScorecardSettingsOut(BaseModel):
    green_threshold: float
    amber_threshold: float
    qualifying_field: str
    qualifying_value: str
    notes_visibility: NotesVisibility
    targets: List[ScorecardMetricTargetOut]


class UpdateScorecardSettingsRequest(BaseModel):
    green_threshold: Optional[float] = None
    amber_threshold: Optional[float] = None
    qualifying_field: Optional[str] = None
    qualifying_value: Optional[str] = None
    notes_visibility: Optional[NotesVisibility] = None
    targets: Optional[Dict[str, float]] = None
