"""Free email verification: deliverability (DNS) + person matching.

Two independent questions, answered without any paid service:

1. Can this domain receive mail at all?  MX lookup via dnspython when
   available, falling back to an A-record check (a domain with an A record
   but no MX can still receive mail via its A record per RFC 5321).
   Catches typos and dead companies — the main bounce risk on old lists.

2. Does the address plausibly belong to the named person?  The local part
   is compared against the lead's contact name and the directors from
   Companies House data. Generic inboxes (info@, sales@…) are flagged so
   a "Dear John" email never goes to accounts@.
"""

import asyncio
import json
import logging
import re
import socket
from typing import Optional

logger = logging.getLogger("app.email_verify")

GENERIC_LOCALS = {
    "info", "sales", "hello", "contact", "enquiries", "enquiry", "admin",
    "office", "accounts", "support", "mail", "team", "reception", "hr",
    "finance", "marketing", "help", "service", "services", "general",
    "post", "postmaster", "noreply", "no-reply",
}

try:
    import dns.resolver as _dns_resolver  # type: ignore
except ImportError:  # pragma: no cover — optional dependency
    _dns_resolver = None


def _check_domain_sync(domain: str) -> tuple[str, str]:
    """Returns (status, detail): deliverable | risky | undeliverable."""
    if _dns_resolver is not None:
        try:
            answers = _dns_resolver.resolve(domain, "MX", lifetime=6.0)
            if len(answers):
                return "deliverable", "Domain has a mail server (MX)"
        except _dns_resolver.NXDOMAIN:
            return "undeliverable", "Domain does not exist"
        except _dns_resolver.NoAnswer:
            pass  # fall through to A-record check
        except Exception:
            pass  # DNS hiccup — fall through, don't hard-fail
    try:
        socket.getaddrinfo(domain, 25)
        note = "Domain exists but has no MX record" if _dns_resolver else "Domain resolves (MX not checked)"
        return "risky", note
    except socket.gaierror:
        return "undeliverable", "Domain does not exist"
    except Exception:
        return "risky", "Could not check domain"


def _name_tokens(name: str) -> list[str]:
    return [t for t in re.split(r"[^a-z]+", (name or "").lower()) if len(t) >= 2]


def _local_matches_name(local: str, name: str) -> bool:
    """john.smith@ / jsmith@ / john@ / smithj@ style matches."""
    tokens = _name_tokens(name)
    if not tokens:
        return False
    local_clean = re.sub(r"[^a-z]", "", local.lower())
    first, last = tokens[0], tokens[-1]
    candidates = {
        first, last, first + last, last + first,
        first[0] + last, first + last[0], last + first[0],
    }
    if local_clean in candidates:
        return True
    # Longer names appearing inside the local part (catches j.smith-2@ etc.)
    return any(t in local_clean for t in tokens if len(t) >= 4)


def classify_person(email: str, contact_name: str, directors: list[str]) -> tuple[str, str]:
    """Returns (person_match, detail)."""
    local = email.split("@", 1)[0].lower()
    if re.sub(r"[^a-z]", "", local) in GENERIC_LOCALS:
        return "generic", "Generic company inbox — not a named person"
    if contact_name and _local_matches_name(local, contact_name):
        return "person", f"Matches contact name ({contact_name})"
    for d in directors:
        if _local_matches_name(local, d):
            return "director", f"Matches director ({d})"
    if contact_name or directors:
        return "mismatch", "Doesn't match the contact name or any known director"
    return "unknown", "No contact name or directors on file to compare against"


def directors_from_ch_data(ch_data_json: Optional[str]) -> list[str]:
    if not ch_data_json:
        return []
    try:
        data = json.loads(ch_data_json)
        return [d for d in (data.get("directors") or []) if isinstance(d, str)]
    except Exception:
        return []


async def verify_email(email: str, contact_name: str, directors: list[str]) -> dict:
    """Full verification for one address. DNS runs in a thread so several
    can be checked concurrently without blocking the event loop."""
    domain = email.split("@", 1)[1].lower() if "@" in email else ""
    if not domain:
        return {"status": "undeliverable", "person_match": "unknown", "detail": "Not a valid email address"}

    status, domain_detail = await asyncio.to_thread(_check_domain_sync, domain)
    person_match, person_detail = classify_person(email, contact_name, directors)
    return {
        "status": status,
        "person_match": person_match,
        "detail": f"{domain_detail}. {person_detail}.",
    }
