#!/usr/bin/env python3
"""Post a text update to LinkedIn on the authenticated member's behalf.

Requires LINKEDIN_ACCESS_TOKEN and LINKEDIN_PERSON_URN in .env — run
tools/linkedin_oauth_setup.py first to obtain them.
"""
import argparse
import csv
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from linkedin_env import load_env

LOG_PATH = Path(__file__).resolve().parent.parent / "data" / "linkedin_posts.csv"
FIELDS = ["timestamp", "text", "post_urn", "status", "notes"]
API_VERSION = "202506"  # bump to a more recent YYYYMM if LinkedIn rejects it as unsupported


def log_result(text, post_urn, status, notes=""):
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    is_new = not LOG_PATH.exists()
    with LOG_PATH.open("a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        if is_new:
            writer.writeheader()
        writer.writerow({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "text": text,
            "post_urn": post_urn,
            "status": status,
            "notes": notes,
        })


def main():
    parser = argparse.ArgumentParser(description="Post a text update to LinkedIn.")
    parser.add_argument("--text", required=True, help="Post body text")
    parser.add_argument("--dry-run", action="store_true", help="Print the request body without sending it")
    args = parser.parse_args()

    env = load_env()
    token = env.get("LINKEDIN_ACCESS_TOKEN")
    person_urn = env.get("LINKEDIN_PERSON_URN")
    if not token or not person_urn:
        sys.exit("Missing LINKEDIN_ACCESS_TOKEN / LINKEDIN_PERSON_URN in .env — run tools/linkedin_oauth_setup.py first.")

    body = {
        "author": person_urn,
        "commentary": args.text,
        "visibility": "PUBLIC",
        "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": [],
        },
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }

    if args.dry_run:
        print(json.dumps(body, indent=2))
        return

    request = urllib.request.Request(
        "https://api.linkedin.com/rest/posts",
        data=json.dumps(body).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
            "LinkedIn-Version": API_VERSION,
        },
    )

    try:
        response = urllib.request.urlopen(request)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        log_result(args.text, "", "failed", error_body[:300])
        sys.exit(f"LinkedIn API error {e.code}: {error_body}")

    post_urn = response.headers.get("x-restli-id", "")
    log_result(args.text, post_urn, "published")
    print(f"Published. Post URN: {post_urn}")


if __name__ == "__main__":
    main()
