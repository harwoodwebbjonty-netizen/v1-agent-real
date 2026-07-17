"""Fetches a company's own website for real, current text content to feed
into sales-intelligence research — a free, deterministic alternative to
Anthropic's web_fetch tool (removed from the research pipeline after two
real-money blowups; see sales_intelligence_service.py's module comment).

Content is hard-truncated by this code, in Python, not by a remote
parameter we have to trust — so the cost/size impact of using it is fully
known ahead of time, unlike the web_fetch tool's max_content_tokens, which
did not bound real fetches the way Anthropic's docs describe."""

import html
import logging
import re

import httpx

logger = logging.getLogger("app.website_content")

CANDIDATE_PATHS = ("", "/about", "/about-us")
MAX_CHARS_PER_PAGE = 2000
MAX_TOTAL_CHARS = 3000  # ~750 tokens at Sonnet's ~4 chars/token — small, fixed, known cost

_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")


def _extract_text(raw_html: str) -> str:
    stripped = _SCRIPT_STYLE_RE.sub(" ", raw_html)
    stripped = _TAG_RE.sub(" ", stripped)
    stripped = html.unescape(stripped)
    return _WHITESPACE_RE.sub(" ", stripped).strip()


async def fetch_website_text(website: str) -> str:
    """Best-effort: returns "" on any failure (bad URL, timeout, non-200,
    etc.), never raises. Hard-capped at MAX_TOTAL_CHARS regardless of how
    large the real pages are — this is the actual cost guarantee, enforced
    by Python string slicing, not a parameter sent to a remote API."""
    website = (website or "").strip()
    if not website:
        return ""
    base = website.rstrip("/")
    if not base.startswith("http"):
        base = f"https://{base}"

    chunks: list[str] = []
    total = 0
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as client:
            for path in CANDIDATE_PATHS:
                if total >= MAX_TOTAL_CHARS:
                    break
                try:
                    r = await client.get(f"{base}{path}")
                except Exception:
                    continue
                if r.status_code != 200:
                    continue
                text = _extract_text(r.text)[:MAX_CHARS_PER_PAGE]
                if text:
                    chunks.append(text)
                    total += len(text)
    except Exception as exc:
        logger.debug("Website content fetch failed for %s: %s", website, exc)

    return "\n\n".join(chunks)[:MAX_TOTAL_CHARS]
