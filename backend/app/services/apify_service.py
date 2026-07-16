"""Apify API client — runs the "LinkedIn Profile Posts scraper" actor.

API: POST https://api.apify.com/v2/acts/{actor_id}/run-sync-get-dataset-items
Auth: token query param (the user's Apify API token).

This is a pure transport layer: it knows nothing about leads, credit limits,
or caching — that orchestration lives in linkedin_activity_service.py.
"""

import logging
from typing import Optional

import httpx

logger = logging.getLogger("app.apify")

APIFY_BASE_URL = "https://api.apify.com/v2"


class ApifyRateLimitError(Exception):
    pass


def _client(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=APIFY_BASE_URL,
        params={"token": token},
        timeout=120.0,
    )


async def run_linkedin_post_scrape(
    token: str,
    actor_id: str,
    target_urls: list[str],
    max_posts: int = 10,
    posted_limit_date: Optional[str] = None,
) -> list[dict]:
    """Runs the actor synchronously and returns its dataset items directly —
    no separate poll/fetch step needed. Returns [] on any failure; the caller
    decides what "no data" means. Raises ApifyRateLimitError on a 429 so the
    caller can back off rather than silently treat a rate limit as "no posts"."""
    body: dict = {"targetUrls": target_urls, "maxPosts": max_posts}
    if posted_limit_date:
        body["postedLimitDate"] = posted_limit_date

    # Apify's URL path form requires "username~actor-name", but the console
    # displays (and users copy) "username/actor-name" — normalize so either
    # pasted format works.
    url_safe_actor_id = actor_id.replace("/", "~")

    try:
        async with _client(token) as client:
            r = await client.post(f"/acts/{url_safe_actor_id}/run-sync-get-dataset-items", json=body)
            if r.status_code == 429:
                raise ApifyRateLimitError("Apify actor run rate limited")
            if r.status_code not in (200, 201):
                logger.warning("Apify: actor run returned %d: %s", r.status_code, r.text[:200])
                return []
            return r.json()
    except ApifyRateLimitError:
        raise
    except Exception as exc:
        logger.warning("Apify: LinkedIn post scrape failed for %s: %s", target_urls, exc)
        return []
