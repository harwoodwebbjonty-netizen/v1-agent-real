import html
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


# --- CTA button -------------------------------------------------------------
# A "bulletproof" email button: an inline-styled <a> with NO wrapping div, so
# the Gmail HTML-alternative builder's anchor-preserving regex keeps it intact,
# and it survives the Mailchimp 250-char chunk/re-join unchanged. apply_campaign_link
# bakes this into the stored body, so it reaches every send path (Mailchimp
# export, Gmail, Outlook) with no per-path wiring. Rendered as a black pill.
_ANCHOR_RE = re.compile(r'<a\s+href="([^"]*)"[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)

DEFAULT_CTA_LABEL = "Book a free business review"


def render_cta_button(url: str, label: str = "") -> str:
    """Render the campaign link as a black rounded call-to-action button."""
    label = (label or "").strip() or DEFAULT_CTA_LABEL
    url = (url or "").strip()
    return (
        f'<a href="{url}" style="display:inline-block;background-color:#151826;'
        "color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;"
        "font-weight:bold;text-decoration:none;padding:13px 30px;border-radius:28px;"
        f'">{html.escape(label)}</a>'
    )


def html_to_plain_text(text: str) -> str:
    """Plain-text fallback for the text/plain MIME part: turn
    <a href="url">label</a> into 'label: url' and drop bold markers, so the
    plain part never shows a raw anchor/button tag."""
    text = _ANCHOR_RE.sub(lambda m: f"{m.group(2)}: {m.group(1)}", text or "")
    return strip_markdown_bold(text)


# --- Win-back email footer --------------------------------------------------
# Static branded footer shown at the bottom of EVERY win-back campaign email, on
# all send paths. Text/CSS by default so it renders in every mail client with NO
# image hosting needed. FILL THE VALUES BELOW with the real Winchester links to
# switch them on (a blank value is simply omitted). To use the real logo /
# Trustpilot images instead of the text versions, host each at a public HTTPS URL
# and set FOOTER_LOGO_IMG_URL / FOOTER_TRUSTPILOT_IMG_URL.
FOOTER_WEBSITE_URL = ""          # e.g. "https://www.winchestercf.co.uk"
FOOTER_LINKEDIN_URL = ""         # e.g. "https://www.linkedin.com/company/winchester-corporate-finance"
FOOTER_CONTACT_EMAIL = ""        # e.g. "info@winchestercf.co.uk"
FOOTER_LOGO_IMG_URL = ""         # optional: hosted logo image (HTTPS)
FOOTER_TRUSTPILOT_IMG_URL = ""   # optional: hosted Trustpilot badge image (HTTPS)
FOOTER_TRUSTPILOT_REVIEWS = "34+"

_INK = "#151826"
_MUTED = "#6b7280"
_ACCENT = "#4F6BFF"
_TRUSTPILOT_GREEN = "#00b67a"


def _footer_social_links() -> list:
    links = []
    if FOOTER_CONTACT_EMAIL:
        links.append((f"mailto:{FOOTER_CONTACT_EMAIL}", "Email"))
    if FOOTER_LINKEDIN_URL:
        links.append((FOOTER_LINKEDIN_URL, "LinkedIn"))
    if FOOTER_WEBSITE_URL:
        links.append((FOOTER_WEBSITE_URL, "Website"))
    return links


def build_win_back_footer_html() -> str:
    """The branded footer block as inline-styled HTML (safe to append after any
    body-level HTML escaping — it is emitted as real markup, never escaped)."""
    if FOOTER_LOGO_IMG_URL:
        brand = (
            f'<img src="{FOOTER_LOGO_IMG_URL}" alt="Winchester Corporate Finance" '
            'width="210" style="max-width:210px;height:auto;border:0;display:inline-block;" />'
        )
    else:
        brand = (
            f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:19px;'
            f'font-weight:bold;letter-spacing:2px;color:{_INK};">WINCHESTER</div>'
            f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;'
            f'letter-spacing:4px;color:{_MUTED};margin-top:2px;">CORPORATE FINANCE</div>'
        )

    if FOOTER_TRUSTPILOT_IMG_URL:
        trustpilot = (
            f'<img src="{FOOTER_TRUSTPILOT_IMG_URL}" alt="Excellent on Trustpilot" '
            'height="42" style="height:42px;border:0;display:inline-block;" />'
        )
    else:
        trustpilot = (
            f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;'
            f'color:{_TRUSTPILOT_GREEN};font-weight:bold;">'
            f'&#9733;&#9733;&#9733;&#9733;&#9733; &nbsp;Excellent on Trustpilot &middot; '
            f'{html.escape(FOOTER_TRUSTPILOT_REVIEWS)} reviews</div>'
        )

    social = ""
    links = _footer_social_links()
    if links:
        rendered = " &nbsp;&middot;&nbsp; ".join(
            f'<a href="{url}" style="color:{_ACCENT};text-decoration:none;">{label}</a>'
            for url, label in links
        )
        social = (
            '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;'
            f'margin-top:14px;">{rendered}</div>'
        )

    return (
        '<div style="margin-top:36px;padding-top:22px;border-top:1px solid #e5e7eb;'
        'text-align:center;">'
        f"{brand}"
        f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;'
        f'font-weight:bold;color:{_INK};margin-top:14px;">Built for growth.</div>'
        f'<div style="margin-top:14px;">{trustpilot}</div>'
        f"{social}"
        "</div>"
    )


def build_win_back_footer_text() -> str:
    """Plain-text version of the footer for the text/plain MIME part."""
    lines = ["", "—", "Winchester Corporate Finance", "Built for growth.",
             f"Excellent on Trustpilot · {FOOTER_TRUSTPILOT_REVIEWS} reviews"]
    social = [f"{label}: {url}" for url, label in _footer_social_links()]
    if social:
        lines.append("  ·  ".join(social))
    return "\n".join(lines)
