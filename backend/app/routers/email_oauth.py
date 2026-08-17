import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse

from app import db
from app.services import calendar_oauth_service

logger = logging.getLogger("app.email_oauth")
from app.dependencies import CurrentUser, get_current_user
from app.services.email_oauth_service import (
    PROVIDERS,
    OAuthError,
    OAuthNotConfiguredError,
    get_authorization_url,
    handle_oauth_callback,
)

router = APIRouter(prefix="/email-oauth", tags=["email-oauth"])


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
    # No auth dependency here on purpose — this is hit by the browser
    # redirecting back from Google/Microsoft, not an authenticated app
    # request. Shared by every OAuth-based connector this app has (email
    # today, calendar too) — one registered redirect URI, ever, no matter
    # how many integrations get added later. Which service a grant belongs
    # to is carried by the state row's `purpose` (see migration 038), not
    # by the URI, so this dispatches on that instead of each service owning
    # its own callback route.
    _validate_provider(provider)
    state_row = db.consume_oauth_state(state)
    if state_row is None or state_row["provider"] != provider:
        logger.warning("OAuth callback with invalid/expired state for provider %s", provider)
        return (
            "<html><body><h2>Connection failed</h2>"
            "<p>You can close this window and try again in the app.</p></body></html>"
        )
    user_id = state_row["user_id"]
    purpose = state_row["purpose"] if "purpose" in state_row.keys() else "email"
    try:
        if purpose == "calendar":
            await calendar_oauth_service.handle_oauth_callback(provider, code, user_id)
        else:
            await handle_oauth_callback(provider, code, user_id)
    except OAuthError:
        # Deliberately generic — never reflect the exception (it can carry the
        # provider's raw token-endpoint response) into this HTML page.
        logger.warning("OAuth callback failed for provider %s (purpose=%s)", provider, purpose)
        return (
            "<html><body><h2>Connection failed</h2>"
            "<p>You can close this window and try again in the app.</p></body></html>"
        )
    return "<html><body><h2>Connected!</h2><p>You can close this window and return to the app.</p></body></html>"


@router.get("/accounts")
def list_accounts(current_user: CurrentUser = Depends(get_current_user)) -> dict:
    rows = db.list_email_oauth_accounts(current_user.id)
    return {"accounts": [{"provider": r["provider"], "email_address": r["email_address"]} for r in rows]}


@router.delete("/{provider}")
def disconnect(provider: str, current_user: CurrentUser = Depends(get_current_user)) -> dict:
    _validate_provider(provider)
    db.delete_email_oauth_account(current_user.id, provider)
    return {"deleted": True}
