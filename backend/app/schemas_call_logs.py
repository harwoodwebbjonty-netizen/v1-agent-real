from typing import Literal, Optional

from pydantic import BaseModel

CallOutcome = Literal["connected", "voicemail", "no_answer", "wrong_number", "other"]


class CreateCallLogRequest(BaseModel):
    lead_id: str
    calendar_event_id: Optional[str] = None
    outcome: CallOutcome
    notes: str = ""
    duration_seconds: Optional[int] = None


class CallLogOut(BaseModel):
    id: str
    lead_id: str
    calendar_event_id: Optional[str]
    outcome: str
    notes: str
    duration_seconds: Optional[int]
    created_by: str
    created_at: str


class CallLogsResponse(BaseModel):
    call_logs: list[CallLogOut]
