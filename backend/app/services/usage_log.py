import csv
from datetime import datetime, timezone
from pathlib import Path

LOG_PATH = Path(__file__).resolve().parents[2] / "data" / "usage_log.csv"
FIELDS = ["timestamp", "user_id", "company", "status", "success"]


def record_usage(user_id: str, company: str, status: str, success: bool) -> None:
    """Seed for future usage-based billing. Append-only, local file for now."""
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    is_new = not LOG_PATH.exists()

    with LOG_PATH.open("a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        if is_new:
            writer.writeheader()
        writer.writerow(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "user_id": user_id,
                "company": company,
                "status": status,
                "success": success,
            }
        )
