import json
from functools import lru_cache
from typing import Optional, Tuple

import anthropic

from app.core.config import get_settings, get_workflow_text
from app.schemas import LookupResult

SYSTEM_PREAMBLE = (
    "You are performing the 'Find Company Phone Number' workflow below exactly "
    "as specified. Work through the steps in order; don't stop at the first dead "
    "end. At the end, state clearly: the phone number (or 'not_found'), the "
    "source URL, and a one-line confidence note.\n\n"
)

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "company": {"type": "string"},
        "phone_number": {"type": "string"},
        "source_url": {"type": "string"},
        "status": {"type": "string", "enum": ["verified", "unverified", "not_found"]},
        "notes": {"type": "string"},
    },
    "required": ["company", "phone_number", "source_url", "status", "notes"],
    "additionalProperties": False,
}

RESEARCH_TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 8},
    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 8},
]


@lru_cache
def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key)


def _not_found(company: str, notes: str) -> LookupResult:
    return LookupResult(
        company=company,
        phone_number="not_found",
        source_url="n/a",
        status="not_found",
        notes=notes,
    )


async def _research(company: str) -> Tuple[str, Optional[LookupResult]]:
    """Phase 1: agentic research with web_search/web_fetch. Returns the
    research text to extract from, or an early LookupResult on a terminal
    failure (refusal / max continuations exhausted)."""
    settings = get_settings()
    client = _client()
    system_prompt = SYSTEM_PREAMBLE + get_workflow_text()
    original_message = {
        "role": "user",
        "content": f"Find and verify the primary business phone number for: {company}",
    }
    messages = [original_message]

    response = await client.messages.create(
        model=settings.model,
        max_tokens=4096,
        system=system_prompt,
        messages=messages,
        tools=RESEARCH_TOOLS,
    )

    continuations = 0
    while (
        response.stop_reason == "pause_turn"
        and continuations < settings.max_pause_turn_continuations
    ):
        messages = [original_message, {"role": "assistant", "content": response.content}]
        response = await client.messages.create(
            model=settings.model,
            max_tokens=4096,
            system=system_prompt,
            messages=messages,
            tools=RESEARCH_TOOLS,
        )
        continuations += 1

    if response.stop_reason == "refusal":
        return "", _not_found(company, "Request was declined by the model's safety classifiers.")

    if response.stop_reason == "pause_turn":
        return "", _not_found(company, "Research did not complete within the continuation limit.")

    text = "\n".join(block.text for block in response.content if block.type == "text")
    return text, None


async def _extract(company: str, research_text: str) -> LookupResult:
    """Phase 2: structured extraction. Separate call because structured
    outputs and web_search/web_fetch citations cannot be combined in one
    request (citations are mandatory on search/fetch results)."""
    settings = get_settings()
    client = _client()

    response = await client.messages.create(
        model=settings.model,
        max_tokens=1024,
        system=(
            "Extract the structured result from the research notes below. "
            "If no verified number was found, set phone_number to 'not_found' "
            "and status to 'not_found'."
        ),
        messages=[{"role": "user", "content": research_text or "No information was found."}],
        output_config={"format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
    )

    extraction_text = next(
        (block.text for block in response.content if block.type == "text"), "{}"
    )
    try:
        data = json.loads(extraction_text)
        return LookupResult(**data)
    except (json.JSONDecodeError, ValueError):
        return _not_found(company, "Failed to parse structured extraction from the model.")


async def lookup_company_phone(company: str) -> LookupResult:
    try:
        research_text, early_result = await _research(company)
        if early_result is not None:
            return early_result
        return await _extract(company, research_text)
    except anthropic.APIError as exc:
        return _not_found(company, f"Anthropic API error: {exc}")
