"""Finds a LinkedIn URL for a lead that doesn't have one on file yet, so the
Apify enrichment in linkedin_activity_service.py has something to work with.
Tries two routes in order, cheapest and most reliable first:

1. Scrape the lead's own website for a linkedin.com link (deterministic,
   free, no AI involved).
2. Companies House officers -> the named director -> a small AI web-search
   lookup for that person's personal LinkedIn profile.

Never guesses — returns None if nothing is confidently found. The caller
(linkedin_activity_service.get_or_fetch_linkedin_posts) persists whatever is
found onto the lead record so discovery only ever runs once per lead."""

import json
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Optional

import anthropic
import httpx

from app.core.config import get_settings
from app.services.companies_house_service import CHRateLimitError, get_company_officers

logger = logging.getLogger("app.linkedin_discovery")

WORKFLOW_PATH = Path(__file__).resolve().parents[3] / "workflows" / "find_person_linkedin.md"

LINKEDIN_URL_RE = re.compile(r"https?://(?:[\w-]+\.)?linkedin\.com/(?:company|in)/[\w\-%]+", re.IGNORECASE)
CANDIDATE_PATHS = ("", "/about", "/about-us", "/contact", "/contact-us")

SYSTEM_PREAMBLE = (
    "You are performing the 'Find Person's LinkedIn Profile' workflow below "
    "exactly as specified. Be conservative — a wrong match is worse than no "
    "match. At the end, state clearly: the profile URL found (or none), and "
    "a one-line confidence note.\n\n"
)

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "linkedin_url": {"type": "string"},
        "confidence_note": {"type": "string"},
    },
    "required": ["linkedin_url", "confidence_note"],
    "additionalProperties": False,
}

RESEARCH_TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 4},
    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 2},
]


@lru_cache
def _client() -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(api_key=get_settings().anthropic_api_key)


@lru_cache
def _workflow_text() -> str:
    return WORKFLOW_PATH.read_text()


def _clean_ch_officer_name(raw: str) -> str:
    """Companies House names come as "SURNAME, Firstname Middle" — flip to
    the natural order a search engine expects."""
    if "," not in raw:
        return raw.strip().title()
    surname, given = raw.split(",", 1)
    return f"{given.strip().title()} {surname.strip().title()}".strip()


async def scrape_website_for_linkedin(website: str) -> Optional[str]:
    """Fetches a handful of pages from the company's own site and looks for
    a linkedin.com link. Prefers a /company/ page over a personal /in/
    profile, since that's the more useful signal for post enrichment."""
    if not website:
        return None
    base = website.strip().rstrip("/")
    if not base:
        return None
    if not base.startswith("http"):
        base = f"https://{base}"

    company_match, person_match = None, None
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as client:
            for path in CANDIDATE_PATHS:
                try:
                    r = await client.get(f"{base}{path}")
                except Exception:
                    continue
                if r.status_code != 200:
                    continue
                for match in LINKEDIN_URL_RE.findall(r.text):
                    if "/company/" in match and not company_match:
                        company_match = match
                    elif "/in/" in match and not person_match:
                        person_match = match
                if company_match:
                    break
    except Exception as exc:
        logger.debug("LinkedIn discovery: website scrape failed for %s: %s", website, exc)

    return company_match or person_match


async def _search_person_linkedin(person_name: str, company_name: str) -> Optional[str]:
    """Small, cheap AI web-search lookup for one named person's LinkedIn
    profile — same research-then-extract shape as email_scraper_service.py,
    but a much tighter tool budget since this is a single-fact lookup, not a
    full dossier."""
    settings = get_settings()
    client = _client()
    system_prompt = SYSTEM_PREAMBLE + _workflow_text()
    original_message = {
        "role": "user",
        "content": f"Find the LinkedIn profile for: {person_name}, who works at {company_name}.",
    }
    messages = [original_message]

    try:
        response = await client.messages.create(
            model=settings.extraction_model,
            max_tokens=2048,
            system=system_prompt,
            messages=messages,
            tools=RESEARCH_TOOLS,
        )

        continuations = 0
        while response.stop_reason == "pause_turn" and continuations < 2:
            messages = [original_message, {"role": "assistant", "content": response.content}]
            response = await client.messages.create(
                model=settings.extraction_model,
                max_tokens=2048,
                system=system_prompt,
                messages=messages,
                tools=RESEARCH_TOOLS,
            )
            continuations += 1

        if response.stop_reason in ("refusal", "pause_turn"):
            return None

        research_text = "\n".join(block.text for block in response.content if block.type == "text")
        if not research_text:
            return None

        extraction = await client.messages.create(
            model=settings.extraction_model,
            max_tokens=512,
            system="Extract the structured result from the research notes below. If no confident match was found, return an empty string for linkedin_url.",
            messages=[{"role": "user", "content": research_text}],
            output_config={"format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
        )
        extraction_text = next((b.text for b in extraction.content if b.type == "text"), "{}")
        data = json.loads(extraction_text)
        url = (data.get("linkedin_url") or "").strip()
        return url if url and LINKEDIN_URL_RE.match(url) else None
    except (anthropic.APIError, json.JSONDecodeError, Exception) as exc:
        logger.debug("LinkedIn discovery: person search failed for %s at %s: %s", person_name, company_name, exc)
        return None


async def find_director_linkedin(company_number: str, company_name: str) -> Optional[str]:
    """Companies House officers -> the named director -> a small AI
    web-search lookup. This is the paid fallback step — the caller is
    expected to credit-gate it before calling (see linkedin_activity_service
    .get_or_fetch_linkedin_posts, the only caller)."""
    settings = get_settings()
    if not settings.companies_house_api_key or not company_number:
        return None
    try:
        officers = await get_company_officers(settings.companies_house_api_key, company_number)
    except CHRateLimitError:
        return None
    if not officers:
        return None
    director_name = _clean_ch_officer_name(officers[0].get("name", ""))
    if not director_name:
        return None
    return await _search_person_linkedin(director_name, company_name)
