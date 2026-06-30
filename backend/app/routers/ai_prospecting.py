import asyncio
import json

from fastapi import APIRouter, Depends

from app import db
from app.core.config import get_settings
from app.dependencies import CurrentUser, get_current_user
from app.schemas_ai_prospecting import (
    ProspectingCriteria,
    ProspectingRunOut,
    StartProspectingResponse,
)
from app.services.auth_service import new_id, now_iso
from app.services.ai_prospecting_service import run_prospecting

router = APIRouter(prefix="/ai-prospecting", tags=["ai-prospecting"])


def _to_run_out(row) -> ProspectingRunOut:
    return ProspectingRunOut(
        id=row["id"],
        status=row["status"],
        criteria=row["criteria"],
        found=row["found"],
        created=row["created"],
        skipped=row["skipped"],
        error=row["error"],
        started_at=row["started_at"],
        completed_at=row["completed_at"],
    )


@router.get("/status")
def get_status(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    """Check whether Companies House API is configured — shown in the UI
    before allowing a run to start."""
    configured = bool(get_settings().companies_house_api_key)
    return {"configured": configured}


@router.get("/runs")
def list_runs(current_user: CurrentUser = Depends(get_current_user)) -> list[ProspectingRunOut]:
    return [_to_run_out(r) for r in db.list_prospecting_runs(current_user.id)]


@router.get("/runs/{run_id}")
def get_run(run_id: str, current_user: CurrentUser = Depends(get_current_user)) -> ProspectingRunOut:
    row = db.get_prospecting_run(run_id)
    if row is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Run not found")
    return _to_run_out(row)


@router.post("/run")
async def start_run(
    criteria: ProspectingCriteria, current_user: CurrentUser = Depends(get_current_user)
) -> StartProspectingResponse:
    """Starts a prospecting run as a background task. Poll /runs/{run_id}
    for live progress (found / created / skipped counts)."""
    run_id = new_id()
    db.create_prospecting_run(run_id, current_user.id, json.dumps(criteria.model_dump()), now_iso())
    asyncio.create_task(run_prospecting(run_id, current_user.id, criteria))
    return StartProspectingResponse(
        run_id=run_id,
        message="Prospecting run started — poll /ai-prospecting/runs/{run_id} for progress.",
    )
