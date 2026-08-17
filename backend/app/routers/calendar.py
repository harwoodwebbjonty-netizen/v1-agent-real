import logging
import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.schemas_calendar import (
    CalendarEventOut,
    CalendarEventsResponse,
    CreateCalendarEventRequest,
    UpdateCalendarEventRequest,
)
from app.services.auth_service import new_id, now_iso
from app.services.calendar_oauth_service import OAuthError, push_event_to_calendar

logger = logging.getLogger("app.calendar")

router = APIRouter(prefix="/calendar-events", tags=["calendar"])


async def _push_to_connected_calendar(current_user: CurrentUser, body: CreateCalendarEventRequest) -> None:
    """Best-effort, one-way (CRM -> external) push — see
    calendar_oauth_service.push_event_to_calendar's docstring for the scope
    decision. Never raises: a failed external push must not fail the local
    event creation the rep is actually waiting on."""
    for provider in ("gmail", "microsoft"):
        account = db.get_calendar_oauth_account(current_user.id, provider)
        if account is None:
            continue
        try:
            await push_event_to_calendar(account, body.title, body.description, body.date, body.time)
        except OAuthError:
            logger.warning("Failed to push calendar event to %s for user %s", provider, current_user.id)


def _to_event_out(row: sqlite3.Row) -> CalendarEventOut:
    return CalendarEventOut(
        id=row["id"],
        owner_user_id=row["owner_user_id"],
        title=row["title"],
        date=row["date"],
        time=row["time"],
        type=row["type"],
        lead_id=row["lead_id"],
        description=row["description"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _require_event_access(row: sqlite3.Row, current_user: CurrentUser) -> None:
    if row["owner_user_id"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You don't have access to this event.")


@router.get("", response_model=CalendarEventsResponse)
def list_events(current_user: CurrentUser = Depends(get_current_user)) -> CalendarEventsResponse:
    rows = db.list_calendar_events(current_user.id)
    return CalendarEventsResponse(events=[_to_event_out(r) for r in rows])


@router.post("", response_model=CalendarEventOut)
async def create_event(
    body: CreateCalendarEventRequest, current_user: CurrentUser = Depends(get_current_user)
) -> CalendarEventOut:
    event_id = new_id()
    created_at = now_iso()
    db.create_calendar_event(
        id=event_id,
        owner_user_id=current_user.id,
        title=body.title,
        date=body.date,
        time=body.time,
        type=body.type,
        lead_id=body.lead_id,
        description=body.description,
        created_at=created_at,
    )
    await _push_to_connected_calendar(current_user, body)
    return _to_event_out(db.get_calendar_event(event_id))


@router.patch("/{event_id}", response_model=CalendarEventOut)
def update_event(
    event_id: str, body: UpdateCalendarEventRequest, current_user: CurrentUser = Depends(get_current_user)
) -> CalendarEventOut:
    row = db.get_calendar_event(event_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Event not found")
    _require_event_access(row, current_user)

    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    db.update_calendar_event_fields(event_id, fields, now_iso())
    return _to_event_out(db.get_calendar_event(event_id))


@router.delete("/{event_id}")
def delete_event(event_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    row = db.get_calendar_event(event_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Event not found")
    _require_event_access(row, current_user)
    db.delete_calendar_event(event_id)
    return {"deleted": True}
