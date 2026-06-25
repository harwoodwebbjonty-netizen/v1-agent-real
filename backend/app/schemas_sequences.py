from typing import Literal, Optional

from pydantic import BaseModel

SequenceStatus = Literal["draft", "active", "paused"]
StepType = Literal["email", "call_task", "followup_task", "reminder_task"]
EnrollmentStatus = Literal["active", "completed", "stopped"]


class CreateSequenceRequest(BaseModel):
    name: str


class UpdateSequenceRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[SequenceStatus] = None


class SequenceOut(BaseModel):
    id: str
    name: str
    owner_user_id: str
    status: SequenceStatus
    created_at: str
    updated_at: str
    step_count: int
    enrollment_count: int


class SequencesResponse(BaseModel):
    sequences: list[SequenceOut]


class AddSequenceStepRequest(BaseModel):
    delay_days: int
    step_type: StepType
    subject_template: str = ""
    body_template: str = ""


class SequenceStepOut(BaseModel):
    id: str
    sequence_id: str
    step_order: int
    delay_days: int
    step_type: StepType
    subject_template: str
    body_template: str
    created_at: str


class SequenceStepsResponse(BaseModel):
    steps: list[SequenceStepOut]


class EnrollLeadRequest(BaseModel):
    lead_id: str


class SequenceEnrollmentOut(BaseModel):
    id: str
    sequence_id: str
    lead_id: str
    lead_company: str
    current_step: int
    status: EnrollmentStatus
    last_error: Optional[str]
    enrolled_at: str
    next_run_at: Optional[str]
    created_by: str


class SequenceEnrollmentsResponse(BaseModel):
    enrollments: list[SequenceEnrollmentOut]
