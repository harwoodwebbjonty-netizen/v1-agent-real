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

# --- Hard per-lead cost bound: tool use REMOVED from research (2026-07-17) ---
#
# Real cost was measured at $2 (standard depth), then $1.20 AFTER adding
# max_content_tokens to bound web_fetch — meaning that parameter did not
# actually prevent the blowup in practice. $1.20 is consistent with ~3
# large, effectively-unbounded fetches (~130k tokens each) landing in a
# single turn before any between-turn ceiling check could run. Investigating
# further also surfaced a second, separate unknown: web_search_20260209
# defaults to dynamic filtering via an auto-provisioned code-execution
# sandbox, and each search can return multiple results with unspecified
# encrypted_content size — a second cost path with no verifiable client-side
# bound.
#
# Two real, live-tested attempts at bounding server-tool cost have now both
# failed to match their documented behavior closely enough to trust for a
# hard guarantee. Rather than a third probabilistic fix, tool use is removed
# from research entirely: no web_search, no web_fetch, no server-executed
# content of any size ever enters the request. The model answers from its
# own trained knowledge of the company (plus the website URL and any
# LinkedIn post context already fetched separately and safely via Apify)
# instead of live web lookups. This is a real quality trade — research is
# no longer current/live — made deliberately in exchange for a cost bound
# that is actually mathematically fixed: system prompt (workflow file, ~1.6k
# tokens, fixed) + short user message + RESEARCH_MAX_TOKENS output cap, and
# nothing else, ever.
RESEARCH_MAX_TOKENS = 2000
EXTRACTION_MAX_TOKENS = 4096
MAX_EXTRACTION_ATTEMPTS = 2  # initial attempt + 1 retry against the same research text

SYSTEM_PREAMBLE = (
    "You are performing the 'AI Sales Intelligence Research' workflow below "
    "exactly as specified, including its deterministic scoring rubric. You "
    "have no live web search or browsing tool — you cannot fetch anything "
    "yourself. The user message may already include real, current text "
    "pulled from the company's own website and/or their recent LinkedIn "
    "posts; when present, treat that as ground truth and prioritise it over "
    "general industry-level inference. When it is absent for a given "
    "company, work from your own knowledge and say plainly where you're "
    "uncertain rather than guessing at specifics like recent news or "
    "headcount. Never claim to have searched, fetched, or browsed anything "
    "yourself — only reference what's explicitly provided.\n\n"
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
            # No minItems/maxItems here: Anthropic's structured-output schema
            # only supports minItems of 0 or 1, so a literal 10/15 constraint
            # gets rejected outright (400 invalid_request_error) rather than
            # just being ignored. The 10-15 count is still enforced for real
            # by SalesIntelligenceResult's model_validator after parsing,
            # which already triggers the existing extraction retry loop —
            # see the explicit instruction in the extraction system prompt
            # below for how the model is told the count without the schema.
            "type": "array",
            "items": {"type": "string"},
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
            # No minimum/maximum on the integer fields below: Anthropic's
            # structured-output schema does not support numeric constraints
            # at all (rejected outright with a 400, same failure mode as the
            # discovery_questions minItems issue above) — the 0-20 range is
            # stated in the extraction system prompt instead, and the real
            # 0-100/sum-matches-lead_score rubric is enforced for real by
            # SalesIntelligenceResult's model_validator after parsing.
            "type": "object",
            "properties": {
                "company_maturity": {"type": "integer"},
                "hiring_intensity": {"type": "integer"},
                "growth_signals": {"type": "integer"},
                "buying_intent": {"type": "integer"},
                "accessibility_fit": {"type": "integer"},
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
        "lead_score": {"type": "integer"},
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


async def _research(
    company: str, website: str, max_uses: int = 5, linkedin_context: str = "", website_content: str = "",
) -> str:
    """Phase 1: a single, tool-free Sonnet call. No web_search, no
    web_fetch — see the module-level comment for why. `max_uses` is accepted
    for backward compatibility with every caller (win_back.py's depth
    selector, leads.py, ai_prospecting_service.py) but has no effect; it's
    not removed from the signature so none of them need a matching change.
    `linkedin_context`/`website_content` are real data, pre-fetched and
    pre-truncated by the caller (website_content_service.fetch_website_text,
    linkedin_activity_service) — this function never fetches anything
    itself. Cost is fixed and known ahead of time: system prompt + user
    message (bounded by those callers' own hard truncation, not a remote
    parameter) + RESEARCH_MAX_TOKENS output cap, nothing else can ever enter
    this call. Raises IntelligenceExtractionError only on a true dead end
    (refusal / no text produced at all)."""
    settings = get_settings()
    client = _client()
    system_prompt = SYSTEM_PREAMBLE + _workflow_text()
    website_line = f" Known website: {website}." if website else ""
    website_block = (
        f"\n\nText from the company's own website (already fetched):\n{website_content}"
        if website_content else ""
    )
    linkedin_block = (
        f"\n\nKnown recent LinkedIn posts (already fetched):\n{linkedin_context}"
        if linkedin_context else ""
    )
    original_message = {
        "role": "user",
        "content": (
            f"Research this company for sales call preparation, using your own knowledge plus "
            f"the real data already fetched below (no live web access is available for this "
            f"step beyond what's given here): {company}.{website_line}{website_block}{linkedin_block}"
        ),
    }

    response = await client.messages.create(
        model=settings.model,
        max_tokens=RESEARCH_MAX_TOKENS,
        system=system_prompt,
        messages=[original_message],
    )

    if response.stop_reason == "refusal":
        raise IntelligenceExtractionError("Request was declined by the model's safety classifiers.")

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
            "below, following the deterministic scoring rubric exactly: each of "
            "score_breakdown's five categories (company_maturity, hiring_intensity, "
            "growth_signals, buying_intent, accessibility_fit) must be an integer "
            "0-20, lead_score must be an integer 0-100 equal to the sum of those "
            "five categories, and lead_temperature must match the score band "
            "(80-100 Hot, 50-79 Warm, 0-49 Cold). "
            "discovery_questions must contain exactly 10 to 15 items."
        ),
        messages=[{"role": "user", "content": research_text}],
        output_config={"format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
    )

    extraction_text = next(
        (block.text for block in response.content if block.type == "text"), "{}"
    )
    data = json.loads(extraction_text)
    return SalesIntelligenceResult(**data)


async def generate_sales_intelligence(
    company: str, website: str, max_uses: int = 5, linkedin_context: str = "", website_content: str = "",
) -> SalesIntelligenceResult:
    try:
        research_text = await _research(
            company, website, max_uses=max_uses, linkedin_context=linkedin_context, website_content=website_content,
        )
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
