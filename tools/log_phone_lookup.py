#!/usr/bin/env python3
"""Append a company phone number lookup result to data/phone_lookups.csv."""
import argparse
import csv
from datetime import datetime, timezone
from pathlib import Path

LOG_PATH = Path(__file__).resolve().parent.parent / "data" / "phone_lookups.csv"
FIELDS = ["timestamp", "company", "phone_number", "source_url", "status", "notes"]


def main():
    parser = argparse.ArgumentParser(description="Log a company phone number lookup result.")
    parser.add_argument("--company", required=True)
    parser.add_argument("--phone", required=True, help="Phone number found, or 'not_found'")
    parser.add_argument("--source", required=True, help="URL where the number was found, or 'n/a'")
    parser.add_argument("--status", required=True, choices=["verified", "unverified", "not_found"])
    parser.add_argument("--notes", default="")
    args = parser.parse_args()

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    is_new = not LOG_PATH.exists()

    with LOG_PATH.open("a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        if is_new:
            writer.writeheader()
        writer.writerow({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "company": args.company,
            "phone_number": args.phone,
            "source_url": args.source,
            "status": args.status,
            "notes": args.notes,
        })

    print(f"Logged lookup for '{args.company}' to {LOG_PATH}")


if __name__ == "__main__":
    main()
