"""Weekly BDE performance scorecard — validation + week lookup helpers.
Auto-tracking aggregation queries (Qualified Leads Passed, Mass Email
Campaigns) are added in Phase C, once lead_status_history exists."""

import re
import sqlite3
from datetime import datetime

from app import db
from app.services.auth_service import new_id, now_iso

METRIC_KEYS = ("calls", "talk_time", "leads", "campaigns", "follow_up", "crm")

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def validate_week_commencing(value: str) -> str:
    if not _DATE_RE.match(value):
        raise ValueError("week_commencing must be YYYY-MM-DD")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ValueError("week_commencing must be a valid date")
    if parsed.weekday() != 0:
        raise ValueError("week_commencing must be a Monday")
    return value


def get_or_create_week(user_id: str, week_commencing: str) -> sqlite3.Row:
    row = db.get_scorecard_week(user_id, week_commencing)
    if row is not None:
        return row
    now = now_iso()
    db.create_scorecard_week(new_id(), user_id, week_commencing, now, now)
    return db.get_scorecard_week(user_id, week_commencing)
