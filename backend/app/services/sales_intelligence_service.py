import json
from functools import lru_cache
from pathlib import Path

import anthropic
from pydantic import ValidationError

from app.core.config import get_settings
from app.schemas_sales_intelligence import SalesIntelligenceResult

# Deliberately isolated from anthropic_service.py and email_scraper_service.py:
# separate workflow file, separate client cache, separate schema, no shared
# functions or imports between any of them beyond the generic `anthropic` SDK
# and `get_settings()` (app-wide config, not feature-specific).

WORKFLOW_PATH = Path(__file__).resolve().parents[3] / "workflows" / "sales_intelligence_research.md"

# This service's research scope (homepage, about, services, careers, blog,
# LinkedIn) is broader than a single phone/email lookup, so its tool-use and
# token budgets are deliberately larger than the other two services' — local
# overrides only, the shared `settings.max_pause_turn_continuations` (3) used
# by the other services is left untouched.
RESEARCH_TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 10},
    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 10},
]
MAX_RESEARCH_CONTINUATIONS = 6
RESEARCH_MAX_TOKENS = 8192
EXTRACTION_MAX_TOKENS = 4096
MAX_EXTRACTION_ATTEMPTS = 2  # initial attempt + 1 retry against the same research text

SYSTEM_PREAMBLE = (
    "You are performing the 'AI Sales Intelligence Research' workflow below "
    "exactly as specified, including its deterministic scoring rubric. Work "
    "through the source categories in order; don't stop at the first dead "
    "end.\n\n"
)

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "executive_summary": {"type": "string"},
        "sales_summary": {"type": "string"},
        "pain_points": {
            "type": "object",
            "properties": {
                "operational": {"type": "array", "items": {"type": "string"}},
                "sales_revenue": {"type": "array", "items": {"type": "string"}},
                "recruitment_scaling": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["operational", "sales_revenue", "recruitment_scaling"],
            "additionalProperties": False,
        },
        "buying_signals": {"type": "array", "items": {"type": "string"}},
        "conversation_starters": {"type": "array", "items": {"type": "string"}},
        "discovery_questions": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 10,
            "maxItems": 15,
        },
        "objection_handling": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["price", "timing", "competitor", "internal_solution", "other"],
                    },
                    "objection": {"type": "string"},
                    "response": {"type": "string"},
                },
                "required": ["category", "objection", "response"],
                "additionalProperties": False,
            },
        },
        "pitch_angle": {"type": "string"},
        "call_brief": {"type": "string"},
        "score_breakdown": {
            "type": "object",
            "properties": {
                "company_maturity": {"type": "integer", "minimum": 0, "maximum": 20},
                "hiring_intensity": {"type": "integer", "minimum": 0, "maximum": 20},
                "growth_signals": {"type": "integer", "minimum": 0, "maximum": 20},
                "buying_intent": {"type": "integer", "minimum": 0, "maximum": 20},
                "accessibility_fit": {"type": "integer", "minimum": 0, "maximum": 20},
            },
            "required": [
                "company_maturity",
                "hiring_intensity",
                "growth_signals",
                "buying_intent",
                "accessibility_fit",
            ],
            "additionalProperties": False,
        },
        "lead_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "lead_temperature": {"type": "string", "enum": ["Hot", "Warm", "Cold"]},
        "confidence_note": {"type": "string"},
    },
    "required": [
        "executive_summary",
        "sales_summary",
        "pain_points",
        "buying_signals",
        "conversation_starters",
        "discovery_questions",
        "objection_handling",
        "pitch_angle",
        "call_brief",
        "score_breakdown",
        "lead_score",
        "lead_temperature",
        "confidence_note",
    ],
    "additionalProperties": False,
}


class IntelligenceExtractionError(Exception):
    """Raised when research or extraction fails terminally — the router
    converts this into a clean 502 and writes no version row."""


@lru_cache
def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key)


@lru_cache
def _workflow_text() -> str:
    return WORKFLOW_PATH.read_text()


async def _research(company: str, website: str, max_uses: int = 5) -> str:
    """Phase 1: agentic research with web_search/web_fetch. Raises
    IntelligenceExtractionError on a terminal failure (refusal / continuation
    limit exhausted / no text produced) — there's no sensible "not found"
    placeholder for a whole sales dossier the way there is for a single
    phone number or email address."""
    settings = get_settings()
    client = _client()
    system_prompt = SYSTEM_PREAMBLE + _workflow_text()
    website_line = f" Known website: {website}." if website else ""
    original_message = {
        "role": "user",
        "content": f"Research this company for sales call preparation: {company}.{website_line}",
    }
    messages = [original_message]
    research_tools = [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": max_uses},
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": max_uses},
    ]

    response = await client.messages.create(
        model=settings.model,
        max_tokens=RESEARCH_MAX_TOKENS,
        system=system_prompt,
        messages=messages,
        tools=research_tools,
    )

    continuations = 0
    while response.stop_reason == "pause_turn" and continuations < MAX_RESEARCH_CONTINUATIONS:
        messages = [original_message, {"role": "assistant", "content": response.content}]
        response = await client.messages.create(
            model=settings.model,
            max_tokens=RESEARCH_MAX_TOKENS,
            system=system_prompt,
            messages=messages,
            tools=research_tools,
        )
        continuations += 1

    if response.stop_reason == "refusal":
        raise IntelligenceExtractionError("Request was declined by the model's safety classifiers.")
    if response.stop_reason == "pause_turn":
        raise IntelligenceExtractionError("Research did not complete within the continuation limit.")

    text = "\n".join(block.text for block in response.content if block.type == "text")
    if not text:
        raise IntelligenceExtractionError("No research text was produced.")
    return text


async def _extract(research_text: str) -> SalesIntelligenceResult:
    """Phase 2: structured extraction. Separate call because structured
    outputs and web_search/web_fetch citations cannot be combined in one
    request. May raise json.JSONDecodeError or pydantic.ValidationError
    (including the rubric-sum/band mismatch from SalesIntelligenceResult's
    own validator) — the caller treats both as a retryable extraction
    failure."""
    settings = get_settings()
    client = _client()

    response = await client.messages.create(
        model=settings.extraction_model,
        max_tokens=EXTRACTION_MAX_TOKENS,
        system=(
            "Extract the structured sales-intelligence result from the research notes "
            "below, following the deterministic scoring rubric exactly: lead_score must "
            "equal the sum of score_breakdown's five categories, and lead_temperature "
            "must match the score band (80-100 Hot, 50-79 Warm, 0-49 Cold)."
        ),
        messages=[{"role": "user", "content": research_text}],
        output_config={"format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
    )

    extraction_text = next(
        (block.text for block in response.content if block.type == "text"), "{}"
    )
    data = json.loads(extraction_text)
    return SalesIntelligenceResult(**data)


async def generate_sales_intelligence(company: str, website: str, max_uses: int = 5) -> SalesIntelligenceResult:
    try:
        research_text = await _research(company, website, max_uses=max_uses)
    except anthropic.APIError as exc:
        raise IntelligenceExtractionError(f"Anthropic API error during research: {exc}") from exc

    last_error: Exception = IntelligenceExtractionError("Extraction did not run.")
    for _ in range(MAX_EXTRACTION_ATTEMPTS):
        try:
            return await _extract(research_text)
        except (json.JSONDecodeError, ValidationError, anthropic.APIError) as exc:
            last_error = exc

    raise IntelligenceExtractionError(
        f"AI returned an incomplete or invalid result after retrying: {last_error}"
    )
