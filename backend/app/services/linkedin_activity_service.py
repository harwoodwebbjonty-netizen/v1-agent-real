"""Orchestrates LinkedIn post enrichment: caching, credit-limit checks, and
formatting for the sales-intelligence prompt. The only place in the app that
knows about both leads/credit-tracking AND the Apify transport layer —
apify_service.py stays a pure "call Apify" client, and
sales_intelligence_service.py stays DB-free (it just receives a plain
formatted string, the same shape as its existing `website` param)."""

import json
import logging
import sqlite3

from app import db
from app.core.config import get_settings
from app.services.apify_service import ApifyRateLimitError, run_linkedin_post_scrape
from app.services.auth_service import days_since, new_id, now_iso

logger = logging.getLogger("app.linkedin_activity")

CACHE_DAYS = 30
DEFAULT_MAX_POSTS = 10
# Apify bills ~$2 per 1,000 posts, not a flat per-call fee — this is an
# approximate USD->GBP conversion for credit-usage bookkeeping. Adjust
# against your actual Apify invoice if it drifts.
APIFY_COST_PER_1K_POSTS_GBP = 1.60


async def _fetch_and_charge(linkedin_url: str, user_id: str) -> list[dict]:
    """Credit-checked Apify fetch, no DB read/write — shared by the cached
    per-lead path and the no-cache preview path below."""
    settings = get_settings()
    if not settings.apify_api_token or not settings.apify_linkedin_actor_id:
        return []

    allowed, spent, limit = db.check_credit_limit(user_id, "linkedin_scrape")
    if not allowed:
        logger.warning(
            "LinkedIn scrape: credit limit £%.2f reached (spent £%.2f) — skipping %s",
            limit, spent, linkedin_url,
        )
        return []

    try:
        posts = await run_linkedin_post_scrape(
            settings.apify_api_token, settings.apify_linkedin_actor_id,
            [linkedin_url], max_posts=DEFAULT_MAX_POSTS,
        )
    except ApifyRateLimitError:
        logger.warning("LinkedIn scrape: rate limited for %s", linkedin_url)
        return []

    if posts:
        cost = (len(posts) / 1000) * APIFY_COST_PER_1K_POSTS_GBP
        db.record_credit_spend(new_id(), user_id, "linkedin_scrape", cost, now_iso())
    return posts


async def get_or_fetch_linkedin_posts(lead: sqlite3.Row, user_id: str) -> list[dict]:
    """Returns cached LinkedIn posts for a lead, fetching fresh via Apify only
    if the cache is missing/stale and the lead has a LinkedIn URL set. Most
    freshly-discovered AI Prospecting leads have no LinkedIn URL yet, so this
    silently no-ops for them — that's expected, not a bug."""
    linkedin_url = (lead["linkedin"] or "").strip() if "linkedin" in lead.keys() else ""
    if not linkedin_url:
        return []

    cached = db.get_latest_lead_linkedin_posts(lead["id"])
    if cached and days_since(cached["created_at"]) <= CACHE_DAYS:
        try:
            return json.loads(cached["posts_json"])
        except (TypeError, ValueError):
            pass  # corrupt cache row — fall through and refetch

    posts = await _fetch_and_charge(linkedin_url, user_id)
    db.add_lead_linkedin_posts(new_id(), lead["id"], linkedin_url, json.dumps(posts), now_iso())
    return posts


async def fetch_linkedin_posts_preview(linkedin_url: str, user_id: str) -> list[dict]:
    """For one-off previews with no persisted lead (e.g. the win-back
    "Preview one email" flow) — same credit-tracked fetch, but never reads
    or writes the per-lead cache table, so it can never affect what a real
    campaign generation later sees for that lead."""
    linkedin_url = linkedin_url.strip()
    if not linkedin_url:
        return []
    return await _fetch_and_charge(linkedin_url, user_id)


def format_posts_for_prompt(posts: list[dict]) -> str:
    """Short bullet lines for the sales-intelligence prompt. Empty string for
    no posts — generate_sales_intelligence() treats a blank linkedin_context
    as "nothing extra to add" and researches exactly as it does today."""
    if not posts:
        return ""
    lines = []
    for post in posts[:DEFAULT_MAX_POSTS]:
        posted_at = post.get("postedAt") or {}
        posted_ago = posted_at.get("postedAgoText") or posted_at.get("postedAgoShort") or ""
        content = (post.get("content") or "").strip().replace("\n", " ")
        if not content:
            continue
        if len(content) > 400:
            content = content[:400].rstrip() + "..."
        engagement = post.get("engagement") or {}
        likes, comments = engagement.get("likes"), engagement.get("comments")
        engagement_note = f" [{likes or 0} likes, {comments or 0} comments]" if likes is not None or comments is not None else ""
        prefix = f"({posted_ago}) " if posted_ago else ""
        lines.append(f"- {prefix}{content}{engagement_note}")
    return "\n".join(lines)
