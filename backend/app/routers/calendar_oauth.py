import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse

from app import db

logger = logging.getLogger("app.calendar_oauth")
from app.dependencies import CurrentUser, get_current_user
from app.services.calendar_oauth_service import (
    PROVIDERS,
    OAuthError,
    OAuthNotConfiguredError,
    get_authorization_url,
    handle_oauth_callback,
)

router = APIRouter(prefix="/calendar-oauth", tags=["calendar-oauth"])


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


@router.get("/{provider}/callback", response_class=HTMLResponse)
async def oauth_callback(provider: str, code: str = Query(...), state: str = Query(...)) -> str:
    # No auth dependency here on purpose — see email_oauth.py's identical callback.
    _validate_provider(provider)
    try:
        await handle_oauth_callback(provider, code, state)
    except OAuthError:
        logger.warning("Calendar OAuth callback failed for provider %s", provider)
        return (
            "<html><body><h2>Connection failed</h2>"
            "<p>You can close this window and try again in the app.</p></body></html>"
        )
    return "<html><body><h2>Connected!</h2><p>You can close this window and return to the app.</p></body></html>"


@router.get("/accounts")
def list_accounts(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    rows = db.list_calendar_oauth_accounts(current_user.id)
    return {"accounts": [{"provider": r["provider"], "email_address": r["email_address"]} for r in rows]}


@router.delete("/{provider}")
def disconnect(provider: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    _validate_provider(provider)
    db.delete_calendar_oauth_account(current_user.id, provider)
    return {"deleted": True}
