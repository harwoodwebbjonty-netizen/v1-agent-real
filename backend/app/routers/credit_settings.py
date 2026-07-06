from fastapi import APIRouter, Depends

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.services.auth_service import now_iso

router = APIRouter(prefix="/credit-settings", tags=["credit-settings"])


@router.get("/limits")
def get_limits(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    settings = db.get_all_user_settings(current_user.id)
    return {
        f"limit_{feat}": float(settings.get(f"limit_{feat}", "0") or "0")
        for feat in db.CREDIT_FEATURES
    }


@router.post("/limits")
def save_limits(body: dict, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    now = now_iso()
    for feat in db.CREDIT_FEATURES:
        key = f"limit_{feat}"
        if key in body:
            try:
                val = str(max(0.0, float(body[key])))
            except (ValueError, TypeError):
                val = "0"
            db.set_user_setting(current_user.id, key, val, now)
    return {"saved": True}


@router.get("/usage")
def get_usage(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    spend = db.get_monthly_credit_spend(current_user.id)
    limits = get_limits(current_user)
    return {"spend": spend, "limits": limits}
