"""Orchestrates LinkedIn post enrichment: caching, credit-limit checks, and
formatting for the sales-intelligence prompt. The only place in the app that
knows about both leads/credit-tracking AND the Apify transport layer —
apify_service.py stays a pure "call Apify" client, and
sales_intelligence_service.py stays DB-free (it just receives a plain
formatted string, the same shape as its existing `website` param)."""

import json
import logging
import sqlite3
from typing import Optional

from app import db
from app.core.config import get_settings
from app.services.apify_service import ApifyRateLimitError, run_linkedin_post_scrape
from app.services.auth_service import days_since, new_id, now_iso
from app.services.linkedin_discovery_service import find_director_linkedin, scrape_website_for_linkedin

logger = logging.getLogger("app.linkedin_activity")

CACHE_DAYS = 30
DEFAULT_MAX_POSTS = 10
# Apify bills ~$2 per 1,000 posts, not a flat per-call fee — this is an
# approximate USD->GBP conversion for credit-usage bookkeeping. Adjust
# against your actual Apify invoice if it drifts.
APIFY_COST_PER_1K_POSTS_GBP = 1.60


async def _fetch_and_charge(linkedin_url: str, user_id: str, max_posts: int = DEFAULT_MAX_POSTS, charge: bool = True) -> Optional[list[dict]]:
    """Credit-checked Apify fetch, no DB read/write — shared by the cached
    per-lead path and the no-cache preview path below. Returns None whenever
    no real attempt completed (missing config, credit limit reached, rate
    limited, or the Apify call itself failed — e.g. balance exhausted) so
    the caller never confuses "didn't fetch" with a genuine "fetched, found
    zero posts" result. `max_posts` is billed per post by Apify, so a smaller
    cap is a real cost saving — win-back passes a tighter value than the
    calling tools' default.

    `charge=False` skips both the linkedin_scrape credit check and its spend
    record: win-back folds this cost into its own flat per-email charge and
    gates the whole pipeline on the win_back limit instead, so double-counting
    it here would break its exact 20c-per-email figure."""
    settings = get_settings()
    if not settings.apify_api_token or not settings.apify_linkedin_actor_id:
        return None

    if charge:
        allowed, spent, limit = db.check_credit_limit(user_id, "linkedin_scrape")
        if not allowed:
            logger.warning(
                "LinkedIn scrape: credit limit £%.2f reached (spent £%.2f) — skipping %s",
                limit, spent, linkedin_url,
            )
            return None

    try:
        posts = await run_linkedin_post_scrape(
            settings.apify_api_token, settings.apify_linkedin_actor_id,
            [linkedin_url], max_posts=max_posts,
        )
    except ApifyRateLimitError:
        logger.warning("LinkedIn scrape: rate limited for %s", linkedin_url)
        return None

    if posts is None:
        return None

    if posts and charge:
        cost = (len(posts) / 1000) * APIFY_COST_PER_1K_POSTS_GBP
        db.record_credit_spend(new_id(), user_id, "linkedin_scrape", cost, now_iso())
    return posts


async def _discover_and_save_linkedin_url(lead: sqlite3.Row, user_id: str) -> str:
    """Website scrape first (free), then Companies House director + AI
    search (credit-gated) as a fallback. Persists a find onto the lead
    record so this never re-runs for the same lead."""
    website = (lead["website"] or "").strip() if "website" in lead.keys() else ""
    found = await scrape_website_for_linkedin(website)

    if not found:
        company_number = (lead["company_number"] or "").strip() if "company_number" in lead.keys() else ""
        company_name = lead["company"] if "company" in lead.keys() else ""
        if company_number:
            allowed, spent, limit = db.check_credit_limit(user_id, "linkedin_discovery")
            if not allowed:
                logger.warning(
                    "LinkedIn discovery: credit limit £%.2f reached (spent £%.2f) — skipping director search for %s",
                    limit, spent, company_name,
                )
            else:
                found = await find_director_linkedin(company_number, company_name)
                db.record_credit_spend(new_id(), user_id, "linkedin_discovery", db.CREDIT_COST["linkedin_discovery"], now_iso())

    if found:
        db.update_lead_fields(lead["id"], {"linkedin": found}, now_iso())
        logger.info("LinkedIn discovery: found %s for lead %s", found, lead["id"])
    return found or ""


async def get_or_fetch_linkedin_posts(lead: sqlite3.Row, user_id: str, max_posts: int = DEFAULT_MAX_POSTS, charge: bool = True) -> list[dict]:
    """Returns cached LinkedIn posts for a lead, fetching fresh via Apify only
    if the cache is missing/stale. If the lead has no LinkedIn URL on file,
    tries to discover one first — a free website scrape, then (credit-gated)
    a Companies House director + AI search fallback — and persists whatever
    is found onto the lead record so discovery only ever runs once.

    `max_posts` only bounds a *fresh* fetch; a warm cache is returned as-is
    regardless of the cap. The cache is shared with the calling tools, so a
    win-back-tightened fetch on a brand-new CSV lead caches fewer posts for
    that lead — acceptable because win-back leads are fresh imports that are
    rarely opened by the calling team, and 5 recent posts is ample signal."""
    linkedin_url = (lead["linkedin"] or "").strip() if "linkedin" in lead.keys() else ""
    if not linkedin_url:
        linkedin_url = await _discover_and_save_linkedin_url(lead, user_id)
    if not linkedin_url:
        return []

    cached = db.get_latest_lead_linkedin_posts(lead["id"])
    if cached and days_since(cached["created_at"]) <= CACHE_DAYS:
        try:
            return json.loads(cached["posts_json"])
        except (TypeError, ValueError):
            pass  # corrupt cache row — fall through and refetch

    posts = await _fetch_and_charge(linkedin_url, user_id, max_posts=max_posts, charge=charge)
    if posts is None:
        # No real attempt completed (balance exhausted, rate limited, credit
        # limit reached, etc.) — do NOT cache, so this lead is retried next
        # time instead of being locked out as "no posts" for CACHE_DAYS.
        return []
    db.add_lead_linkedin_posts(new_id(), lead["id"], linkedin_url, json.dumps(posts), now_iso())
    return posts


async def fetch_linkedin_posts_preview(linkedin_url: str, user_id: str, website: str = "", max_posts: int = DEFAULT_MAX_POSTS, charge: bool = True) -> Optional[list[dict]]:
    """For one-off previews with no persisted lead (e.g. the win-back
    "Preview one email" flow) — same credit-tracked fetch, but never reads
    or writes the per-lead cache table, so it can never affect what a real
    campaign generation later sees for that lead.

    Falls back to the free website-scrape discovery method when no LinkedIn
    URL is given, matching what a real win-back campaign lead actually gets
    (get_or_fetch_linkedin_posts -> _discover_and_save_linkedin_url). The
    other, credit-gated discovery fallback (Companies House officer lookup +
    AI search) is intentionally NOT replicated here: win-back leads are
    CSV-imported and CsvLeadRow has no company_number field at all, so that
    path can never fire for a win-back lead in real generation either — this
    matches real behavior exactly, not a preview-specific shortcut."""
    linkedin_url = linkedin_url.strip()
    if not linkedin_url:
        linkedin_url = await scrape_website_for_linkedin(website.strip()) or ""
    if not linkedin_url:
        return []
    return await _fetch_and_charge(linkedin_url, user_id, max_posts=max_posts, charge=charge)


def format_posts_for_prompt(posts: Optional[list[dict]]) -> str:
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
