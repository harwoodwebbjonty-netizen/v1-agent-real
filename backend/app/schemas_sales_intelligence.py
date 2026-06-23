from typing import Literal

from pydantic import BaseModel, model_validator

ObjectionCategory = Literal["price", "timing", "competitor", "internal_solution", "other"]
LeadTemperature = Literal["Hot", "Warm", "Cold"]


class ScoreBreakdown(BaseModel):
    company_maturity: int
    hiring_intensity: int
    growth_signals: int
    buying_intent: int
    accessibility_fit: int


class PainPoints(BaseModel):
    operational: list[str]
    sales_revenue: list[str]
    recruitment_scaling: list[str]


class ObjectionResponse(BaseModel):
    category: ObjectionCategory
    objection: str
    response: str


def _temperature_for_score(score: int) -> LeadTemperature:
    if score >= 80:
        return "Hot"
    if score >= 50:
        return "Warm"
    return "Cold"


class SalesIntelligenceResult(BaseModel):
    executive_summary: str
    sales_summary: str
    pain_points: PainPoints
    buying_signals: list[str]
    conversation_starters: list[str]
    discovery_questions: list[str]
    objection_handling: list[ObjectionResponse]
    pitch_angle: str
    call_brief: str
    score_breakdown: ScoreBreakdown
    lead_score: int
    lead_temperature: LeadTemperature
    confidence_note: str

    @model_validator(mode="after")
    def _validate_rubric(self) -> "SalesIntelligenceResult":
        breakdown_sum = (
            self.score_breakdown.company_maturity
            + self.score_breakdown.hiring_intensity
            + self.score_breakdown.growth_signals
            + self.score_breakdown.buying_intent
            + self.score_breakdown.accessibility_fit
        )
        if breakdown_sum != self.lead_score:
            raise ValueError(
                f"lead_score ({self.lead_score}) must equal the sum of score_breakdown ({breakdown_sum})"
            )
        if not (0 <= self.lead_score <= 100):
            raise ValueError(f"lead_score ({self.lead_score}) must be between 0 and 100")
        expected_temperature = _temperature_for_score(self.lead_score)
        if self.lead_temperature != expected_temperature:
            raise ValueError(
                f"lead_temperature ({self.lead_temperature}) does not match the band for "
                f"lead_score {self.lead_score} (expected {expected_temperature})"
            )
        if not (10 <= len(self.discovery_questions) <= 15):
            raise ValueError(
                f"discovery_questions must contain 10-15 items, got {len(self.discovery_questions)}"
            )
        return self


class LeadIntelligenceOut(BaseModel):
    executive_summary: str
    sales_summary: str
    pain_points: PainPoints
    buying_signals: list[str]
    conversation_starters: list[str]
    discovery_questions: list[str]
    objection_handling: list[ObjectionResponse]
    pitch_angle: str
    call_brief: str
    score_breakdown: ScoreBreakdown
    lead_score: int
    lead_temperature: LeadTemperature
    confidence_note: str
    generated_at: str
    updated_at: str
    version_count: int


class LeadIntelligenceVersionOut(BaseModel):
    id: str
    executive_summary: str
    sales_summary: str
    pain_points: PainPoints
    buying_signals: list[str]
    conversation_starters: list[str]
    discovery_questions: list[str]
    objection_handling: list[ObjectionResponse]
    pitch_angle: str
    call_brief: str
    score_breakdown: ScoreBreakdown
    lead_score: int
    lead_temperature: LeadTemperature
    confidence_note: str
    created_at: str


class LeadIntelligenceHistoryResponse(BaseModel):
    versions: list[LeadIntelligenceVersionOut]
