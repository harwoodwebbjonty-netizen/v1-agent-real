import json

import anthropic

from app.core.config import get_settings
from app.schemas_enrichment import EnrichLeadResult

# Deliberately isolated from anthropic_service.py: no web_search/web_fetch
# tools, no shared functions. This call only reasons over text the caller
# already has (company name + existing research notes) — it never re-runs
# or touches the phone-lookup pipeline.

ENRICHMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "industry_suggestion": {"type": "string"},
        "company_summary": {"type": "string"},
        "call_prep_summary": {"type": "string"},
        "confidence_note": {"type": "string"},
    },
    "required": ["industry_suggestion", "company_summary", "call_prep_summary", "confidence_note"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = (
    "You enrich a sales lead using only the information given to you below — "
    "you have no tools and must not invent facts beyond reasonable inference "
    "from the company name and notes provided.\n\n"
    "Produce:\n"
    "- industry_suggestion: a short industry label (e.g. 'Industrial Lighting', "
    "'Brewing', 'Recruitment'). Best guess from the company name/notes; if "
    "genuinely unclear, use 'Unknown'.\n"
    "- company_summary: 1-2 sentences describing what the company likely does.\n"
    "- call_prep_summary: 2-3 short bullet-style talking points a salesperson "
    "could use to open a call with this company.\n"
    "- confidence_note: one short sentence on how confident this enrichment is, "
    "given the limited input."
)


async def enrich_lead(company: str, notes: str, industry: str) -> EnrichLeadResult:
    settings = get_settings()
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    user_content = (
        f"Company: {company}\n"
        f"Current industry tag (may be blank): {industry or '(none)'}\n"
        f"Existing research notes: {notes or '(none)'}"
    )

    response = await client.messages.create(
        model=settings.extraction_model,
        max_tokens=512,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_content}],
        output_config={"format": {"type": "json_schema", "schema": ENRICHMENT_SCHEMA}},
    )

    text = next((block.text for block in response.content if block.type == "text"), "{}")
    data = json.loads(text)
    return EnrichLeadResult(**data)
