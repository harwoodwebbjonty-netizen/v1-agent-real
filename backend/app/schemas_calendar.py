from typing import Literal, Optional

from pydantic import BaseModel

CalendarEventType = Literal["call", "followup", "task"]


class CreateCalendarEventRequest(BaseModel):
    title: str
    date: str
    time: str = ""
    type: CalendarEventType
    lead_id: Optional[str] = None
    description: str = ""


class UpdateCalendarEventRequest(BaseModel):
    title: Optional[str] = None
    date: Optional[str] = None
    time: Optional[str] = None
    type: Optional[CalendarEventType] = None
    lead_id: Optional[str] = None
    description: Optional[str] = None


class CalendarEventOut(BaseModel):
    id: str
    owner_user_id: str
    title: str
    date: str
    time: str
    type: str
    lead_id: Optional[str]
    description: str
    created_at: str
    updated_at: str


class CalendarEventsResponse(BaseModel):
    events: list[CalendarEventOut]
