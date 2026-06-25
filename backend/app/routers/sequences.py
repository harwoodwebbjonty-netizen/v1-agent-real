import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.schemas_sequences import (
    AddSequenceStepRequest,
    CreateSequenceRequest,
    EnrollLeadRequest,
    SequenceEnrollmentOut,
    SequenceEnrollmentsResponse,
    SequenceOut,
    SequenceStepOut,
    SequenceStepsResponse,
    SequencesResponse,
    UpdateSequenceRequest,
)
from app.services.auth_service import new_id, now_iso
from app.services.sequences_service import add_days_iso

router = APIRouter(prefix="/sequences", tags=["sequences"])


def _require_sequence_access(row: sqlite3.Row, current_user: CurrentUser) -> None:
    if row["owner_user_id"] != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="You don't have access to this sequence.")


def _to_sequence_out(row: sqlite3.Row) -> SequenceOut:
    steps = db.list_sequence_steps(row["id"])
    enrollments = db.list_sequence_enrollments(row["id"])
    return SequenceOut(
        id=row["id"],
        name=row["name"],
        owner_user_id=row["owner_user_id"],
        status=row["status"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        step_count=len(steps),
        enrollment_count=len(enrollments),
    )


def _to_step_out(row: sqlite3.Row) -> SequenceStepOut:
    return SequenceStepOut(
        id=row["id"],
        sequence_id=row["sequence_id"],
        step_order=row["step_order"],
        delay_days=row["delay_days"],
        step_type=row["step_type"],
        subject_template=row["subject_template"],
        body_template=row["body_template"],
        created_at=row["created_at"],
    )


def _to_enrollment_out(row: sqlite3.Row) -> SequenceEnrollmentOut:
    return SequenceEnrollmentOut(
        id=row["id"],
        sequence_id=row["sequence_id"],
        lead_id=row["lead_id"],
        lead_company=row["lead_company"],
        current_step=row["current_step"],
        status=row["status"],
        last_error=row["last_error"],
        enrolled_at=row["enrolled_at"],
        next_run_at=row["next_run_at"],
        created_by=row["created_by"],
    )


@router.get("", response_model=SequencesResponse)
def list_sequences(current_user: CurrentUser = Depends(get_current_user)) -> SequencesResponse:
    return SequencesResponse(sequences=[_to_sequence_out(r) for r in db.list_sequences(current_user.id)])


@router.post("", response_model=SequenceOut)
def create_sequence(body: CreateSequenceRequest, current_user: CurrentUser = Depends(get_current_user)) -> SequenceOut:
    sequence_id = new_id()
    db.create_sequence(sequence_id, body.name, current_user.id, now_iso())
    return _to_sequence_out(db.get_sequence(sequence_id))


@router.patch("/{sequence_id}", response_model=SequenceOut)
def update_sequence(
    sequence_id: str, body: UpdateSequenceRequest, current_user: CurrentUser = Depends(get_current_user)
) -> SequenceOut:
    row = db.get_sequence(sequence_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Sequence not found")
    _require_sequence_access(row, current_user)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    db.update_sequence_fields(sequence_id, fields, now_iso())
    return _to_sequence_out(db.get_sequence(sequence_id))


@router.delete("/{sequence_id}")
def delete_sequence(sequence_id: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    row = db.get_sequence(sequence_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Sequence not found")
    _require_sequence_access(row, current_user)
    db.delete_sequence(sequence_id)
    return {"deleted": True}


@router.get("/{sequence_id}/steps", response_model=SequenceStepsResponse)
def list_steps(sequence_id: str, current_user: CurrentUser = Depends(get_current_user)) -> SequenceStepsResponse:
    row = db.get_sequence(sequence_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Sequence not found")
    _require_sequence_access(row, current_user)
    return SequenceStepsResponse(steps=[_to_step_out(r) for r in db.list_sequence_steps(sequence_id)])


@router.post("/{sequence_id}/steps", response_model=SequenceStepOut)
def add_step(
    sequence_id: str, body: AddSequenceStepRequest, current_user: CurrentUser = Depends(get_current_user)
) -> SequenceStepOut:
    row = db.get_sequence(sequence_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Sequence not found")
    _require_sequence_access(row, current_user)

    existing_steps = db.list_sequence_steps(sequence_id)
    step_id = new_id()
    db.add_sequence_step(
        id=step_id,
        sequence_id=sequence_id,
        step_order=len(existing_steps),
        delay_days=body.delay_days,
        step_type=body.step_type,
        subject_template=body.subject_template,
        body_template=body.body_template,
        created_at=now_iso(),
    )
    return _to_step_out(next(s for s in db.list_sequence_steps(sequence_id) if s["id"] == step_id))


@router.delete("/{sequence_id}/steps/{step_id}")
def delete_step(
    sequence_id: str, step_id: str, current_user: CurrentUser = Depends(get_current_user)
) -> dict:
    row = db.get_sequence(sequence_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Sequence not found")
    _require_sequence_access(row, current_user)
    db.delete_sequence_step(step_id)
    return {"deleted": True}


@router.get("/{sequence_id}/enrollments", response_model=SequenceEnrollmentsResponse)
def list_enrollments(
    sequence_id: str, current_user: CurrentUser = Depends(get_current_user)
) -> SequenceEnrollmentsResponse:
    row = db.get_sequence(sequence_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Sequence not found")
    _require_sequence_access(row, current_user)
    return SequenceEnrollmentsResponse(
        enrollments=[_to_enrollment_out(r) for r in db.list_sequence_enrollments(sequence_id)]
    )


@router.post("/{sequence_id}/enrollments", response_model=SequenceEnrollmentOut)
def enroll_lead(
    sequence_id: str, body: EnrollLeadRequest, current_user: CurrentUser = Depends(get_current_user)
) -> SequenceEnrollmentOut:
    sequence = db.get_sequence(sequence_id)
    if sequence is None:
        raise HTTPException(status_code=404, detail="Sequence not found")
    _require_sequence_access(sequence, current_user)

    lead = db.get_lead(body.lead_id)
    if lead is None:
        raise HTTPException(status_code=404, detail="Lead not found")

    steps = db.list_sequence_steps(sequence_id)
    if not steps:
        raise HTTPException(status_code=400, detail="Add at least one step before enrolling leads.")

    enrollment_id = new_id()
    now = now_iso()
    next_run_at = add_days_iso(now, steps[0]["delay_days"])
    db.enroll_lead_in_sequence(enrollment_id, sequence_id, body.lead_id, current_user.id, now, next_run_at)
    return _to_enrollment_out(
        next(e for e in db.list_sequence_enrollments(sequence_id) if e["id"] == enrollment_id)
    )


@router.post("/{sequence_id}/enrollments/{enrollment_id}/stop")
def stop_enrollment(
    sequence_id: str, enrollment_id: str, current_user: CurrentUser = Depends(get_current_user)
) -> dict:
    sequence = db.get_sequence(sequence_id)
    if sequence is None:
        raise HTTPException(status_code=404, detail="Sequence not found")
    _require_sequence_access(sequence, current_user)
    db.update_enrollment(enrollment_id, {"status": "stopped", "next_run_at": None})
    return {"stopped": True}
