"""Weekly BDE performance scorecard — validation, week lookup, and
auto-tracking for the two metrics with an honest CRM data source
(Qualified Leads Passed, Mass Email Campaigns). Calls/Talk Time and
Follow-up/CRM Compliance stay manual — see PROJECT_CONTEXT.md."""

import re
import sqlite3
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

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


# --- One-off Firestore -> SQLite migration (Phase D) ---

# The source app's own METRICS keys (camelCase) -> this schema's metric_key
# (snake_case). Anything not in this map is ignored, not errored on, since
# the export is a real historical artifact that shouldn't fail a whole
# import over one unrecognised field.
_SOURCE_METRIC_KEY_MAP = {
    "calls": "calls",
    "talkTime": "talk_time",
    "leads": "leads",
    "campaigns": "campaigns",
    "followUp": "follow_up",
    "crm": "crm",
}


def _norm_name(v: Optional[str]) -> str:
    return re.sub(r"\s+", " ", (v or "").strip().lower())


def match_user_by_name(profile_name: str, users: List[dict]) -> Optional[dict]:
    """Exact -> prefix -> first-name match, same precedence as the CSV call
    importer's matchMemberByName (scorecard.ts) and the source app's own
    matchProfileByName — kept identical on purpose so migrated profiles and
    live CSV imports resolve names the same way."""
    target = _norm_name(profile_name)
    if not target:
        return None
    first = target.split(" ")[0]
    exact = [u for u in users if _norm_name(u["name"]) == target]
    if len(exact) == 1:
        return exact[0]
    prefix = [
        u
        for u in users
        if _norm_name(u["name"]) and (target.startswith(_norm_name(u["name"])) or _norm_name(u["name"]).startswith(target))
    ]
    if len(prefix) == 1:
        return prefix[0]
    first_name = [u for u in users if _norm_name(u["name"]).split(" ")[0] == first]
    if len(first_name) == 1:
        return first_name[0]
    return None


def _profile_weeks(profile: dict) -> Dict[str, dict]:
    """{week_commencing: {rows, review_date, saved_at}} for every historical
    (profile.history) + live in-progress (profile.rows) week, matching the
    source app's own "current + history" shape — de-duplicated by week,
    live entry only included if its own week isn't already in history."""
    out: Dict[str, dict] = {}
    for entry in (profile.get("history") or {}).values():
        wc = (entry or {}).get("weekCommencing")
        if not wc:
            continue
        out[wc] = {"rows": (entry or {}).get("rows") or {}, "review_date": (entry or {}).get("reviewDate") or "", "saved_at": (entry or {}).get("savedAt")}
    live_wc = profile.get("weekCommencing")
    if live_wc and live_wc not in out:
        out[live_wc] = {"rows": profile.get("rows") or {}, "review_date": profile.get("reviewDate") or "", "saved_at": None}
    return out


def preview_migration(backup_json: Dict[str, Any]) -> Dict[str, Any]:
    """Read-only: proposes a profile -> user mapping and reports counts. No
    DB writes — an admin must review and confirm via commit_migration."""
    store = backup_json.get("store") or {}
    profiles = store.get("profiles") or {}
    users = [dict(u) for u in db.list_users()]

    results = []
    total_weeks = 0
    for profile_id, profile in profiles.items():
        profile = profile or {}
        weeks = _profile_weeks(profile)
        total_weeks += len(weeks)
        name = profile.get("name") or profile.get("bdeName") or "Untitled"
        match = match_user_by_name(name, users)
        results.append(
            {
                "profile_id": profile_id,
                "profile_name": name,
                "week_count": len(weeks),
                "suggested_user_id": match["id"] if match else None,
                "suggested_user_name": match["name"] if match else None,
            }
        )
    return {"profiles": results, "total_weeks": total_weeks}


def commit_migration(backup_json: Dict[str, Any], mapping: Dict[str, Optional[str]]) -> Dict[str, Any]:
    """Writes are upserts (safe to re-run) — same profile_id -> user_id
    mapping, imported twice, just overwrites the same weeks with the same
    values. Profiles omitted from `mapping` (or mapped to null) are
    skipped, e.g. test/departed-employee entries an admin chose not to
    import."""
    store = backup_json.get("store") or {}
    profiles = store.get("profiles") or {}
    settings_blob = backup_json.get("settings") or {}
    now = now_iso()

    settings_imported = False
    if settings_blob:
        current = db.get_scorecard_settings()
        green = settings_blob.get("green")
        amber = settings_blob.get("amber")
        db.update_scorecard_settings(
            green_threshold=float(green) if green else current["green_threshold"],
            amber_threshold=float(amber) if amber else current["amber_threshold"],
            qualifying_field=current["qualifying_field"],
            qualifying_value=current["qualifying_value"],
            notes_visibility=current["notes_visibility"],
            updated_at=now,
        )
        for src_key, target_value in (settings_blob.get("targets") or {}).items():
            dest_key = _SOURCE_METRIC_KEY_MAP.get(src_key)
            if dest_key and target_value:
                db.update_scorecard_metric_target(dest_key, float(target_value), now)
        settings_imported = True

    profiles_imported = 0
    weeks_imported = 0
    for profile_id, user_id in mapping.items():
        if not user_id:
            continue
        profile = profiles.get(profile_id)
        if not profile:
            continue
        for week_commencing, data in _profile_weeks(profile).items():
            try:
                validate_week_commencing(week_commencing)
            except ValueError:
                continue
            week_row = get_or_create_week(user_id, week_commencing)
            if data["review_date"]:
                db.update_scorecard_week_review_date(week_row["id"], data["review_date"], now)
            if data["saved_at"]:
                db.mark_scorecard_week_saved(week_row["id"], data["saved_at"])
            for src_key, cell in (data["rows"] or {}).items():
                dest_key = _SOURCE_METRIC_KEY_MAP.get(src_key)
                if not dest_key:
                    continue
                actual_raw = (cell or {}).get("actual")
                try:
                    actual = float(actual_raw) if actual_raw not in (None, "") else None
                except (TypeError, ValueError):
                    actual = None
                db.upsert_scorecard_entry(
                    new_id(),
                    week_row["id"],
                    dest_key,
                    actual,
                    (cell or {}).get("notes") or "",
                    (cell or {}).get("action") or "",
                    "manual",
                    now,
                )
            weeks_imported += 1
        profiles_imported += 1

    return {"profiles_imported": profiles_imported, "weeks_imported": weeks_imported, "settings_imported": settings_imported}
