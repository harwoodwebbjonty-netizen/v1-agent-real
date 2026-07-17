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

# Real per-lead cost was measured at $2+ at "standard" depth (max_uses=5) —
# each pause_turn continuation resends the ENTIRE accumulated conversation
# (every prior tool-call result, including full fetched-page content) as
# fresh input tokens, so cost compounds with turns, not just tool-call count.
# max_uses alone can't guarantee a dollar ceiling, so _research() tracks real
# spend via response.usage after every turn and stops issuing further
# continuations once this is hit. The check only runs BEFORE starting a new
# turn, so the turn already in flight when the ceiling is crossed still gets
# billed — and because each turn resends everything before it, that one
# extra turn can cost roughly as much as everything accumulated so far
# (worst case, close to doubling the running total). Set low enough that
# 2x the ceiling plus the ~$0.06-worst-case extraction call still lands
# under a $0.50/lead hard requirement with real margin, not by accident.
# Sonnet pricing ($3/MTok in, $15/MTok out) per https://platform.claude.com/docs
# (checked this session) — revisit if pricing changes.
RESEARCH_COST_CEILING_USD = 0.20
SONNET_INPUT_COST_PER_TOKEN = 3 / 1_000_000
SONNET_OUTPUT_COST_PER_TOKEN = 15 / 1_000_000
WEB_SEARCH_COST_PER_QUERY = 10 / 1_000  # $10 per 1,000 searches, billed flat per query

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


def _response_cost_usd(response) -> float:
    """Real $ cost of one research turn from the API's own reported usage —
    not an estimate. Token cost captures the dominant compounding driver
    (each pause_turn continuation resends the whole conversation, including
    prior fetched-page content, as fresh input tokens); usage.server_tool_use
    gives the exact web_search query count for its separate flat per-query
    fee (web_fetch has no flat fee, only token cost, already covered above)."""
    usage = response.usage
    cost = usage.input_tokens * SONNET_INPUT_COST_PER_TOKEN + usage.output_tokens * SONNET_OUTPUT_COST_PER_TOKEN
    if usage.server_tool_use:
        cost += usage.server_tool_use.web_search_requests * WEB_SEARCH_COST_PER_QUERY
    return cost


async def _research(company: str, website: str, max_uses: int = 5, linkedin_context: str = "") -> str:
    """Phase 1: agentic research with web_search/web_fetch. Raises
    IntelligenceExtractionError only on a true dead end (refusal / no text
    produced at all) — there's no sensible "not found" placeholder for a
    whole sales dossier the way there is for a single phone number or email
    address. Hitting the continuation limit or the cost ceiling is NOT
    treated as failure: whatever text has been produced so far is salvaged
    and used, rather than discarding real spend for zero output."""
    settings = get_settings()
    client = _client()
    system_prompt = SYSTEM_PREAMBLE + _workflow_text()
    website_line = f" Known website: {website}." if website else ""
    linkedin_block = (
        f"\n\nKnown recent LinkedIn posts (already fetched — use this directly instead of "
        f"trying web_fetch on linkedin.com):\n{linkedin_context}"
        if linkedin_context else ""
    )
    original_message = {
        "role": "user",
        "content": f"Research this company for sales call preparation: {company}.{website_line}{linkedin_block}",
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
    running_cost = _response_cost_usd(response)

    continuations = 0
    while (
        response.stop_reason == "pause_turn"
        and continuations < MAX_RESEARCH_CONTINUATIONS
        and running_cost < RESEARCH_COST_CEILING_USD
    ):
        messages = [original_message, {"role": "assistant", "content": response.content}]
        response = await client.messages.create(
            model=settings.model,
            max_tokens=RESEARCH_MAX_TOKENS,
            system=system_prompt,
            messages=messages,
            tools=research_tools,
        )
        running_cost += _response_cost_usd(response)
        continuations += 1

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


async def generate_sales_intelligence(company: str, website: str, max_uses: int = 5, linkedin_context: str = "") -> SalesIntelligenceResult:
    try:
        research_text = await _research(company, website, max_uses=max_uses, linkedin_context=linkedin_context)
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
