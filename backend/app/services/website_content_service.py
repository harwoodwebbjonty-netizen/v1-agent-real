"""Fetches a company's own website for real, current text content to feed
into sales-intelligence research — a free, deterministic alternative to
Anthropic's web_fetch tool (removed from the research pipeline after two
real-money blowups; see sales_intelligence_service.py's module comment).

Everything here is plain HTTP + local parsing: no scraping/render API, no
headless browser, no per-page charge. Signal density is raised for free by
(1) pulling dense structured meta first (title / meta description /
og:description / JSON-LD Organization), (2) extracting the <main>/<article>
body instead of nav/footer/cookie chrome, and (3) discovering high-signal
subpages (about / services / news) from the homepage's own links rather than
guessing fixed paths. JS-only or dead sites that return an empty shell are
skipped (returns "") so nothing but real content reaches the model.

Content is hard-truncated by THIS code, in Python — not by a remote
parameter we have to trust — so the cost/size impact is fully known ahead of
time, unlike the web_fetch tool's max_content_tokens which did not bound real
fetches the way Anthropic's docs describe."""

import html
import json
import logging
import re
from urllib.parse import urljoin, urlparse

import httpx

logger = logging.getLogger("app.website_content")

# Fixed subpaths tried only if homepage-link discovery finds nothing.
FALLBACK_PATHS = ("/about", "/about-us", "/services")
MAX_CHARS_PER_PAGE = 900
MAX_TOTAL_CHARS = 1800   # ~450 tokens at ~4 chars/token. Fits the meta block +
                         # homepage + up to MAX_SUBPAGES discovered pages.
MAX_META_CHARS = 350
MIN_CONTENT_CHARS = 120  # below this (real body text) the page is treated as a
                         # JS-only/dead/blocked shell and skipped — unless the
                         # meta block alone carries substantive signal.
MIN_META_KEEP = 80
MAX_SUBPAGES = 2
MAX_HTML_CHARS = 400_000  # cap raw HTML we regex over, for safety on huge pages

_BLOCK_CHROME_RE = re.compile(
    r"<(script|style|nav|header|footer|form|aside|noscript|svg)\b[^>]*>.*?</\1>",
    re.DOTALL | re.IGNORECASE,
)
_MAIN_RE = re.compile(r"<(main|article)\b[^>]*>(.*?)</\1>", re.DOTALL | re.IGNORECASE)
_BODY_RE = re.compile(r"<body\b[^>]*>(.*?)</body>", re.DOTALL | re.IGNORECASE)
_BLOCK_BOUNDARY_RE = re.compile(
    r"(?i)</?(p|div|li|h[1-6]|section|tr|br|ul|ol|table)\s*/?>"
)
_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.DOTALL | re.IGNORECASE)
_META_TAG_RE = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
_META_KEY_RE = re.compile(r'(?:name|property)\s*=\s*["\']([^"\']+)["\']', re.IGNORECASE)
_META_CONTENT_RE = re.compile(r'content\s*=\s*["\']([^"\']*)["\']', re.IGNORECASE)
_LD_RE = re.compile(
    r'<script[^>]+type\s*=\s*["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.DOTALL | re.IGNORECASE,
)
_ANCHOR_RE = re.compile(r'<a\b[^>]*href\s*=\s*["\']([^"\']+)["\'][^>]*>(.*?)</a>',
                        re.DOTALL | re.IGNORECASE)

# Subpage scoring: recency pages beat about/services because "recent activity"
# is the strongest personalisation opener for a finance broker.
_PAGE_KEYWORDS = (
    (3, ("news", "blog", "case-stud", "casestud", "project", "our-work",
         "portfolio", "press", "updates")),
    (2, ("service", "what-we-do", "whatwedo", "product", "solution", "sector",
         "industr")),
    (2, ("about", "our-story", "ourstory", "who-we-are", "whoweare", "company",
         "/team")),
)
_SKIP_LINK_HINT = ("mailto:", "tel:", "javascript:", "#")
_SKIP_LINK_EXT = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".zip", ".doc",
                  ".docx", ".xls", ".xlsx", ".mp4", ".svg", ".webp")


def _clean(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", html.unescape(text)).strip()


def _extract_meta(raw_html: str) -> str:
    """Dense, tiny, high-signal: title + meta/og description + JSON-LD
    Organization fields. Returns a single short line, capped."""
    parts: list[str] = []
    seen: set[str] = set()

    def add(val: str) -> None:
        val = _clean(val)
        low = val.lower()
        if val and low not in seen and len(val) > 2:
            seen.add(low)
            parts.append(val)

    m = _TITLE_RE.search(raw_html)
    if m:
        add(m.group(1))

    for tag in _META_TAG_RE.findall(raw_html):
        key = _META_KEY_RE.search(tag)
        if not key or key.group(1).lower() not in ("description", "og:description"):
            continue
        content = _META_CONTENT_RE.search(tag)
        if content:
            add(content.group(1))

    for block in _LD_RE.findall(raw_html):
        try:
            data = json.loads(block.strip())
        except (json.JSONDecodeError, ValueError):
            continue
        for node in _iter_ld_nodes(data):
            if not isinstance(node, dict):
                continue
            for field in ("description", "slogan", "foundingDate", "areaServed"):
                val = node.get(field)
                if isinstance(val, str):
                    add(f"{field}: {val}" if field in ("foundingDate", "areaServed") else val)

    return " — ".join(parts)[:MAX_META_CHARS]


def _iter_ld_nodes(data):
    if isinstance(data, list):
        for item in data:
            yield from _iter_ld_nodes(item)
    elif isinstance(data, dict):
        if "@graph" in data and isinstance(data["@graph"], list):
            for item in data["@graph"]:
                yield from _iter_ld_nodes(item)
        else:
            yield data


def _extract_main_text(raw_html: str) -> str:
    """Isolate the main content region, drop chrome, return plain text."""
    # Prefer the largest <main>/<article>; else <body>; else whole document.
    regions = [g[1] for g in _MAIN_RE.findall(raw_html)]
    if regions:
        region = max(regions, key=len)
    else:
        body = _BODY_RE.search(raw_html)
        region = body.group(1) if body else raw_html

    region = _BLOCK_CHROME_RE.sub(" ", region)
    region = _BLOCK_BOUNDARY_RE.sub(" ", region)   # keep word boundaries
    region = _TAG_RE.sub(" ", region)
    return _clean(region)


def _discover_pages(home_html: str, base: str) -> list[str]:
    """Score homepage links and return up to MAX_SUBPAGES same-site URLs."""
    base_host = urlparse(base).netloc.lower().lstrip("www.")
    best: dict[str, int] = {}
    for href, text in _ANCHOR_RE.findall(home_html):
        href = href.strip()
        low = href.lower()
        if not href or low.startswith(_SKIP_LINK_HINT) or low.endswith(_SKIP_LINK_EXT):
            continue
        absolute = urljoin(base + "/", href)
        parsed = urlparse(absolute)
        if parsed.scheme not in ("http", "https"):
            continue
        if parsed.netloc.lower().lstrip("www.") != base_host:
            continue
        path = parsed.path.rstrip("/").lower()
        if not path or path == urlparse(base).path.rstrip("/").lower():
            continue  # skip the homepage itself
        hay = f"{path} {_clean(text).lower()}"
        score = 0
        for weight, words in _PAGE_KEYWORDS:
            if any(w in hay for w in words):
                score = max(score, weight)
        if score == 0:
            continue
        clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"
        best[clean_url] = max(best.get(clean_url, 0), score)

    return [u for u, _ in sorted(best.items(), key=lambda kv: kv[1], reverse=True)][:MAX_SUBPAGES]


async def fetch_website_text(website: str) -> str:
    """Best-effort: returns "" on any failure or on a thin/JS-only/dead site,
    never raises. Output is hard-capped at MAX_TOTAL_CHARS by Python string
    slicing — the actual cost guarantee — regardless of real page size."""
    website = (website or "").strip()
    if not website:
        return ""
    base = website.rstrip("/")
    if not base.startswith("http"):
        base = f"https://{base}"

    meta = ""
    body_chunks: list[str] = []
    body_total = 0
    try:
        async with httpx.AsyncClient(
            timeout=10.0, follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (compatible; WCFResearchBot/1.0)"},
        ) as client:
            try:
                home = await client.get(base)
            except Exception:
                return ""
            if home.status_code != 200:
                return ""
            home_html = home.text[:MAX_HTML_CHARS]

            meta = _extract_meta(home_html)
            home_text = _extract_main_text(home_html)[:MAX_CHARS_PER_PAGE]
            if home_text:
                body_chunks.append(home_text)
                body_total += len(home_text)

            pages = _discover_pages(home_html, base) or [base + p for p in FALLBACK_PATHS]
            for url in pages[:MAX_SUBPAGES]:
                if body_total >= MAX_TOTAL_CHARS:
                    break
                try:
                    r = await client.get(url)
                except Exception:
                    continue
                if r.status_code != 200:
                    continue
                text = _extract_main_text(r.text[:MAX_HTML_CHARS])[:MAX_CHARS_PER_PAGE]
                if text:
                    body_chunks.append(text)
                    body_total += len(text)
    except Exception as exc:
        logger.debug("Website content fetch failed for %s: %s", website, exc)
        return ""

    body = "\n\n".join(body_chunks)
    # Skip JS-only/dead/blocked shells: keep only when real body content clears
    # the floor, or the meta block alone is substantive.
    if body_total < MIN_CONTENT_CHARS and len(meta) < MIN_META_KEEP:
        return ""

    assembled = f"Website summary: {meta}\n\n{body}" if meta else body
    return assembled.strip()[:MAX_TOTAL_CHARS]
