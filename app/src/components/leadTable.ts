import type { Lead } from "../api";
import { CONTACT_STATUS_ORDER } from "../constants";
import { copyToClipboard } from "../contact";
import { escapeHtml } from "../utils";

export type SortColumn = "company" | "phone_number" | "status" | "industry" | "contact_status" | null;
export type SortDirection = "asc" | "desc";

function compareLeads(a: Lead, b: Lead, col: SortColumn): number {
  if (!col) return 0;
  if (col === "contact_status") {
    return CONTACT_STATUS_ORDER.indexOf(a.contact_status) - CONTACT_STATUS_ORDER.indexOf(b.contact_status);
  }
  return String(a[col]).localeCompare(String(b[col]));
}

/** Stable sort: equal-valued rows keep their existing relative order. */
export function sortLeadsStable(leads: Lead[], col: SortColumn, dir: SortDirection): Lead[] {
  const indexed = leads.map((lead, idx) => ({ lead, idx }));
  indexed.sort((x, y) => {
    const cmp = compareLeads(x.lead, y.lead, col) * (dir === "asc" ? 1 : -1);
    return cmp !== 0 ? cmp : x.idx - y.idx;
  });
  return indexed.map((x) => x.lead);
}

/** Industry filter (OR within selection) AND search (substring across company/phone/notes/industry),
 * plus an optional exact status filter (dashboard stat cards) and an optional
 * minimum contact-status rank (Analytics funnel — cumulative, same semantics
 * as the funnel's own counts: a lead matches if it's at or beyond that stage). */
export function filterLeads(
  leads: Lead[],
  search: string,
  selectedIndustries: Set<string>,
  statusFilter: Lead["status"] | null = null,
  contactStatusMinRank: number | null = null
): Lead[] {
  const q = search.trim().toLowerCase();
  return leads.filter((lead) => {
    if (statusFilter && lead.status !== statusFilter) return false;
    if (contactStatusMinRank !== null && CONTACT_STATUS_ORDER.indexOf(lead.contact_status) < contactStatusMinRank) {
      return false;
    }
    if (selectedIndustries.size > 0) {
      const industry = lead.industry || "Uncategorized";
      if (!selectedIndustries.has(industry)) return false;
    }
    if (q.length === 0) return true;
    return (
      lead.company.toLowerCase().includes(q) ||
      lead.phone_number.toLowerCase().includes(q) ||
      lead.notes.toLowerCase().includes(q) ||
      (lead.industry || "").toLowerCase().includes(q)
    );
  });
}

export interface RowHandlers {
  onRowClick: (lead: Lead) => void;
  onIndustryChange: (lead: Lead, value: string) => void;
  onContactStatusChange: (lead: Lead, value: string) => void;
  /** Cold-call-list tables only: prepends a contacted/uncontacted toggle circle. */
  onToggleContacted?: (lead: Lead) => void;
  /** Reduce-clicks: jump straight to drafting an email for this lead without opening the side panel first. */
  onGenerateEmail?: (lead: Lead) => void;
}

const COLUMN_COUNT = 7;

export function renderRows(tbody: HTMLTableSectionElement, leads: Lead[], handlers: RowHandlers): void {
  tbody.innerHTML = "";
  for (const lead of leads) {
    const row = document.createElement("tr");
    row.dataset.leadId = lead.id;
    row.className = "lead-row";
    row.innerHTML = `
      ${
        handlers.onToggleContacted
          ? `<td class="contacted-cell">
               <button class="contacted-toggle ${lead.contact_status !== "New" ? "is-contacted" : ""}" type="button"
                 title="${lead.contact_status !== "New" ? "Contacted — click to reset" : "Mark as contacted"}"></button>
             </td>`
          : ""
      }
      <td>${escapeHtml(lead.company)}</td>
      <td class="contact-cell">
        ${
          lead.phone_number && lead.phone_number !== "not_found"
            ? `<span>${escapeHtml(lead.phone_number)}</span>
               <a class="icon-btn" href="tel:${escapeHtml(lead.phone_number)}" title="Call">📞</a>
               <button class="icon-btn copy-phone-btn" type="button" title="Copy">⧉</button>`
            : `<span class="empty-hint">—</span>`
        }
      </td>
      <td>${lead.source_url ? `<a href="${escapeHtml(lead.source_url)}" target="_blank">${escapeHtml(lead.source_url)}</a>` : ""}</td>
      <td><span class="status-badge ${lead.status}">${lead.status.replace("_", " ")}</span></td>
      <td class="editable-cell">
        <input type="text" class="inline-edit industry-input" value="${escapeHtml(lead.industry)}" placeholder="Uncategorized" />
      </td>
      <td class="editable-cell">
        <select class="inline-edit contact-status-select">
          ${CONTACT_STATUS_ORDER.map(
            (s) => `<option value="${s}" ${s === lead.contact_status ? "selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </td>
      <td class="contact-cell">
        ${
          lead.emails.length > 0
            ? `<span class="status-badge unverified">✉ ${lead.emails.length}</span>`
            : `<span class="empty-hint">—</span>`
        }
        ${handlers.onGenerateEmail ? `<button class="icon-btn generate-email-btn" type="button" title="Generate Email">📧</button>` : ""}
      </td>
    `;
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest(".inline-edit, .icon-btn")) return;
      handlers.onRowClick(lead);
    });
    const industryInput = row.querySelector<HTMLInputElement>(".industry-input")!;
    industryInput.addEventListener("click", (event) => event.stopPropagation());
    industryInput.addEventListener("change", () => handlers.onIndustryChange(lead, industryInput.value));

    const statusSelect = row.querySelector<HTMLSelectElement>(".contact-status-select")!;
    statusSelect.addEventListener("click", (event) => event.stopPropagation());
    statusSelect.addEventListener("change", () => handlers.onContactStatusChange(lead, statusSelect.value));

    const callLink = row.querySelector<HTMLAnchorElement>(".icon-btn[href]");
    callLink?.addEventListener("click", (event) => event.stopPropagation());

    const copyBtn = row.querySelector<HTMLButtonElement>(".copy-phone-btn");
    copyBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      void copyToClipboard(lead.phone_number);
    });

    const toggleBtn = row.querySelector<HTMLButtonElement>(".contacted-toggle");
    toggleBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onToggleContacted!(lead);
    });

    const generateEmailBtn = row.querySelector<HTMLButtonElement>(".generate-email-btn");
    generateEmailBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onGenerateEmail!(lead);
    });

    tbody.appendChild(row);
  }
}

export function renderSkeletonRows(tbody: HTMLTableSectionElement, count: number, columnCount = COLUMN_COUNT): void {
  tbody.innerHTML = Array.from({ length: count })
    .map(
      () => `<tr class="skeleton-row"><td colspan="${columnCount}"><div class="skeleton-bar"></div></td></tr>`
    )
    .join("");
}

export function renderEmptyState(tbody: HTMLTableSectionElement, message: string, columnCount = COLUMN_COUNT): void {
  tbody.innerHTML = `<tr><td colspan="${columnCount}" class="empty-state">${escapeHtml(message)}</td></tr>`;
}
