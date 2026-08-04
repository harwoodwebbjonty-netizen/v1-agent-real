import base64
import html
import re
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

import httpx

from app import db
from app.core.config import get_settings
from app.services.auth_service import new_id, now_iso
from app.services.email_format import html_to_plain_text, markdown_bold_to_html

# Win-back bodies are plain text by default; apply_campaign_link() (in
# win_back_email_service.py) may deterministically insert a single <a href>
# tag. Detecting it here — rather than threading an is_html flag through
# every caller of send_email() — keeps the body text as the single source
# of truth for whether HTML rendering is needed.
HTML_ANCHOR_RE = re.compile(r'<a\s+href="[^"]*"[^>]*>.*?</a>', re.IGNORECASE | re.DOTALL)


def _build_html_alternative(body: str) -> str:
    """Escapes everything except the anchor tag(s) already embedded in the
    body, converts newlines to <br> so line breaks survive as HTML, and turns
    markdown **bold** markers into <strong> (done after escaping so the tag is
    real HTML, not escaped text)."""
    parts = HTML_ANCHOR_RE.split(body)
    anchors = HTML_ANCHOR_RE.findall(body)
    chunks = []
    for i, part in enumerate(parts):
        chunks.append(html.escape(part).replace("\n", "<br>"))
        if i < len(anchors):
            chunks.append(anchors[i])
    return markdown_bold_to_html("".join(chunks))

# Isolated from the Anthropic-based AI services — this module never touches
# the `anthropic` SDK. OAuth consent always happens in the system browser
# (never an embedded webview), per Google/Microsoft's own requirements.

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
GOOGLE_SCOPES = "https://www.googleapis.com/auth/gmail.send openid email"

MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
MICROSOFT_USERINFO_URL = "https://graph.microsoft.com/v1.0/me"
MICROSOFT_SCOPES = "https://graph.microsoft.com/Mail.Send offline_access openid email"

PROVIDERS = ("gmail", "microsoft")


class OAuthNotConfiguredError(Exception):
    """Raised when the relevant Client ID/Secret haven't been set in .env yet."""


class OAuthError(Exception):
    """Raised on any failed exchange/refresh/send call to Google or Microsoft."""


def _redirect_uri(provider: str) -> str:
    return f"{get_settings().oauth_redirect_base_url}/email-oauth/{provider}/callback"


def get_authorization_url(provider: str, user_id: str) -> str:
    settings = get_settings()
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
                "state": user_id,
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
                "state": user_id,
            }
        )
        return f"{MICROSOFT_AUTH_URL}?{params}"
    raise ValueError(f"Unknown provider: {provider}")


async def handle_oauth_callback(provider: str, code: str, state: str) -> None:
    """`state` is the id of the user who started the flow. Exchanges the
    code for tokens, fetches the connected email address, and stores the
    account (one row per user+provider, upserted)."""
    settings = get_settings()
    user_id = state

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
            userinfo = userinfo_response.json()
            email_address = userinfo.get("mail") or userinfo.get("userPrincipalName", "")
        else:
            raise ValueError(f"Unknown provider: {provider}")

    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3600))).isoformat()
    db.upsert_email_oauth_account(
        new_id(),
        user_id,
        provider,
        email_address,
        tokens["access_token"],
        tokens.get("refresh_token", ""),
        expires_at,
        now_iso(),
    )


async def refresh_token_if_needed(account_row) -> str:
    expires_at = datetime.fromisoformat(account_row["token_expires_at"])
    if datetime.now(timezone.utc) < expires_at:
        return account_row["access_token"]

    settings = get_settings()
    provider = account_row["provider"]
    async with httpx.AsyncClient(timeout=15.0) as client:
        if provider == "gmail":
            response = await client.post(
                GOOGLE_TOKEN_URL,
                data={
                    "refresh_token": account_row["refresh_token"],
                    "client_id": settings.google_oauth_client_id,
                    "client_secret": settings.google_oauth_client_secret,
                    "grant_type": "refresh_token",
                },
            )
        elif provider == "microsoft":
            response = await client.post(
                MICROSOFT_TOKEN_URL,
                data={
                    "refresh_token": account_row["refresh_token"],
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
    db.update_email_oauth_tokens(account_row["user_id"], provider, tokens["access_token"], new_expires_at, now_iso())
    return tokens["access_token"]


async def send_email(
    account_row, to: str, subject: str, body: str, footer_html: str = "", footer_text: str = ""
) -> None:
    """Send an email via the connected Gmail/Outlook account. `footer_html` /
    `footer_text` are optional branded-footer blocks appended by the win-back
    sender only — other callers (email writer, sequences) leave them empty so no
    footer is added."""
    access_token = await refresh_token_if_needed(account_row)
    provider = account_row["provider"]

    async with httpx.AsyncClient(timeout=15.0) as client:
        if provider == "gmail":
            message = EmailMessage()
            message["To"] = to
            message["From"] = account_row["email_address"]
            message["Subject"] = subject
            message.set_content(html_to_plain_text(body) + footer_text)
            if footer_html or HTML_ANCHOR_RE.search(body) or "**" in body:
                message.add_alternative(_build_html_alternative(body) + footer_html, subtype="html")
            raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
            response = await client.post(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                headers={"Authorization": f"Bearer {access_token}"},
                json={"raw": raw},
            )
        elif provider == "microsoft":
            response = await client.post(
                "https://graph.microsoft.com/v1.0/me/sendMail",
                headers={"Authorization": f"Bearer {access_token}"},
                json={
                    "message": {
                        "subject": subject,
                        "body": {"contentType": "HTML", "content": markdown_bold_to_html(body) + footer_html},
                        "toRecipients": [{"emailAddress": {"address": to}}],
                    }
                },
            )
        else:
            raise ValueError(f"Unknown provider: {provider}")

    if response.status_code not in (200, 202):
        raise OAuthError(f"Failed to send via {provider}: {response.text}")
