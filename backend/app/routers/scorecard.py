from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.dependencies import CurrentUser, require_permission
from app.schemas_scorecard import (
    ScorecardEntryOut,
    ScorecardMetricTargetOut,
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


def _week_to_out(week_row, entries_rows) -> ScorecardWeekOut:
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
    return ScorecardWeekOut(
        id=week_row["id"],
        user_id=week_row["user_id"],
        week_commencing=week_row["week_commencing"],
        review_date=week_row["review_date"] or "",
        saved_at=week_row["saved_at"],
        entries=entries,
    )


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
    weeks = db.list_scorecard_weeks_for_user(user_id, since, until)
    out = [_week_to_out(w, db.list_scorecard_entries_for_week(w["id"])) for w in weeks]
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


@router.get("/weeks/all", response_model=ScorecardSummaryResponse)
def get_weeks_all(
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    current_user: CurrentUser = Depends(require_permission("view_scorecard")),
) -> ScorecardSummaryResponse:
    rows = db.list_scorecard_weeks_all_summary(since, until)
    entries = [
        ScorecardSummaryEntry(
            user_id=r["user_id"],
            week_commencing=r["week_commencing"],
            saved_at=r["saved_at"],
            metric_key=r["metric_key"],
            actual=r["actual"],
            source=r["source"],
        )
        for r in rows
    ]
    return ScorecardSummaryResponse(entries=entries)
