from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.dependencies import CurrentUser, require_admin, require_permission
from app.schemas_scorecard import (
    ScorecardEntryOut,
    ScorecardMetricTargetOut,
    ScorecardMigrateCommitRequest,
    ScorecardMigrateCommitResponse,
    ScorecardMigratePreviewRequest,
    ScorecardMigratePreviewResponse,
    ScorecardMigrateProfileSummary,
    ScorecardSettingsOut,
    ScorecardSummaryEntry,
    ScorecardSummaryResponse,
    ScorecardWeekOut,
    ScorecardWeeksResponse,
    UpdateScorecardSettingsRequest,
    UpsertScorecardWeekRequest,
)
from app.services import scorecard_service
from app.services.auth_service import new_id, now_iso

router = APIRouter(prefix="/scorecard", tags=["scorecard"])

METRIC_KEYS = scorecard_service.METRIC_KEYS


def _week_to_out(week_row, entries_rows, auto_values=None) -> ScorecardWeekOut:
    entries = {
        e["metric_key"]: ScorecardEntryOut(
            metric_key=e["metric_key"],
            actual=e["actual"],
            notes=e["notes"],
            action=e["action"],
            source=e["source"],
            updated_at=e["updated_at"],
        )
        for e in entries_rows
    }
    _apply_auto_tracking(entries, week_row["user_id"], week_row["week_commencing"], auto_values)
    return ScorecardWeekOut(
        id=week_row["id"],
        user_id=week_row["user_id"],
        week_commencing=week_row["week_commencing"],
        review_date=week_row["review_date"] or "",
        saved_at=week_row["saved_at"],
        entries=entries,
    )


def _apply_auto_tracking(entries: dict, user_id: str, week_commencing: str, auto_values=None) -> None:
    """Fills in any auto-tracked metric that has no manual override for this
    week — a stored entry always wins (every stored entry is manual by
    construction; nothing here is ever persisted). Computed values default
    to 0 rather than being omitted: once a metric is auto-tracked, "0 this
    week" is a real, known fact, not an absence of data."""
    if auto_values is None:
        auto_values = scorecard_service.compute_auto_values()
    now = now_iso()
    for metric_key in scorecard_service.auto_tracked_metric_keys():
        if metric_key in entries:
            continue
        value = auto_values.get((user_id, week_commencing, metric_key), 0.0)
        entries[metric_key] = ScorecardEntryOut(metric_key=metric_key, actual=value, notes="", action="", source="auto", updated_at=now)


def _require_can_view(target_user_id: str, current_user: CurrentUser) -> None:
    if target_user_id == current_user.id:
        return
    if current_user.has("view_scorecard_manager"):
        return
    settings_row = db.get_scorecard_settings()
    if settings_row["notes_visibility"] == "team":
        return
    raise HTTPException(status_code=403, detail="You can only view your own scorecard.")


def _require_can_edit(target_user_id: str, current_user: CurrentUser) -> None:
    if target_user_id != current_user.id and not current_user.has("view_scorecard_manager"):
        raise HTTPException(status_code=403, detail="You can only edit your own scorecard.")


def _settings_out() -> ScorecardSettingsOut:
    row = db.get_scorecard_settings()
    targets = [
        ScorecardMetricTargetOut(
            metric_key=t["metric_key"], target_value=t["target_value"], auto_tracked=bool(t["auto_tracked"])
        )
        for t in db.list_scorecard_metric_targets()
    ]
    return ScorecardSettingsOut(
        green_threshold=row["green_threshold"],
        amber_threshold=row["amber_threshold"],
        qualifying_field=row["qualifying_field"],
        qualifying_value=row["qualifying_value"],
        notes_visibility=row["notes_visibility"],
        targets=targets,
    )


@router.get("/settings", response_model=ScorecardSettingsOut)
def get_settings(current_user: CurrentUser = Depends(require_permission("view_scorecard"))) -> ScorecardSettingsOut:
    return _settings_out()


@router.put("/settings", response_model=ScorecardSettingsOut)
def update_settings(
    body: UpdateScorecardSettingsRequest,
    current_user: CurrentUser = Depends(require_permission("view_scorecard_manager")),
) -> ScorecardSettingsOut:
    current = db.get_scorecard_settings()
    now = now_iso()
    db.update_scorecard_settings(
        green_threshold=body.green_threshold if body.green_threshold is not None else current["green_threshold"],
        amber_threshold=body.amber_threshold if body.amber_threshold is not None else current["amber_threshold"],
        qualifying_field=body.qualifying_field if body.qualifying_field is not None else current["qualifying_field"],
        qualifying_value=body.qualifying_value if body.qualifying_value is not None else current["qualifying_value"],
        notes_visibility=body.notes_visibility if body.notes_visibility is not None else current["notes_visibility"],
        updated_at=now,
    )
    if body.targets:
        for metric_key, target_value in body.targets.items():
            if metric_key not in METRIC_KEYS:
                continue
            db.update_scorecard_metric_target(metric_key, target_value, now)
    return _settings_out()


@router.get("/weeks", response_model=ScorecardWeeksResponse)
def get_weeks(
    user_id: str = Query(...),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    current_user: CurrentUser = Depends(require_permission("view_scorecard")),
) -> ScorecardWeeksResponse:
    _require_can_view(user_id, current_user)
    auto_values = scorecard_service.compute_auto_values()
    weeks = db.list_scorecard_weeks_for_user(user_id, since, until)
    out = [_week_to_out(w, db.list_scorecard_entries_for_week(w["id"]), auto_values) for w in weeks]

    # A single specific week (the entry form's own request shape) with no
    # stored row yet still needs to surface auto-tracked values, so a rep
    # who's never opened the Scorecard tab this week still sees them.
    if since and until and since == until and not any(w.week_commencing == since for w in out):
        has_auto_data = any(key[0] == user_id and key[1] == since for key in auto_values)
        if has_auto_data:
            virtual = {"id": "", "user_id": user_id, "week_commencing": since, "review_date": "", "saved_at": None}
            out.append(_week_to_out(virtual, [], auto_values))

    return ScorecardWeeksResponse(weeks=out)


@router.put("/weeks/{user_id}/{week_commencing}", response_model=ScorecardWeekOut)
def upsert_week(
    user_id: str,
    week_commencing: str,
    body: UpsertScorecardWeekRequest,
    current_user: CurrentUser = Depends(require_permission("view_scorecard")),
) -> ScorecardWeekOut:
    _require_can_edit(user_id, current_user)
    try:
        scorecard_service.validate_week_commencing(week_commencing)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    week_row = scorecard_service.get_or_create_week(user_id, week_commencing)
    now = now_iso()
    if body.review_date:
        db.update_scorecard_week_review_date(week_row["id"], body.review_date, now)

    for metric_key, entry in body.entries.items():
        if metric_key not in METRIC_KEYS:
            continue
        db.upsert_scorecard_entry(new_id(), week_row["id"], metric_key, entry.actual, entry.notes, entry.action, "manual", now)

    week_row = db.get_scorecard_week(user_id, week_commencing)
    return _week_to_out(week_row, db.list_scorecard_entries_for_week(week_row["id"]))


@router.post("/weeks/{user_id}/{week_commencing}/save", response_model=ScorecardWeekOut)
def save_week(
    user_id: str,
    week_commencing: str,
    current_user: CurrentUser = Depends(require_permission("view_scorecard")),
) -> ScorecardWeekOut:
    _require_can_edit(user_id, current_user)
    week_row = scorecard_service.get_or_create_week(user_id, week_commencing)
    db.mark_scorecard_week_saved(week_row["id"], now_iso())
    week_row = db.get_scorecard_week(user_id, week_commencing)
    return _week_to_out(week_row, db.list_scorecard_entries_for_week(week_row["id"]))


@router.delete("/weeks/{user_id}/{week_commencing}")
def delete_week(
    user_id: str,
    week_commencing: str,
    current_user: CurrentUser = Depends(require_permission("view_scorecard")),
) -> dict:
    _require_can_edit(user_id, current_user)
    week_row = db.get_scorecard_week(user_id, week_commencing)
    if week_row is None:
        raise HTTPException(status_code=404, detail="No such week")
    db.delete_scorecard_week(week_row["id"])
    return {"deleted": True}


@router.get("/weeks/all", response_model=ScorecardSummaryResponse)
def get_weeks_all(
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    current_user: CurrentUser = Depends(require_permission("view_scorecard")),
) -> ScorecardSummaryResponse:
    stored_rows = db.list_scorecard_weeks_all_summary(since, until)
    merged: dict = {}
    for r in stored_rows:
        merged[(r["user_id"], r["week_commencing"], r["metric_key"])] = ScorecardSummaryEntry(
            user_id=r["user_id"],
            week_commencing=r["week_commencing"],
            saved_at=r["saved_at"],
            metric_key=r["metric_key"],
            actual=r["actual"],
            source=r["source"],
        )

    # Auto-tracked activity surfaces on the team leaderboard/manager view
    # even for a rep who's never opened the Scorecard tab that week — that's
    # the whole point of auto-tracking. A manual override always wins.
    auto_tracked_keys = scorecard_service.auto_tracked_metric_keys()
    for (user_id, week_commencing, metric_key), value in scorecard_service.compute_auto_values().items():
        if metric_key not in auto_tracked_keys:
            continue
        if since and week_commencing < since:
            continue
        if until and week_commencing > until:
            continue
        key = (user_id, week_commencing, metric_key)
        if key in merged:
            continue
        merged[key] = ScorecardSummaryEntry(
            user_id=user_id, week_commencing=week_commencing, saved_at=None, metric_key=metric_key, actual=value, source="auto"
        )

    return ScorecardSummaryResponse(entries=list(merged.values()))


@router.post("/migrate/preview", response_model=ScorecardMigratePreviewResponse)
def migrate_preview(body: ScorecardMigratePreviewRequest, current_user: CurrentUser = Depends(require_admin)) -> ScorecardMigratePreviewResponse:
    result = scorecard_service.preview_migration(body.backup_json)
    return ScorecardMigratePreviewResponse(
        profiles=[ScorecardMigrateProfileSummary(**p) for p in result["profiles"]],
        total_weeks=result["total_weeks"],
    )


@router.post("/migrate/commit", response_model=ScorecardMigrateCommitResponse)
def migrate_commit(body: ScorecardMigrateCommitRequest, current_user: CurrentUser = Depends(require_admin)) -> ScorecardMigrateCommitResponse:
    result = scorecard_service.commit_migration(body.backup_json, body.mapping)
    db.record_audit(
        current_user.id,
        current_user.name,
        "scorecard_migrate",
        "scorecard",
        "",
        detail=f"{result['profiles_imported']} profiles, {result['weeks_imported']} weeks",
    )
    return ScorecardMigrateCommitResponse(**result)
