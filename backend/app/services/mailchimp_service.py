import asyncio
import hashlib
import logging
from datetime import datetime

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


# Mailchimp "text" merge fields hard-cap at 255 characters, so a full email body
# is split across several fields and re-joined (with NO separator) in the campaign
# HTML. The join is lossless because chunk[0] + chunk[1] + ... exactly reconstructs
# the original string before Mailchimp renders it — a mid-word split at a chunk
# boundary reassembles correctly. Five 250-char fields hold ~1,250 chars, well
# above the ~100-word (~700-char) cap the generator enforces incl. signature/link.
_BODY_MERGE_FIELDS = ("EMAILBODY", "EMAILBODY2", "EMAILBODY3", "EMAILBODY4", "EMAILBODY5")
_BODY_CHUNK_SIZE = 250


def _chunk_body(body: str) -> list:
    """Split an email body into one fixed-size chunk per body merge field.

    Always returns exactly len(_BODY_MERGE_FIELDS) items, padded with empty
    strings so every field is written on each upsert — that clears any stale
    value left over from a previous, longer export to the same contact.
    """
    body = body or ""
    chunks = [body[i:i + _BODY_CHUNK_SIZE] for i in range(0, len(body), _BODY_CHUNK_SIZE)]
    return (chunks + [""] * len(_BODY_MERGE_FIELDS))[:len(_BODY_MERGE_FIELDS)]


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


async def _create_static_segment(base: str, api_key: str, audience_id: str, name: str, emails: list[str]) -> int:
    """Creates a static segment holding exactly these contacts. Campaigns are
    scoped to this segment so pressing Send in Mailchimp can never blast the
    whole audience (which may hold tens of thousands of unrelated contacts)."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f"{base}/lists/{audience_id}/segments",
            json={"name": name[:100], "static_segment": emails},
            auth=("anystring", api_key),
        )
    if r.status_code not in (200, 201):
        raise MailchimpError(f"Mailchimp segment create failed ({r.status_code}): {r.text[:200]}")
    return r.json()["id"]


def _mc_error_detail(resp) -> str:
    """Pull Mailchimp's field-specific validation errors into a readable string
    so a 400 says WHICH field failed (e.g. 'settings.reply_to: is not valid')
    instead of an opaque, truncated 'Invalid Resource'."""
    try:
        data = resp.json()
    except Exception:
        return resp.text[:400]
    field_errs = "; ".join(
        f"{e.get('field', '?')}: {e.get('message', '')}" for e in data.get("errors", [])
    )
    return field_errs or data.get("detail", "") or resp.text[:400]


async def export_outreach_campaign(
    campaign_name: str,
    from_name: str,
    from_email: str,
    drafts: list[dict],
) -> dict:
    """Push a batch of personalised outreach drafts to a Mailchimp campaign.

    Each draft must have: contact_email, contact_name, company, subject, body.
    Returns { mailchimp_url, exported, skipped }.

    Mechanism: upserts each contact with EMAILSUBJ + EMAILBODY merge tags,
    puts just those contacts in a static segment, then creates one campaign
    targeting that segment whose subject is *|EMAILSUBJ|* and body is
    *|EMAILBODY|*. Each recipient therefore receives their own fully
    personalised email — and nobody outside the batch can be emailed.
    """
    api_key, audience_id = _require_config()
    base = _base_url(api_key)
    dc = _dc_from_key(api_key)

    await _ensure_merge_field(base, api_key, audience_id, "EMAILSUBJ", "Email Subject", "text")
    for idx, tag in enumerate(_BODY_MERGE_FIELDS):
        await _ensure_merge_field(base, api_key, audience_id, tag, f"Email Body {idx + 1}", "text")

    # Upsert contacts concurrently over a shared connection pool. Mailchimp
    # allows ~10 simultaneous connections per key, so a semaphore of 8 keeps us
    # safely under that while turning ~1,100+ sequential round-trips (which blew
    # past nginx's ~60s upstream timeout → 504) into 8-wide parallelism.
    sem = asyncio.Semaphore(8)

    async def _upsert(client, draft):
        email_addr = (draft.get("contact_email") or "").strip()
        if not email_addr:
            return None
        full_name = (draft.get("contact_name") or "").strip()
        parts = full_name.split(" ", 1)
        first = parts[0] if parts else ""
        last = parts[1] if len(parts) > 1 else ""
        async with sem:
            try:
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
                            **dict(zip(_BODY_MERGE_FIELDS, _chunk_body(draft.get("body") or ""))),
                        },
                    },
                    auth=("anystring", api_key),
                )
            except Exception:
                logger.exception("Mailchimp upsert error for %s", email_addr)
                return None
        if resp.status_code in (200, 201):
            return email_addr
        logger.warning("Mailchimp upsert failed for %s: %s", email_addr, resp.text[:120])
        return None

    async with httpx.AsyncClient(timeout=30.0) as client:
        results = await asyncio.gather(*[_upsert(client, d) for d in drafts])
    exported_emails = [e for e in results if e]
    exported = len(exported_emails)
    skipped = len(drafts) - exported

    if exported == 0:
        raise MailchimpError("No contacts could be added — check that leads have email addresses on file.")

    # Scope the campaign to exactly the exported contacts. If the segment
    # can't be created we fail the export rather than fall back to the whole
    # audience — that fallback would make Send in Mailchimp a mass-mail.
    segment_name = f"{campaign_name} — {datetime.now().strftime('%d %b %Y %H:%M')}"
    segment_id = await _create_static_segment(base, api_key, audience_id, segment_name, exported_emails)

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
        "recipients": {"list_id": audience_id, "segment_opts": {"saved_segment_id": segment_id}},
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(f"{base}/campaigns", json=campaign_payload, auth=("anystring", api_key))
        if r.status_code not in (200, 201):
            raise MailchimpError(f"Campaign create failed ({r.status_code}): {_mc_error_detail(r)}")
        campaign_id = r.json()["id"]
        web_id = r.json().get("web_id", "")

        # *|UNSUB|* and *|LIST:ADDRESS|* are required by Mailchimp/CAN-SPAM/PECR
        # for any regular campaign with custom HTML — Mailchimp does not inject
        # them automatically outside its own template builder. Omitting them
        # previously meant recipients had no opt-out link, which drives up
        # spam-complaint rates and damages sender reputation over time.
        # Re-join the chunked body fields with no separator so Mailchimp
        # reconstructs the full email before rendering (see _chunk_body).
        body_tags = "".join(f"*|{t}|*" for t in _BODY_MERGE_FIELDS)
        html_body = (
            "<html><body style='font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px'>"
            f"{body_tags}"
            "<div style='margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0;"
            "font-size:11px;color:#888888;text-align:center'>"
            "*|LIST:ADDRESS|*<br>"
            "<a href='*|UNSUB|*' style='color:#888888'>Unsubscribe</a>"
            "</div>"
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
    """Exports a win-back campaign with full per-recipient personalisation.

    Uses the same EMAILSUBJ/EMAILBODY merge-tag mechanism as outreach export
    (each contact gets their own AI-written subject and full body — the old
    approach shared one subject and only personalised the first paragraph)
    and the same static-segment scoping, so the draft can only ever send to
    exactly these contacts."""
    drafts = [
        {
            "contact_email": e.get("contact_email") or "",
            "contact_name": e.get("contact_name") or "",
            "company": e.get("company") or "",
            "subject": e.get("subject") or "",
            "body": e.get("body") or "",
        }
        for e in emails
    ]
    result = await export_outreach_campaign(campaign_name, from_name, from_email, drafts)
    return result["mailchimp_url"]
