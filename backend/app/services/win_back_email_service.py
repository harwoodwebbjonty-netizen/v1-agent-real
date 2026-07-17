import html
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

# Hardcoded fallback CTA link baked into win_back_email_prompt.md — used only
# when the operator supplies no campaign link. Must stay in sync with that file.
FALLBACK_CALENDLY_URL = "https://calendly.com/hello-dk8/30min"


@lru_cache(maxsize=1)
def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key)


def _format_lead_sources(lead_context: dict) -> str:
    """Formats lead data as a structured brief matching the Step 1 source
    categories referenced in the Winchester CF win-back prompt."""
    lines = []
    if lead_context.get("email_instruction"):
        lines.extend([
            "Campaign email instruction:",
            lead_context["email_instruction"].strip(),
            "",
            "Apply this as an additional writing instruction. Keep every requirement in the system brief and use the lead data below as the source of truth.",
            "",
        ])
    if lead_context.get("offer_context"):
        lines.extend([
            "Current approved offers or deals:",
            lead_context["offer_context"].strip(),
            "Only mention these where relevant. Do not alter figures or add terms that are not stated here.",
            "",
        ])
    if lead_context.get("additional_context"):
        lines.extend([
            "Additional campaign context:",
            lead_context["additional_context"].strip(),
            "Use this to shape the email, but do not treat it as a reason to invent lead-specific facts.",
            "",
        ])
    if lead_context.get("campaign_links"):
        links = lead_context["campaign_links"].strip()
        link_kind = "booking" if re.search(r"calendly|calendar|cal\.com|book", links, re.IGNORECASE) else "reapplication" if re.search(r"reapply|application|apply", links, re.IGNORECASE) else "campaign"
        lines.extend([
            f"Approved {link_kind} link(s):",
            links,
            "Use the most relevant approved link as the call to action. Copy it exactly and do not invent a URL.",
            "",
        ])
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


def _strip_fallback_calendly_link(body: str) -> str:
    """Removes the win-back prompt's hardcoded Calendly fallback link (whole
    line) if the model added it despite an approved campaign link being
    supplied — the entered link must always win and the email must never
    show two CTA links."""
    lines = [line for line in body.split("\n") if FALLBACK_CALENDLY_URL not in line]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def apply_campaign_link(email: dict, campaign_links: str, link_text: str) -> dict:
    """Guarantees the operator's approved campaign link — not the prompt's
    hardcoded Calendly fallback — is the one and only CTA link in the body.
    Deterministic on purpose: the model is trusted to copy the URL exactly
    and prefer it over the fallback (per the prompt), but this does not rely
    on that compliance. If the model used the approved URL verbatim, it is
    hyperlinked in place; if the model ignored it, it is appended; either
    way any leftover fallback Calendly line is removed so there is never a
    duplicate CTA."""
    campaign_links = campaign_links.strip()
    urls = [u.rstrip(".,;)") for u in re.findall(r"https?://\S+", campaign_links)]
    if not urls:
        return email

    if FALLBACK_CALENDLY_URL not in urls:
        email["body"] = _strip_fallback_calendly_link(email["body"])

    link_text = link_text.strip()
    primary_url = urls[0]
    display = f'<a href="{primary_url}">{html.escape(link_text)}</a>' if link_text else primary_url
    if primary_url in email["body"]:
        email["body"] = email["body"].replace(primary_url, display)
    else:
        email["body"] = f"{email['body'].rstrip()}\n\n{display}"

    for url in urls[1:]:
        if url in email["body"]:
            url_display = f'<a href="{url}">{html.escape(link_text)}</a>' if link_text else url
            email["body"] = email["body"].replace(url, url_display)

    return email


def append_signature(email: dict, signature: str) -> dict:
    """Appends the operator's exact campaign signature after generation so it
    is present in every draft and cannot be omitted by the model."""
    signature = signature.strip()
    if signature:
        email["body"] = f"{email['body'].rstrip()}\n\n{signature}"
    return email


async def generate_win_back_email(lead_context: dict) -> dict:
    """Generates a win-back email using the Winchester CF prompt.
    Returns {"subject": str, "body": str}."""
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    user_message = _format_lead_sources(lead_context)
    client = _client()
    response = await client.messages.create(
        model=get_settings().extraction_model,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
        max_tokens=MAX_TOKENS,
    )
    raw = response.content[0].text.strip() if response.content else ""
    return _parse_subject_email(raw)
