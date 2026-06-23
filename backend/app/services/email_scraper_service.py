import json
from functools import lru_cache
from pathlib import Path
from typing import Optional, Tuple

import anthropic

from app.core.config import get_settings
from app.schemas_email import EmailScrapeResult

# Deliberately isolated from anthropic_service.py: separate workflow file,
# separate client cache, separate schema, no shared functions or imports
# between the two beyond the generic `anthropic` SDK and `get_settings()`
# (app-wide config, not phone-specific). This service must be runnable and
# fully functional even if anthropic_service.py didn't exist.

WORKFLOW_PATH = Path(__file__).resolve().parents[3] / "workflows" / "find_company_email.md"

SYSTEM_PREAMBLE = (
    "You are performing the 'Find Company Email Address' workflow below "
    "exactly as specified. Work through the steps in order; don't stop at "
    "the first dead end. At the end, state clearly: the email address(es) "
    "found (or none), and a one-line confidence note.\n\n"
)

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "emails": {"type": "array", "items": {"type": "string"}},
        "confidence_note": {"type": "string"},
    },
    "required": ["emails", "confidence_note"],
    "additionalProperties": False,
}

RESEARCH_TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 5},
    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 5},
]


@lru_cache
def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key)


@lru_cache
def _workflow_text() -> str:
    return WORKFLOW_PATH.read_text()


def _not_found(notes: str) -> EmailScrapeResult:
    return EmailScrapeResult(emails=[], confidence_note=notes)


async def _research(company: str) -> Tuple[str, Optional[EmailScrapeResult]]:
    """Phase 1: agentic research with web_search/web_fetch. Returns the
    research text to extract from, or an early result on a terminal failure
    (refusal / max continuations exhausted)."""
    settings = get_settings()
    client = _client()
    system_prompt = SYSTEM_PREAMBLE + _workflow_text()
    original_message = {
        "role": "user",
        "content": f"Find and verify email address(es) for: {company}",
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
        return "", _not_found("Request was declined by the model's safety classifiers.")

    if response.stop_reason == "pause_turn":
        return "", _not_found("Research did not complete within the continuation limit.")

    text = "\n".join(block.text for block in response.content if block.type == "text")
    return text, None


async def _extract(research_text: str) -> EmailScrapeResult:
    """Phase 2: structured extraction. Separate call because structured
    outputs and web_search/web_fetch citations cannot be combined in one
    request (citations are mandatory on search/fetch results)."""
    settings = get_settings()
    client = _client()

    response = await client.messages.create(
        model=settings.extraction_model,
        max_tokens=1024,
        system=(
            "Extract the structured result from the research notes below. "
            "If no verified email address was found, return an empty list."
        ),
        messages=[{"role": "user", "content": research_text or "No information was found."}],
        output_config={"format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
    )

    extraction_text = next(
        (block.text for block in response.content if block.type == "text"), "{}"
    )
    try:
        data = json.loads(extraction_text)
        return EmailScrapeResult(**data)
    except (json.JSONDecodeError, ValueError):
        return _not_found("Failed to parse structured extraction from the model.")


async def scrape_emails(company: str) -> EmailScrapeResult:
    try:
        research_text, early_result = await _research(company)
        if early_result is not None:
            return early_result
        return await _extract(research_text)
    except anthropic.APIError as exc:
        return _not_found(f"Anthropic API error: {exc}")
