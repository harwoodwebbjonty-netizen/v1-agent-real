from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.schemas_call_logs import CallLogOut, CallLogsResponse, CreateCallLogRequest
from app.services.auth_service import new_id, now_iso

router = APIRouter(prefix="/call-logs", tags=["call-logs"])


def _to_call_log_out(row) -> CallLogOut:
    return CallLogOut(
        id=row["id"],
        lead_id=row["lead_id"],
        calendar_event_id=row["calendar_event_id"],
        outcome=row["outcome"],
        notes=row["notes"],
        duration_seconds=row["duration_seconds"],
        created_by=row["created_by"],
        created_at=row["created_at"],
    )


@router.get("/lead/{lead_id}", response_model=CallLogsResponse)
def list_call_logs(lead_id: str, current_user: CurrentUser = Depends(get_current_user)) -> CallLogsResponse:
    if db.get_lead(lead_id) is None:
        raise HTTPException(status_code=404, detail="Lead not found")
    rows = db.list_call_logs_for_lead(lead_id)
    return CallLogsResponse(call_logs=[_to_call_log_out(r) for r in rows])


@router.post("", response_model=CallLogOut)
def create_call_log(
    body: CreateCallLogRequest, current_user: CurrentUser = Depends(get_current_user)
) -> CallLogOut:
    if db.get_lead(body.lead_id) is None:
        raise HTTPException(status_code=404, detail="Lead not found")

    log_id = new_id()
    created_at = now_iso()
    db.create_call_log(
        id=log_id,
        lead_id=body.lead_id,
        calendar_event_id=body.calendar_event_id,
        outcome=body.outcome,
        notes=body.notes,
        duration_seconds=body.duration_seconds,
        created_by=current_user.id,
        created_at=created_at,
    )
    return _to_call_log_out(db.get_latest_call_log_for_lead(body.lead_id))
