import secrets
from datetime import datetime, timedelta, timezone

import httpx

from app import db
from app.core.config import get_settings
from app.services.auth_service import new_id, now_iso
from app.services.token_crypto import TokenDecryptionError, decrypt_token, encrypt_token

# Mirrors email_oauth_service.py's OAuth mechanics (same anti-CSRF `state`
# table, same client id/secret — the roadmap's own note: this reuses the
# existing OAuth app registrations, just requests a materially bigger
# scope). Kept as a separate module/table rather than folded into
# email_oauth_service so a user can hold an email grant, a calendar grant,
# both, or neither, independently — see migration 037's docstring.

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.events openid email"
GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"

MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
MICROSOFT_USERINFO_URL = "https://graph.microsoft.com/v1.0/me"
MICROSOFT_SCOPES = "https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/User.Read offline_access openid email"
MICROSOFT_EVENTS_URL = "https://graph.microsoft.com/v1.0/me/events"

PROVIDERS = ("gmail", "microsoft")

# No stored timezone on calendar_events (date/time strings only, no tz field)
# — this tool is single-team/UK-based today, so pushed events are stamped
# with this fixed IANA zone rather than adding a per-user timezone setting
# that nothing else in the app has yet. Revisit if the team ever spans zones.
DEFAULT_TIMEZONE = "Europe/London"
DEFAULT_EVENT_DURATION_MINUTES = 30


class OAuthNotConfiguredError(Exception):
    pass


class OAuthError(Exception):
    pass


def _redirect_uri(provider: str) -> str:
    # Deliberately the SAME path email OAuth uses, not a calendar-specific
    # one — see migration 038's docstring. Google/Microsoft only need one
    # redirect URI ever registered for this app; which service a given
    # consent grant is for is carried by the `purpose` on the state row,
    # not by the URI.
    settings = get_settings()
    base = settings.public_base_url or settings.oauth_redirect_base_url
    return f"{base}/email-oauth/{provider}/callback"


def get_authorization_url(provider: str, user_id: str) -> str:
    settings = get_settings()
    state = secrets.token_urlsafe(24)
    db.create_oauth_state(state, user_id, provider, now_iso(), purpose="calendar")
    if provider == "gmail":
        if not settings.google_oauth_client_id:
            raise OAuthNotConfiguredError("Google OAuth is not configured yet.")
        params = httpx.QueryParams(
            {
                "client_id": settings.google_oauth_client_id,
                "redirect_uri": _redirect_uri("gmail"),
                "response_type": "code",
                "scope": GOOGLE_SCOPES,
                "access_type": "offline",
                "prompt": "consent",
                "state": state,
            }
        )
        return f"{GOOGLE_AUTH_URL}?{params}"
    if provider == "microsoft":
        if not settings.microsoft_oauth_client_id:
            raise OAuthNotConfiguredError("Microsoft OAuth is not configured yet.")
        params = httpx.QueryParams(
            {
                "client_id": settings.microsoft_oauth_client_id,
                "redirect_uri": _redirect_uri("microsoft"),
                "response_type": "code",
                "scope": MICROSOFT_SCOPES,
                "state": state,
            }
        )
        return f"{MICROSOFT_AUTH_URL}?{params}"
    raise ValueError(f"Unknown provider: {provider}")


async def handle_oauth_callback(provider: str, code: str, user_id: str) -> None:
    """`user_id` is already resolved by the shared callback route in
    email_oauth.py — see email_oauth_service.handle_oauth_callback's
    docstring for why this no longer consumes the state itself."""
    settings = get_settings()

    async with httpx.AsyncClient(timeout=15.0) as client:
        if provider == "gmail":
            token_response = await client.post(
                GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": settings.google_oauth_client_id,
                    "client_secret": settings.google_oauth_client_secret,
                    "redirect_uri": _redirect_uri("gmail"),
                    "grant_type": "authorization_code",
                },
            )
            if token_response.status_code != 200:
                raise OAuthError(f"Google token exchange failed: {token_response.text}")
            tokens = token_response.json()
            userinfo_response = await client.get(
                GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {tokens['access_token']}"}
            )
            if userinfo_response.status_code != 200:
                raise OAuthError(f"Google userinfo fetch failed: {userinfo_response.text}")
            email_address = userinfo_response.json().get("email", "")
        elif provider == "microsoft":
            token_response = await client.post(
                MICROSOFT_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": settings.microsoft_oauth_client_id,
                    "client_secret": settings.microsoft_oauth_client_secret,
                    "redirect_uri": _redirect_uri("microsoft"),
                    "grant_type": "authorization_code",
                    "scope": MICROSOFT_SCOPES,
                },
            )
            if token_response.status_code != 200:
                raise OAuthError(f"Microsoft token exchange failed: {token_response.text}")
            tokens = token_response.json()
            userinfo_response = await client.get(
                MICROSOFT_USERINFO_URL, headers={"Authorization": f"Bearer {tokens['access_token']}"}
            )
            if userinfo_response.status_code != 200:
                raise OAuthError(f"Microsoft userinfo fetch failed: {userinfo_response.text}")
            userinfo = userinfo_response.json()
            email_address = userinfo.get("mail") or userinfo.get("userPrincipalName", "")
        else:
            raise ValueError(f"Unknown provider: {provider}")

    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3600))).isoformat()
    db.upsert_calendar_oauth_account(
        new_id(),
        user_id,
        provider,
        email_address,
        encrypt_token(tokens["access_token"]),
        encrypt_token(tokens.get("refresh_token", "")),
        expires_at,
        now_iso(),
    )


async def refresh_token_if_needed(account_row) -> str:
    try:
        stored_refresh_token = decrypt_token(account_row["refresh_token"])
        expires_at = datetime.fromisoformat(account_row["token_expires_at"])
        if datetime.now(timezone.utc) < expires_at:
            return decrypt_token(account_row["access_token"])
    except TokenDecryptionError as exc:
        raise OAuthError(str(exc)) from exc

    settings = get_settings()
    provider = account_row["provider"]
    async with httpx.AsyncClient(timeout=15.0) as client:
        if provider == "gmail":
            response = await client.post(
                GOOGLE_TOKEN_URL,
                data={
                    "refresh_token": stored_refresh_token,
                    "client_id": settings.google_oauth_client_id,
                    "client_secret": settings.google_oauth_client_secret,
                    "grant_type": "refresh_token",
                },
            )
        elif provider == "microsoft":
            response = await client.post(
                MICROSOFT_TOKEN_URL,
                data={
                    "refresh_token": stored_refresh_token,
                    "client_id": settings.microsoft_oauth_client_id,
                    "client_secret": settings.microsoft_oauth_client_secret,
                    "grant_type": "refresh_token",
                    "scope": MICROSOFT_SCOPES,
                },
            )
        else:
            raise ValueError(f"Unknown provider: {provider}")

    if response.status_code != 200:
        raise OAuthError(f"Failed to refresh {provider} token: {response.text}")
    tokens = response.json()
    new_expires_at = (datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3600))).isoformat()
    db.update_calendar_oauth_tokens(
        account_row["user_id"], provider, encrypt_token(tokens["access_token"]), new_expires_at, now_iso()
    )
    return tokens["access_token"]


def _event_datetimes(date: str, time: str) -> tuple[str, str]:
    """`date` is YYYY-MM-DD, `time` is HH:MM (both already validated by
    schemas_calendar.py) — combines them into start/end ISO datetimes (no
    UTC offset; the timezone is passed as a separate field per both APIs'
    own convention) using the fixed team timezone above."""
    start = f"{date}T{time}:00"
    start_dt = datetime.fromisoformat(start)
    end_dt = start_dt + timedelta(minutes=DEFAULT_EVENT_DURATION_MINUTES)
    return start, end_dt.strftime("%Y-%m-%dT%H:%M:%S")


async def push_event_to_calendar(account_row, title: str, description: str, date: str, time: str) -> None:
    """Best-effort one-way push: a CRM calendar event just got created, so
    mirror it into the rep's connected external calendar. Deliberately
    one-way (CRM -> external) — see PROJECT_CONTEXT.md for why inbound sync
    (pulling external events back into the CRM, and reconciling edits made
    on either side) is a separate, not-yet-built piece of this roadmap item."""
    access_token = await refresh_token_if_needed(account_row)
    provider = account_row["provider"]
    start_iso, end_iso = _event_datetimes(date, time)

    async with httpx.AsyncClient(timeout=15.0) as client:
        if provider == "gmail":
            response = await client.post(
                GOOGLE_EVENTS_URL,
                headers={"Authorization": f"Bearer {access_token}"},
                json={
                    "summary": title,
                    "description": description,
                    "start": {"dateTime": start_iso, "timeZone": DEFAULT_TIMEZONE},
                    "end": {"dateTime": end_iso, "timeZone": DEFAULT_TIMEZONE},
                },
            )
        elif provider == "microsoft":
            response = await client.post(
                MICROSOFT_EVENTS_URL,
                headers={"Authorization": f"Bearer {access_token}"},
                json={
                    "subject": title,
                    "body": {"contentType": "Text", "content": description},
                    "start": {"dateTime": start_iso, "timeZone": DEFAULT_TIMEZONE},
                    "end": {"dateTime": end_iso, "timeZone": DEFAULT_TIMEZONE},
                },
            )
        else:
            raise ValueError(f"Unknown provider: {provider}")

    if response.status_code not in (200, 201, 202):
        raise OAuthError(f"Failed to push event to {provider} calendar: {response.text}")
