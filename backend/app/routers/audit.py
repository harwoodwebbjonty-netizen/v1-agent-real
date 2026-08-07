from fastapi import APIRouter, Depends

from app import db
from app.dependencies import CurrentUser, require_permission

router = APIRouter(prefix="/audit-log", tags=["audit"])


@router.get("")
def get_audit_log(
    limit: int = 200, offset: int = 0, admin: CurrentUser = Depends(require_permission("view_audit_log"))
) -> dict:
    """Admin-only accountability trail: who changed what, most recent first."""
    limit = max(1, min(limit, 500))
    rows = db.list_audit_log(limit=limit, offset=max(0, offset))
    return {
        "entries": [
            {
                "id": r["id"],
                "actor_name": r["actor_name"],
                "action": r["action"],
                "entity_type": r["entity_type"],
                "entity_id": r["entity_id"],
                "detail": r["detail"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    }
