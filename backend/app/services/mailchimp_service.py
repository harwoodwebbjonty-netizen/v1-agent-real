import hashlib
import logging

import httpx

from app.core.config import get_settings

logger = logging.getLogger("app.mailchimp")


class MailchimpNotConfiguredError(Exception):
    """Raised when MAILCHIMP_API_KEY or MAILCHIMP_AUDIENCE_ID are not set."""


class MailchimpError(Exception):
    """Raised on any failed Mailchimp API call."""


def _settings():
    return get_settings()


def _dc_from_key(api_key: str) -> str:
    """Extracts the data-centre prefix from a Mailchimp API key (e.g. 'us21')."""
    return api_key.rsplit("-", 1)[-1] if "-" in api_key else "us1"


def _base_url(api_key: str) -> str:
    dc = _dc_from_key(api_key)
    return f"https://{dc}.api.mailchimp.com/3.0"


def _email_hash(email: str) -> str:
    return hashlib.md5(email.lower().encode()).hexdigest()


def _require_config() -> tuple[str, str]:
    s = _settings()
    api_key = getattr(s, "mailchimp_api_key", "") or ""
    audience_id = getattr(s, "mailchimp_audience_id", "") or ""
    if not api_key or not audience_id:
        raise MailchimpNotConfiguredError(
            "MAILCHIMP_API_KEY and MAILCHIMP_AUDIENCE_ID must be set in backend/.env to use Mailchimp export."
        )
    return api_key, audience_id


async def upsert_contact(
    email: str,
    first_name: str,
    last_name: str,
    company: str,
    winback_hook: str,
) -> None:
    """Upserts a contact in the Mailchimp audience with win-back merge tags."""
    api_key, audience_id = _require_config()
    base = _base_url(api_key)
    url = f"{base}/lists/{audience_id}/members/{_email_hash(email)}"
    payload = {
        "email_address": email,
        "status_if_new": "subscribed",
        "merge_fields": {
            "FNAME": first_name,
            "LNAME": last_name,
            "COMPANY": company,
            "WINBHOOK": winback_hook[:250],
        },
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.put(url, json=payload, auth=("anystring", api_key))
    if response.status_code not in (200, 201):
        raise MailchimpError(f"Mailchimp upsert failed ({response.status_code}): {response.text[:200]}")


async def create_campaign_draft(
    name: str,
    from_name: str,
    from_email: str,
    subject_line: str,
) -> str:
    """Creates a Mailchimp campaign draft and returns its web app URL."""
    api_key, audience_id = _require_config()
    base = _base_url(api_key)

    campaign_payload = {
        "type": "regular",
        "settings": {
            "subject_line": subject_line,
            "from_name": from_name,
            "reply_to": from_email,
            "title": name,
        },
        "recipients": {"list_id": audience_id},
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            f"{base}/campaigns", json=campaign_payload, auth=("anystring", api_key)
        )
        if not response.status_code == 200 and response.status_code not in (200, 201):
            raise MailchimpError(f"Mailchimp campaign create failed ({response.status_code}): {response.text[:200]}")

        campaign_data = response.json()
        campaign_id = campaign_data.get("id", "")
        campaign_web_id = campaign_data.get("web_id", "")

        html_body = (
            "<html><body>"
            "<p>Hi *|FNAME|*,</p>"
            "<p>*|WINBHOOK|*</p>"
            "</body></html>"
        )
        content_response = await client.put(
            f"{base}/campaigns/{campaign_id}/content",
            json={"html": html_body},
            auth=("anystring", api_key),
        )
        if content_response.status_code not in (200, 201):
            logger.warning("Mailchimp content set failed: %s", content_response.text[:200])

    dc = _dc_from_key(api_key)
    return f"https://{dc}.admin.mailchimp.com/campaigns/edit?id={campaign_web_id}"


def _text_to_html(text: str) -> str:
    """Convert plain-text email body to basic HTML paragraphs."""
    import html as _html
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    return "".join(f"<p>{_html.escape(p).replace(chr(10), '<br>')}</p>" for p in paragraphs)


async def _ensure_merge_field(base: str, api_key: str, audience_id: str, tag: str, name: str, field_type: str) -> None:
    """Create a merge field if it doesn't already exist."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(f"{base}/lists/{audience_id}/merge-fields", auth=("anystring", api_key))
        existing = {f["tag"]: f for f in r.json().get("merge_fields", [])} if r.status_code == 200 else {}
        if tag not in existing:
            await client.post(
                f"{base}/lists/{audience_id}/merge-fields",
                json={"tag": tag, "name": name, "type": field_type},
                auth=("anystring", api_key),
            )


async def export_outreach_campaign(
    campaign_name: str,
    from_name: str,
    from_email: str,
    drafts: list[dict],
) -> dict:
    """Push a batch of personalised outreach drafts to a Mailchimp campaign.

    Each draft must have: contact_email, contact_name, company, subject, body.
    Returns { mailchimp_url, exported, skipped }.

    Mechanism: upserts each contact with EMAILSUBJ + EMAILBODY merge tags, then
    creates one campaign whose subject is *|EMAILSUBJ|* and body is *|EMAILBODY|*.
    Each recipient therefore receives their own fully personalised email.
    """
    api_key, audience_id = _require_config()
    base = _base_url(api_key)
    dc = _dc_from_key(api_key)

    await _ensure_merge_field(base, api_key, audience_id, "EMAILSUBJ", "Email Subject", "text")
    await _ensure_merge_field(base, api_key, audience_id, "EMAILBODY", "Email Body", "text")

    exported = 0
    skipped = 0
    for draft in drafts:
        email_addr = (draft.get("contact_email") or "").strip()
        if not email_addr:
            skipped += 1
            continue
        full_name = (draft.get("contact_name") or "").strip()
        parts = full_name.split(" ", 1)
        first = parts[0] if parts else ""
        last = parts[1] if len(parts) > 1 else ""
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.put(
                    f"{base}/lists/{audience_id}/members/{_email_hash(email_addr)}",
                    json={
                        "email_address": email_addr,
                        "status_if_new": "subscribed",
                        "merge_fields": {
                            "FNAME": first,
                            "LNAME": last,
                            "COMPANY": draft.get("company") or "",
                            "EMAILSUBJ": (draft.get("subject") or "")[:255],
                            "EMAILBODY": draft.get("body") or "",
                        },
                    },
                    auth=("anystring", api_key),
                )
            if resp.status_code in (200, 201):
                exported += 1
            else:
                logger.warning("Mailchimp upsert failed for %s: %s", email_addr, resp.text[:120])
                skipped += 1
        except Exception:
            logger.exception("Mailchimp upsert error for %s", email_addr)
            skipped += 1

    if exported == 0:
        raise MailchimpError("No contacts could be added — check that leads have email addresses on file.")

    # Campaign: subject uses the EMAILSUBJ merge tag so each recipient sees
    # their own subject line (requires Mailchimp Essentials plan or higher).
    campaign_payload = {
        "type": "regular",
        "settings": {
            "subject_line": "*|EMAILSUBJ|*",
            "from_name": from_name,
            "reply_to": from_email,
            "title": campaign_name,
        },
        "recipients": {"list_id": audience_id},
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(f"{base}/campaigns", json=campaign_payload, auth=("anystring", api_key))
        if r.status_code not in (200, 201):
            raise MailchimpError(f"Campaign create failed ({r.status_code}): {r.text[:200]}")
        campaign_id = r.json()["id"]
        web_id = r.json().get("web_id", "")

        html_body = (
            "<html><body style='font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px'>"
            "*|EMAILBODY|*"
            "</body></html>"
        )
        await client.put(
            f"{base}/campaigns/{campaign_id}/content",
            json={"html": html_body},
            auth=("anystring", api_key),
        )

    mailchimp_url = f"https://{dc}.admin.mailchimp.com/campaigns/edit?id={web_id}"
    return {"mailchimp_url": mailchimp_url, "exported": exported, "skipped": skipped}


async def export_win_back_campaign(
    campaign_name: str,
    from_name: str,
    from_email: str,
    emails: list[dict],
) -> str:
    """Upserts all contacts, creates a campaign draft, returns the Mailchimp URL.

    Each dict in emails must have: email, first_name, last_name, company, body (full email body).
    The first paragraph of each email body is used as the personalised hook merge tag.
    """
    for entry in emails:
        email_addr = entry.get("contact_email") or ""
        if not email_addr:
            continue
        body = entry.get("body") or ""
        hook = body.split("\n\n")[0].strip() if body else ""
        parts = (entry.get("contact_name") or "").split(" ", 1)
        first = parts[0] if parts else ""
        last = parts[1] if len(parts) > 1 else ""
        try:
            await upsert_contact(
                email=email_addr,
                first_name=first,
                last_name=last,
                company=entry.get("company") or "",
                winback_hook=hook,
            )
        except MailchimpError as exc:
            logger.warning("Mailchimp upsert skipped for %s: %s", email_addr, exc)

    subject_line = emails[0].get("subject") or "Re: staying in touch" if emails else "Win-back campaign"
    return await create_campaign_draft(
        name=campaign_name,
        from_name=from_name,
        from_email=from_email,
        subject_line=subject_line,
    )
