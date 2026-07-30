import html
import json
import logging
import pathlib
import re
from functools import lru_cache
from typing import Optional

import anthropic

from app.core.config import get_settings
from app.services.companies_house_service import _SIC_DESCRIPTIONS

# Deliberately isolated from every other AI service — uses the Winchester CF
# win-back prompt from the workflows directory, not the generic email writer.
# The prompt embeds a 5-step decision framework; Claude runs it internally and
# returns ONLY "Subject:\n...\n\nEmail:\n..." — no scores, no reasoning.

logger = logging.getLogger("app.win_back_email")

PROMPT_PATH = pathlib.Path(__file__).resolve().parents[3] / "workflows" / "win_back_email_prompt.md"
MAX_TOKENS = 400

# Hardcoded fallback CTA link baked into win_back_email_prompt.md — used only
# when the operator supplies no campaign link. Must stay in sync with that file.
FALLBACK_CALENDLY_URL = "https://calendly.com/hello-dk8/30min"


@lru_cache(maxsize=1)
def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key)


# Length caps — mirror win_back_email_prompt.md's EMAIL LENGTH / SUBJECT LINE
# sections. Enforced deterministically here (the prompt states them; this is the
# guarantee), so output is always within limits regardless of model drift.
MAX_WORDS = 100
MAX_SENTENCES = 4
# Subject caps are a little wider than a bare topic line so the personalised
# "<dealmaker> from WCF — <topic>" opener fits (e.g. "Cameron from WCF, cash flow").
SUBJECT_MAX_WORDS = 7
SUBJECT_MAX_CHARS = 55

# Phrases a genuine, warm WCF finance email would essentially never contain —
# their presence means the model wrote a diagnostic / refusal / "what's missing"
# note instead of an email. Such an output is rejected and routed to a retry,
# then the deterministic fallback, so it never ships. Kept tight to avoid false
# positives on real copy.
_DIAGNOSTIC_MARKERS = (
    "no information", "insufficient information", "not enough data", "not enough information",
    "no data available", "limited data", "unable to personalise", "unable to personalize",
    "cannot personalise", "cannot personalize", "can't personalise", "can't personalize",
    "as an ai", "language model", "i don't have enough", "i do not have enough",
    "don't have enough information", "zero posts", "no linkedin", "no website", "apify",
    "scraping", "data source", "i'm sorry", "i am sorry", "what's missing", "whats missing",
    "placeholder text", "lorem ipsum", "based on general assumptions", "without more information",
    "couldn't find any", "could not find any",
)

_URL_LINE_RE = re.compile(r"^\s*https?://\S+\s*$")
_BULLET_RE = re.compile(r"^([-*•]|\d+[.)])\s")


def _count_words(text: str) -> int:
    return len(re.findall(r"\S+", text))


def _split_sentences(text: str) -> list:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]


def _split_body(body: str):
    """Separate the bare-URL booking line(s) from the prose so length trimming
    never eats the link. Runs before apply_campaign_link, so links are bare URLs."""
    prose_lines, links = [], []
    for line in body.splitlines():
        if _URL_LINE_RE.match(line):
            links.append(line.strip())
        else:
            prose_lines.append(line)
    return "\n".join(prose_lines).strip(), links


def _within_caps(email: dict) -> bool:
    prose, _ = _split_body(email["body"])
    if _count_words(prose) > MAX_WORDS or len(_split_sentences(prose)) > MAX_SENTENCES:
        return False
    subject = email["subject"].strip()
    return len(subject.split()) <= SUBJECT_MAX_WORDS and len(subject) <= SUBJECT_MAX_CHARS


def _enforce_limits(email: dict) -> dict:
    """Deterministic backstop: guarantees the caps. Subject and body are handled
    independently — an over-length subject never reflows an otherwise-fine body,
    and a compliant body keeps its original paragraph formatting."""
    subject = email["subject"].strip()
    words = subject.split()
    if len(words) > SUBJECT_MAX_WORDS:
        subject = " ".join(words[:SUBJECT_MAX_WORDS])
    if len(subject) > SUBJECT_MAX_CHARS:
        subject = subject[:SUBJECT_MAX_CHARS].rstrip(" ,;:-—–")

    prose, links = _split_body(email["body"])
    if _count_words(prose) > MAX_WORDS or len(_split_sentences(prose)) > MAX_SENTENCES:
        prose = " ".join(_split_sentences(prose)[:MAX_SENTENCES])
        if _count_words(prose) > MAX_WORDS:
            prose = " ".join(re.findall(r"\S+", prose)[:MAX_WORDS]).rstrip(",;:-—– ")
            if prose and prose[-1] not in ".!?":
                prose += "."
        body = f"{prose}\n\n{links[0]}" if links else prose
    else:
        body = email["body"].rstrip()  # already within caps — keep formatting

    return {"subject": subject.strip(), "body": body.strip()}


def _is_real_email(subject: str, body: str) -> bool:
    """True only if this looks like an actual email, not a diagnostic / refusal /
    'what's missing' list that happens to sit behind Subject:/Email: markers."""
    text = f"{subject}\n{body}".lower()
    if any(marker in text for marker in _DIAGNOSTIC_MARKERS):
        return False
    prose, links = _split_body(body)
    if _count_words(prose) < 20:
        return False
    if not links and "call" not in prose.lower():  # must have a CTA (link or "call")
        return False
    lines = [l.strip() for l in body.splitlines() if l.strip()]
    if lines:
        bullets = sum(1 for l in lines if _BULLET_RE.match(l))
        if bullets / len(lines) > 0.4:  # mostly a list, not prose
            return False
    return True


def _relationship_note(stage: Optional[str]) -> str:
    """Tells the model whether a real funding relationship exists, based on the
    CRM deal stage. Only a genuinely won deal licenses 'we funded you' language;
    a lost or still-open deal means they only ever enquired, so the email must
    never imply WCF has funded them. A blank/unknown stage stays on the safe
    side — don't assert any past deal at all."""
    s = (stage or "").strip().lower()
    if not s:
        return ("RELATIONSHIP: Do not claim or imply WCF has funded, financed, or arranged a facility "
                "for this company unless their data clearly shows it. If unsure, write a warm re-approach "
                "about their funding needs without asserting any past deal.")
    if "won" in s:
        return ("RELATIONSHIP: This is a past client — WCF previously arranged funding for them. You may "
                "naturally acknowledge that existing funding relationship.")
    return ("RELATIONSHIP: WCF has NOT funded this company — they previously enquired about funding but no "
            "deal completed. Never say or imply we funded them, arranged their facility, or that they are an "
            "existing funding customer. Write as a broker picking that earlier funding conversation back up, "
            "not continuing a funding relationship.")


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
            "Only mention these where relevant. Do not alter figures or add terms that are not stated here. "
            "When you include an approved offer or deal in the email, wrap that exact detail in double "
            "asterisks so it renders in bold — e.g. **£250,000 pre-approved at 6.9%**. Bold ONLY the offer "
            "or deal itself (the figures/terms), never a whole sentence and never anything else.",
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
    if lead_context.get("sender_name"):
        lines.append(
            f"Sender (YOU — the Winchester Corporate Finance broker sending this, who dealt with "
            f"this company originally): {lead_context['sender_name']}. Refer to Winchester "
            f"Corporate Finance as 'WCF' in the subject line."
        )
    lines.append(_relationship_note(lead_context.get("deal_stage")))
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
    if lead_context.get("prior_emails"):
        lines.extend([
            "",
            "EMAILS ALREADY SENT TO THIS CONTACT IN EARLIER CAMPAIGNS (most recent first):",
            lead_context["prior_emails"].strip(),
            "",
            "Use these earlier emails as a springboard: don't open the same way or repeat "
            "their wording, and don't just restate them. BUT personalisation comes first — "
            "this email must still hang on a specific, genuine reason to contact THIS "
            "company, drawn from its own data, exactly as it would with no earlier emails. "
            "Avoiding overlap must NEVER make the email generic. If the strongest angle is "
            "one an earlier email already touched, come back to it from a fresh angle (a new "
            "detail, a new development, a different product fit) rather than going vague. Do "
            "NOT write a wind-down or breakup note ('don't want to clutter your inbox', "
            "'before I leave it', 'one last note') and do NOT fall back on a generic 'rates "
            "have shifted, worth another look' message with no specific hook — an email that "
            "is only about having been in touch before is a failure. You may briefly nod to "
            "the earlier contact as a bridge ('following up on my last note about...'), but "
            "the substance must be specific to their business. Don't assume they replied.",
        ])
    return "\n".join(lines)


def _parse_subject_email(raw: str) -> Optional[dict]:
    """Parses the Subject: / Email: response format. Returns None if either
    marker is missing after all parsing attempts — a strong signal the model
    didn't produce an email at all (e.g. it declined, citing insufficient
    research signal to justify a specific business case), rather than a
    minor formatting slip worth guessing at with a truncated raw-text
    fallback. The caller substitutes a safe generic email in that case."""
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
    if not subject or not body:
        return None
    return {"subject": subject, "body": body}


def _fallback_email(lead_context: dict) -> dict:
    """Last-resort deterministic email, used only if the model fails to produce a
    real Subject:/Email: across BOTH attempts (should be effectively never now the
    prompt is instructed to always write). It is NOT the old stiff 'just checking
    in' template — it blends the sector-anchored copy with any real data the lead
    has: the contact first name, the sector (from `industry` or the Companies
    House SIC code), an 'established since <year>' line if CH gives an
    incorporation date, and a light refinance nudge if CH shows a registered
    charge. Warm register to match the model path; no invented company specifics
    (sector-level only). Ends with the bare-URL CTA so apply_campaign_link's
    find-and-replace works exactly as on a model-written email."""
    company = (lead_context.get("company") or "").strip()
    first_name = (lead_context.get("first_name") or "").strip()
    industry = (lead_context.get("industry") or "").strip()
    ch = lead_context.get("ch_data") or ""

    sector = industry
    if not sector:
        sic = re.search(r"SIC codes?:\s*([0-9]{2,5})", ch)
        if sic:
            sector = _SIC_DESCRIPTIONS.get(sic.group(1)[:2], "")
    inc = re.search(r"Incorporated:\s*(\d{4})", ch)
    charges = re.search(r"Charges registered:\s*([1-9]\d*)", ch)

    greeting = f"Hi {first_name}," if first_name else "Hi,"
    # Always address the reader directly — never stamp the company's registered
    # name into the body (reads as automated mail-merge). Company still allowed
    # in the subject line, which is composed separately below.
    target = "your business"
    sector_clause = f" that work in {sector.lower()}" if sector else " like yours"
    if charges:
        middle = ("Since you've already got funding in place, it's worth a quick look at whether "
                  "the terms still stack up or could be freed up.")
    elif inc:
        middle = (f"You've been going since {inc.group(1)}, so you'll know how much timing matters "
                  "when cash flow gets tight.")
    else:
        middle = ("Whether it's working capital, asset finance or bridging, the right facility in "
                  "place makes the timing a lot easier.")

    sender_first = (lead_context.get("sender_name") or "").strip().split()[0] if lead_context.get("sender_name") else ""
    if sender_first and company:
        subject = f"{sender_first} from WCF, {company}"
    elif sender_first:
        subject = f"{sender_first} from WCF"
    elif company:
        subject = f"Funding options for {company}"
    else:
        subject = "Funding options"
    body = (
        f"{greeting}\n\n"
        f"I help businesses{sector_clause} get the right funding sorted through a panel of over "
        f"250 lenders. {middle}\n\n"
        f"If you can spare ten minutes this week, I'd be happy to run through what might fit "
        f"{target} on a quick call.\n\n"
        f"{FALLBACK_CALENDLY_URL}"
    )
    return _enforce_limits({"subject": subject, "body": body})


def _strip_fallback_calendly_link(body: str) -> str:
    """Removes the win-back prompt's hardcoded Calendly fallback link (whole
    line) if the model added it despite an approved campaign link being
    supplied — the entered link must always win and the email must never
    show two CTA links."""
    lines = [line for line in body.split("\n") if FALLBACK_CALENDLY_URL not in line]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _clean_link_text(text: str) -> str:
    """Normalises operator-supplied link display text before it becomes a live
    link label. Text wrapped in square brackets (e.g. '[ pick a time here ]')
    reads as an unfilled placeholder and must never ship as a real CTA label,
    so strip matched surrounding brackets and any edge whitespace."""
    text = (text or "").strip()
    while len(text) >= 2 and text.startswith("[") and text.endswith("]"):
        text = text[1:-1].strip()
    return text


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

    link_text = _clean_link_text(link_text)
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
    """Appends the supplied signature after generation."""
    signature = signature.strip()
    if signature:
        email["body"] = f"{email['body'].rstrip()}\n\n{signature}"
    return email


def build_signature(sender_name: str) -> str:
    """Compose the Win-back sign-off from the original deal broker's name."""
    sender_name = (sender_name or "").strip()
    if not sender_name:
        return ""
    return f"Best regards,\n{sender_name}\nWinchester Corporate Finance"


def ensure_sender_subject(email: dict, sender_name: str) -> dict:
    """Make the original broker visibly own every Win-back email subject.

    The existing prompt already asks for this. This only provides a
    deterministic backstop if a model response omits the named broker.
    """
    sender_first = (sender_name or "").strip().split()[0] if sender_name else ""
    if not sender_first:
        return email

    prefix = f"{sender_first} from WCF"
    subject = (email.get("subject") or "").strip()
    if re.match(rf"^{re.escape(sender_first)}\s+from\s+WCF\b", subject, re.IGNORECASE):
        return email

    available_chars = SUBJECT_MAX_CHARS - len(prefix) - 3
    available_words = SUBJECT_MAX_WORDS - len(prefix.split())
    topic = " ".join(subject.split()[:available_words])[:available_chars].rstrip(" ,;:-—–")
    email["subject"] = f"{prefix} — {topic}" if topic else prefix
    return email


# Firmer instruction appended on the second attempt if the first didn't parse
# into a real Subject:/Email: or overran the length caps. The prompt already
# forbids declining and overrunning, so this is belt-and-braces to hold the
# "always a real, in-caps email, never a diagnostic" guarantee.
_RETRY_REMINDER = (
    "\n\nReturn the email now, in exactly this format and nothing else:\n"
    "Subject: <max 5 words, under 40 characters>\n\n"
    "Email: <60-90 word personalised email, 4 sentences or fewer, ending with the link on its own line>\n\n"
    "Write a warm, confident, human email using this company's specifics if present, otherwise its "
    "Companies House filing data, otherwise its industry/sector. There is always enough to write a "
    "genuine email. Do NOT explain, apologise, hedge, refuse, mention missing data or tools, or list "
    "what you don't know — just write the email."
)


async def generate_win_back_email(lead_context: dict) -> dict:
    """Generates a personalised win-back email using the Winchester CF prompt.
    Returns {"subject": str, "body": str} and NEVER raises — every path yields a
    real, in-caps email. A model reply is accepted only if it parses AND looks
    like a genuine email (`_is_real_email`); a real-but-overlong reply triggers
    one firmer retry and is then deterministically trimmed (`_enforce_limits`); a
    diagnostic/refusal reply, two failures, or an API error route to the
    sector-anchored `_fallback_email`. So it can never emit an explanation,
    apology, or "what's missing" list."""
    system_prompt = PROMPT_PATH.read_text(encoding="utf-8")
    base_message = _format_lead_sources(lead_context)
    client = _client()
    candidate: Optional[dict] = None
    for attempt in range(2):
        user_message = base_message if attempt == 0 else base_message + _RETRY_REMINDER
        try:
            response = await client.messages.create(
                model=get_settings().win_back_writer_model,
                system=system_prompt,
                messages=[{"role": "user", "content": user_message}],
                max_tokens=MAX_TOKENS,
            )
        except Exception:
            logger.exception("Win-back email: model call failed — using deterministic fallback")
            break
        raw = response.content[0].text.strip() if response.content else ""
        parsed = _parse_subject_email(raw)
        if parsed and _is_real_email(parsed["subject"], parsed["body"]):
            candidate = parsed
            if _within_caps(parsed):
                return _enforce_limits(parsed)
            # real email but over the caps — retry once for a naturally shorter one
    if candidate:
        return _enforce_limits(candidate)
    return _fallback_email(lead_context)
