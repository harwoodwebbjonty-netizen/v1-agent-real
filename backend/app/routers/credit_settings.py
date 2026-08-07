from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.dependencies import CurrentUser, get_current_user, require_permission
from app.services.auth_service import now_iso

router = APIRouter(prefix="/credit-settings", tags=["credit-settings"])


def _limits_for(user_id: str) -> dict:
    settings = db.get_all_user_settings(user_id)
    return {
        f"limit_{feat}": float(settings.get(f"limit_{feat}", "0") or "0")
        for feat in db.CREDIT_FEATURES
    }


@router.get("/limits")
def get_limits(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    return _limits_for(current_user.id)


@router.post("/limits")
def save_limits(body: dict, admin: CurrentUser = Depends(require_permission("change_credit_limits"))) -> dict:
    """Admin-only: users spend on the org's API keys, so only an admin may
    change budgets. Pass user_id to set another user's limits (defaults to
    the admin's own)."""
    target_id = body.get("user_id") or admin.id
    if db.get_user_by_id(target_id) is None:
        raise HTTPException(status_code=404, detail="User not found")
    now = now_iso()
    for feat in db.CREDIT_FEATURES:
        key = f"limit_{feat}"
        if key in body:
            try:
                val = str(max(0.0, float(body[key])))
            except (ValueError, TypeError):
                val = "0"
            db.set_user_setting(target_id, key, val, now)
    db.record_audit(admin.id, admin.name, "credit_limit_change", "user", target_id)
    return {"saved": True}


@router.get("/usage")
def get_usage(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    spend = db.get_monthly_credit_spend(current_user.id)
    limits = _limits_for(current_user.id)
    return {"spend": spend, "limits": limits}
