import json
from functools import lru_cache

import anthropic

from app.core.config import get_settings
from app.schemas_chat import ChatTurn
from app.schemas_email_writer import EmailDraftResult, PersonalisationOption

# Deliberately isolated from every other AI service in this app — no shared
# functions or imports beyond the generic `anthropic` SDK and `get_settings()`.
# No web_search/web_fetch tools: this is pure generation from context already
# gathered elsewhere (the lead record, its intelligence, the brand voice
# profile), not research.

PRESET_GUIDANCE = {
    "Cold Outreach": "This is a first-touch cold email to someone with no prior relationship — earn attention fast, keep it short, one clear ask.",
    "Follow Up": "This follows an earlier email or call with no response yet — reference the prior touchpoint briefly, add new value, don't just repeat the same pitch.",
    "Breakup Email": "This is a final, low-pressure attempt before disengaging — acknowledge the silence, leave the door open, no hard pitch.",
    "Meeting Request": "The sole goal is booking a specific meeting/call — propose concrete next steps, make scheduling frictionless.",
    "Proposal Follow Up": "A proposal or quote was already sent — check in on it, address likely hesitations, offer to clarify or adjust.",
    "Recruitment Outreach": "Reaching out about a role or opportunity — speak to career growth and fit, not generic sales language.",
    "Partnership Outreach": "Proposing a business partnership or collaboration — frame as mutual benefit, not a vendor pitch.",
    "Re-Engagement": "Reconnecting with a lead gone quiet for a while — acknowledge the gap, lead with something new or relevant.",
    "Customer Retention": "Writing to an existing customer to retain or expand the relationship — focus on value already delivered and what's next.",
    "Custom": "Follow the user's instructions directly with no preset slant.",
}

SYSTEM_PREAMBLE = (
    "You are an expert sales email writer. Write a complete, ready-to-send email: subject line, "
    "greeting, body, call-to-action, and signature. Personalise using the lead context given. "
    "Never invent facts not present in the context provided."
)

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "body": {"type": "string"},
        "estimated_open_rate": {"type": "number", "minimum": 0, "maximum": 1},
        "estimated_reply_rate": {"type": "number", "minimum": 0, "maximum": 1},
        "estimated_readability_score": {"type": "number", "minimum": 0, "maximum": 100},
    },
    "required": ["subject", "body", "estimated_open_rate", "estimated_reply_rate", "estimated_readability_score"],
    "additionalProperties": False,
}

PERSONALISATION_SCHEMA = {
    "type": "object",
    "properties": {
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "hook": {"type": "string"},
                    "pain_point_observation": {"type": "string"},
                    "growth_observation": {"type": "string"},
                    "opportunity_statement": {"type": "string"},
                },
                "required": ["hook", "pain_point_observation", "growth_observation", "opportunity_statement"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["options"],
    "additionalProperties": False,
}

CTA_SCHEMA = {
    "type": "object",
    "properties": {"ctas": {"type": "array", "items": {"type": "string"}}},
    "required": ["ctas"],
    "additionalProperties": False,
}


@lru_cache
def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key)


def _brand_voice_block(brand_voice: dict) -> str:
    if not any(brand_voice.values()):
        return "No brand voice profile has been set — write in a generally professional, clear style."
    return (
        "Brand voice / company context to weave in naturally (don't just list these back verbatim):\n"
        f"- Company: {brand_voice.get('company_name', '')} — {brand_voice.get('company_description', '')}\n"
        f"- Industry: {brand_voice.get('industry', '')}\n"
        f"- Target audience: {brand_voice.get('target_audience', '')}\n"
        f"- Core services: {brand_voice.get('core_services', '')}\n"
        f"- Unique selling points: {brand_voice.get('unique_selling_points', '')}\n"
        f"- Preferred writing style: {brand_voice.get('preferred_writing_style', '')}\n"
        f"- Preferred CTA style: {brand_voice.get('preferred_cta_style', '')}\n"
        f"- Preferred email length: {brand_voice.get('preferred_email_length', '')}\n"
        f"- Website: {brand_voice.get('website', '')}\n"
        f"- Booking link (use only if a CTA needs it): {brand_voice.get('booking_link', '')}\n"
        f"- Signature to close with: {brand_voice.get('signature', '')}"
    )


def _parse_draft_result(text: str) -> EmailDraftResult:
    return EmailDraftResult(**json.loads(text))


async def generate_email(lead_context: dict, brand_voice: dict, instruction: str, preset: str, length: str) -> EmailDraftResult:
    client = _client()
    settings = get_settings()
    preset_note = PRESET_GUIDANCE.get(preset, PRESET_GUIDANCE["Custom"])
    user_content = (
        f"Lead context (JSON):\n{json.dumps(lead_context)}\n\n"
        f"{_brand_voice_block(brand_voice)}\n\n"
        f"Email goal/instruction: {instruction}\n"
        f"Preset: {preset} — {preset_note}\n"
        f"Desired length: {length}\n\n"
        "Also estimate (purely predictive guidance, not real tracking): estimated_open_rate (0-1), "
        "estimated_reply_rate (0-1), estimated_readability_score (0-100, higher = easier to read)."
    )
    response = await client.messages.create(
        model=settings.model,
        max_tokens=2048,
        system=SYSTEM_PREAMBLE,
        messages=[{"role": "user", "content": user_content}],
        output_config={"format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
    )
    text = next((b.text for b in response.content if b.type == "text"), "{}")
    return _parse_draft_result(text)


async def refine_email(
    lead_context: dict,
    brand_voice: dict,
    current_subject: str,
    current_body: str,
    instruction: str,
    history: list[ChatTurn],
) -> EmailDraftResult:
    client = _client()
    settings = get_settings()
    history_text = "\n".join(f"{t.role}: {t.content}" for t in history)
    user_content = (
        f"Lead context (JSON):\n{json.dumps(lead_context)}\n\n"
        f"{_brand_voice_block(brand_voice)}\n\n"
        f"Current email subject: {current_subject}\n"
        f"Current email body:\n{current_body}\n\n"
        f"Prior refinement requests in this session:\n{history_text or '(none)'}\n\n"
        f"New instruction: {instruction}\n\n"
        "Return the FULL updated email (not just the change), keeping everything that still applies. "
        "Also re-estimate estimated_open_rate, estimated_reply_rate, estimated_readability_score."
    )
    response = await client.messages.create(
        model=settings.model,
        max_tokens=2048,
        system=SYSTEM_PREAMBLE,
        messages=[{"role": "user", "content": user_content}],
        output_config={"format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
    )
    text = next((b.text for b in response.content if b.type == "text"), "{}")
    return _parse_draft_result(text)


async def generate_personalisation(lead_context: dict, count: int = 3) -> list[PersonalisationOption]:
    client = _client()
    settings = get_settings()
    user_content = (
        f"Lead context (JSON):\n{json.dumps(lead_context)}\n\n"
        f"Generate {count} distinct personalisation options for a sales email to this lead. Each option needs "
        "a hook (an opening personalisation line referencing something specific and real about this lead), a "
        "pain_point_observation, a growth_observation, and an opportunity_statement. Don't invent facts not in the context."
    )
    response = await client.messages.create(
        model=settings.model,
        max_tokens=1536,
        system="You generate sales email personalisation angles grounded only in the given lead context.",
        messages=[{"role": "user", "content": user_content}],
        output_config={"format": {"type": "json_schema", "schema": PERSONALISATION_SCHEMA}},
    )
    text = next((b.text for b in response.content if b.type == "text"), "{}")
    data = json.loads(text)
    return [PersonalisationOption(**o) for o in data.get("options", [])]


async def generate_cta_suggestions(lead_context: dict, email_goal: str) -> list[str]:
    client = _client()
    settings = get_settings()
    user_content = (
        f"Lead context (JSON):\n{json.dumps(lead_context)}\n\n"
        f"Email goal: {email_goal}\n\n"
        "Suggest 5 short, distinct calls-to-action appropriate for this goal, industry, and relationship stage."
    )
    response = await client.messages.create(
        model=settings.model,
        max_tokens=512,
        system="You generate concise sales email calls-to-action grounded only in the given context.",
        messages=[{"role": "user", "content": user_content}],
        output_config={"format": {"type": "json_schema", "schema": CTA_SCHEMA}},
    )
    text = next((b.text for b in response.content if b.type == "text"), "{}")
    data = json.loads(text)
    return data.get("ctas", [])
