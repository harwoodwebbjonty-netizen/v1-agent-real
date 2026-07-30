import re

# Shared inline-formatting helpers for outbound email bodies.
#
# Win-back bodies mark an approved offer/deal with markdown **bold** (chosen so
# the operator's in-app preview shows a readable "**£250k at 6.9%**" rather than
# raw HTML tags). Each send path converts that marker to what its channel needs:
# <strong> for HTML-capable clients (Gmail HTML alternative, Outlook, Mailchimp)
# and plain words for the text/plain fallback. Kept in one place so every channel
# stays consistent, and a no-op on any body that contains no ** markers.

_BOLD_MD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)


def markdown_bold_to_html(text: str) -> str:
    """Convert **bold** spans to <strong>…</strong> for HTML rendering, then drop
    any leftover unmatched ** so a stray marker (e.g. left by length trimming) is
    never shipped as literal text."""
    text = _BOLD_MD_RE.sub(r"<strong>\1</strong>", text or "")
    return text.replace("**", "")


def strip_markdown_bold(text: str) -> str:
    """Remove **bold** markers for plain-text rendering, keeping the words."""
    return (text or "").replace("**", "")
