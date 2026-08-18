/** Generic loading placeholder for card/panel layouts that aren't a table
 * (see components/leadTable.ts's renderSkeletonRows for the table version).
 * Same static `.skeleton-bar` visual language, just stacked directly in any
 * container instead of table rows. */
export function skeletonBlockHtml(lines = 3): string {
  return `<div class="skeleton-block">${Array.from({ length: lines }, () => `<div class="skeleton-bar"></div>`).join("")}</div>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function _formatEmailText(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

/** Render an email body (which may contain a baked-in CTA `<a>` button, **bold**
 * and newlines) to SAFE HTML. Everything is escaped; anchors are rebuilt from
 * scratch with only a scheme-validated href (http/https/mailto) and escaped inner
 * text — arbitrary attributes (onclick, style, javascript: hrefs) are dropped.
 * Shared by the list-campaign and email-writer body renderers (audit H8). */
export function renderEmailBodyHtml(body: string): string {
  const re = /<a\b[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out += _formatEmailText(body.slice(last, m.index));
    const href = m[1].trim();
    const innerText = escapeHtml(m[2].replace(/<[^>]*>/g, ""));
    if (/^(https?:|mailto:)/i.test(href)) {
      out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${innerText}</a>`;
    } else {
      out += innerText; // unsafe/unknown scheme → plain text, no link
    }
    last = re.lastIndex;
  }
  out += _formatEmailText(body.slice(last));
  return out;
}

/** Sanitise an HTML fragment captured from a contenteditable: drop dangerous
 * elements, event-handler attributes, and javascript:/data: URLs. Uses the
 * browser parser (no external library). Defence against pasted markup (audit L6). */
export function sanitizeHtmlFragment(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const BANNED = new Set(["script", "style", "iframe", "object", "embed", "link", "meta", "form"]);
  tpl.content.querySelectorAll("*").forEach((el) => {
    if (BANNED.has(el.tagName.toLowerCase())) {
      el.remove();
      return;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if ((name === "href" || name === "src") && (val.startsWith("javascript:") || val.startsWith("data:"))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}
