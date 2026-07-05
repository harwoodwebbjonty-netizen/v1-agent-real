import json
import pathlib
import re
from functools import lru_cache

import anthropic

from app.core.config import get_settings

# Deliberately isolated from every other AI service — uses the Winchester CF
# win-back prompt from the workflows directory, not the generic email writer.
# The prompt embeds a 5-step decision framework; Claude runs it internally and
# returns ONLY "Subject:\n...\n\nEmail:\n..." — no scores, no reasoning.

PROMPT_PATH = pathlib.Path(__file__).resolve().parents[3] / "workflows" / "win_back_email_prompt.md"
MAX_TOKENS = 400


@lru_cache(maxsize=1)
def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key)


def _format_lead_sources(lead_context: dict) -> str:
    """Formats lead data as a structured brief matching the Step 1 source
    categories referenced in the Winchester CF win-back prompt."""
    lines = []
    if lead_context.get("company"):
        lines.append(f"Company: {lead_context['company']}")
    contact_parts = [p for p in [lead_context.get("first_name"), lead_context.get("last_name")] if p]
    contact_str = " ".join(contact_parts)
    if lead_context.get("job_title"):
        contact_str = f"{contact_str}, {lead_context['job_title']}" if contact_str else lead_context["job_title"]
    if contact_str:
        lines.append(f"Contact: {contact_str}")
    if lead_context.get("website"):
        lines.append(f"Website: {lead_context['website']}")
    if lead_context.get("linkedin"):
        lines.append(f"LinkedIn: {lead_context['linkedin']}")
    if lead_context.get("industry"):
        lines.append(f"Industry: {lead_context['industry']}")
    if lead_context.get("email"):
        lines.append(f"Email: {lead_context['email']}")
    if lead_context.get("ai_summary"):
        lines.append(f"\nAI Research Summary:\n{lead_context['ai_summary']}")
    if lead_context.get("ch_data"):
        lines.append(f"\nCompanies House Data:\n{lead_context['ch_data']}")
    if lead_context.get("lead_notes"):
        lines.append(f"\nCRM Notes: {lead_context['lead_notes']}")
    if lead_context.get("recent_activity"):
        lines.append(f"\nPrevious Contact History: {lead_context['recent_activity']}")
    return "\n".join(lines)


def _parse_subject_email(raw: str) -> dict:
    """Parses the Subject: / Email: response format."""
    subject = ""
    body = ""
    subject_match = re.search(r"Subject:\s*(.+?)(?:\n\n|\nEmail:)", raw, re.DOTALL | re.IGNORECASE)
    email_match = re.search(r"Email:\s*(.+)", raw, re.DOTALL | re.IGNORECASE)
    if subject_match:
        subject = subject_match.group(1).strip()
    if email_match:
        body = email_match.group(1).strip()
    if not subject or not body:
        lines = raw.strip().splitlines()
        for i, line in enumerate(lines):
            if line.lower().startswith("subject:"):
                subject = line[8:].strip()
            elif line.lower().startswith("email:"):
                body = "\n".join(lines[i + 1:]).strip()
                break
    return {"subject": subject or raw[:80], "body": body or raw}


async def generate_win_back_email(lead_context: dict) -> dict:
    """Generates a win-back email using the Winchester CF prompt.
    Returns {"subject": str, "body": str}."""
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    user_message = _format_lead_sources(lead_context)
    client = _client()
    response = await client.messages.create(
        model=get_settings().model,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
        max_tokens=MAX_TOKENS,
    )
    raw = response.content[0].text.strip() if response.content else ""
    return _parse_subject_email(raw)
