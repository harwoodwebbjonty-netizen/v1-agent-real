"""Weekly BDE performance scorecard — validation, week lookup, and
auto-tracking for the two metrics with an honest CRM data source
(Qualified Leads Passed, Mass Email Campaigns). Calls/Talk Time and
Follow-up/CRM Compliance stay manual — see PROJECT_CONTEXT.md."""

import re
import sqlite3
from datetime import datetime
from typing import Dict, Tuple

from app import db
from app.services.auth_service import new_id, now_iso

METRIC_KEYS = ("calls", "talk_time", "leads", "campaigns", "follow_up", "crm")

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Only these two metrics have a query implemented below — kept in sync with
# which metric_key rows migration 041 flips to auto_tracked=1. If a future
# metric ever needs auto-tracking, its query must be added here too.
AUTO_TRACKABLE_METRIC_KEYS = ("leads", "campaigns")


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


def auto_tracked_metric_keys() -> set:
    return {t["metric_key"] for t in db.list_scorecard_metric_targets() if t["auto_tracked"]}


def compute_auto_values() -> Dict[Tuple[str, str, str], float]:
    """{(user_id, week_commencing, metric_key): value} across all history,
    for every metric this service knows how to auto-track. Computed fresh
    on every call (recompute-on-read, matching this codebase's existing
    style elsewhere — no cron/scheduler) — cheap at this team's data volume,
    and never persisted, since a manually-entered scorecard_entries row
    always takes precedence over whatever this returns."""
    settings_row = db.get_scorecard_settings()
    out: Dict[Tuple[str, str, str], float] = {}
    for row in db.qualified_leads_passed_by_week(settings_row["qualifying_field"], settings_row["qualifying_value"]):
        out[(row["user_id"], row["week_commencing"], "leads")] = float(row["value"])
    for row in db.campaigns_sent_by_week():
        out[(row["user_id"], row["week_commencing"], "campaigns")] = float(row["value"])
    return out
