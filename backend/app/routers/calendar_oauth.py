from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.dependencies import CurrentUser, get_current_user
from app.services.calendar_oauth_service import (
    PROVIDERS,
    OAuthNotConfiguredError,
    get_authorization_url,
)

router = APIRouter(prefix="/calendar-oauth", tags=["calendar-oauth"])

# No callback route here — the OAuth redirect URI for every integration
# this app has is /email-oauth/{provider}/callback, shared, registered once.
# See email_oauth.py's callback and migration 038's docstring for why.


def _validate_provider(provider: str) -> None:
    if provider not in PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider")


@router.get("/{provider}/connect")
def get_connect_url(provider: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    _validate_provider(provider)
    try:
        url = get_authorization_url(provider, current_user.id)
    except OAuthNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"url": url}


@router.get("/accounts")
def list_accounts(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    rows = db.list_calendar_oauth_accounts(current_user.id)
    return {"accounts": [{"provider": r["provider"], "email_address": r["email_address"]} for r in rows]}


@router.delete("/{provider}")
def disconnect(provider: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    _validate_provider(provider)
    db.delete_calendar_oauth_account(current_user.id, provider)
    return {"deleted": True}
