import type { Lead } from "../api";
import { CONTACT_STATUS_ORDER } from "../constants";
import { copyToClipboard } from "../contact";
import { normalizeSicIndustry } from "../sic";
import { escapeHtml } from "../utils";

export type SortColumn = "company" | "phone_number" | "status" | "industry" | "contact_status" | "lead_score" | null;
export type SortDirection = "asc" | "desc";

function compareLeads(a: Lead, b: Lead, col: SortColumn): number {
  if (!col) return 0;
  if (col === "contact_status") {
    return CONTACT_STATUS_ORDER.indexOf(a.contact_status) - CONTACT_STATUS_ORDER.indexOf(b.contact_status);
  }
  if (col === "lead_score") {
    return (b.intelligence?.lead_score ?? 0) - (a.intelligence?.lead_score ?? 0);
  }
  if (col === "phone_number") {
    // Leads WITH a phone number sort first (asc = has phone, desc = no phone first)
    const aHas = !!(a.phone_number && a.phone_number !== "not_found") ? 1 : 0;
    const bHas = !!(b.phone_number && b.phone_number !== "not_found") ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas; // has-phone first
    return a.phone_number.localeCompare(b.phone_number);
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
 * plus an optional exact status filter (dashboard stat cards), an optional
 * minimum contact-status rank (Analytics funnel), an optional CH charges filter,
 * and an optional charge-type filter (OR within selection). */
export function filterLeads(
  leads: Lead[],
  search: string,
  selectedIndustries: Set<string>,
  statusFilter: Lead["status"] | null = null,
  contactStatusMinRank: number | null = null,
  hasChargesFilter = false,
  selectedChargeTypes: Set<string> = new Set()
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
    if (hasChargesFilter || selectedChargeTypes.size > 0) {
      try {
        const chData = JSON.parse(lead.ch_data || "{}");
        const charges: Array<{ classification?: string }> = chData.charges || [];
        if (selectedChargeTypes.size > 0) {
          const hasMatch = charges.some((c) => selectedChargeTypes.has((c.classification || "").trim()));
          if (!hasMatch) return false;
        } else if ((chData.charges_total ?? 0) === 0) {
          return false;
        }
      } catch {
        return false;
      }
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
  /** Cold-call-list tables only: a dedicated "Called" checkbox distinct from contact status. */
  onToggleCalled?: (lead: Lead) => void;
  /** Reduce-clicks: jump straight to drafting an email for this lead without opening the side panel first. */
  onGenerateEmail?: (lead: Lead) => void;
  /** Look up phone number for a lead that doesn't have one yet. */
  onLookupPhone?: (lead: Lead) => void;
  /** Dashboard only: opens the activity modal for this lead. Renders a pulsing dot column on the left. */
  onActivityClick?: (lead: Lead) => void;
  /** Bulk selection: toggling a row's checkbox. Caller owns the selectedIds set. shiftKey enables range select. */
  onToggleSelect?: (lead: Lead, selected: boolean, shiftKey: boolean) => void;
  /** Set to false in contexts (cold call lists) where the List column is redundant. Default true. */
  showListColumn?: boolean;
  /** Call-sheet mode: inline editable notes column. Saves on blur/Enter without re-rendering the table. */
  onSaveNotes?: (lead: Lead, notes: string) => Promise<void>;
}

const COLUMN_COUNT = 8;

export function renderRows(tbody: HTMLTableSectionElement, leads: Lead[], handlers: RowHandlers, selectedIds?: Set<string>): void {
  tbody.innerHTML = "";
  for (const lead of leads) {
    const isSelected = selectedIds?.has(lead.id) ?? false;
    const row = document.createElement("tr");
    row.dataset.leadId = lead.id;
    row.className = `lead-row${lead.called_at ? " lead-row-called" : ""}${isSelected ? " lead-row-selected" : ""}`;
    row.innerHTML = `
      ${
        handlers.onToggleSelect
          ? `<td class="select-cell">
               <input type="checkbox" class="select-cb" ${isSelected ? "checked" : ""} title="Select row" />
             </td>`
          : ""
      }
      ${
        handlers.onActivityClick
          ? `<td class="activity-col">
               <span class="activity-dot pulse-none" data-lead-id="${lead.id}" title="View recent company activity"></span>
             </td>`
          : ""
      }
      ${
        handlers.onToggleCalled
          ? `<td class="called-cell">
               <input type="checkbox" class="called-cb" ${lead.called_at ? "checked" : ""} title="Mark as called" />
             </td>`
          : ""
      }
      ${
        handlers.onToggleContacted
          ? `<td class="contacted-cell">
               <button class="contacted-toggle ${lead.contact_status !== "New" ? "is-contacted" : ""}" type="button"
                 title="${lead.contact_status !== "New" ? "Contacted — click to reset" : "Mark as contacted"}"></button>
             </td>`
          : ""
      }
      <td>
        <div>${escapeHtml(lead.company)}</div>
        ${(() => {
          try {
            const dirs: string[] = JSON.parse(lead.ch_data || "{}").directors || [];
            return dirs.length > 0 ? `<div class="lead-directors">${escapeHtml(dirs.slice(0, 3).join(", "))}</div>` : "";
          } catch { return ""; }
        })()}
      </td>
      <td>
        <div class="contact-cell">
          ${
            lead.phone_number && lead.phone_number !== "not_found"
              ? `<span>${escapeHtml(lead.phone_number)}</span>
                 <a class="icon-btn" href="tel:${escapeHtml(lead.phone_number)}" title="Call">📞</a>
                 <button class="icon-btn copy-phone-btn" type="button" title="Copy">⧉</button>`
              : handlers.onLookupPhone
                ? `<button class="icon-btn lookup-phone-btn" type="button" title="Look up phone number">🔍</button>`
                : `<span class="empty-hint">—</span>`
          }
        </div>
      </td>

      <td><span class="status-badge ${lead.status}">${lead.status.replace("_", " ")}</span></td>
      <td class="editable-cell">
        <input type="text" class="inline-edit industry-input" value="${escapeHtml(normalizeSicIndustry(lead.industry))}" placeholder="Uncategorized" />
      </td>
      <td class="editable-cell">
        <select class="inline-edit contact-status-select">
          ${CONTACT_STATUS_ORDER.map(
            (s) => `<option value="${s}" ${s === lead.contact_status ? "selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </td>
      <td>
        <div class="contact-cell">
          ${
            lead.emails.length > 0
              ? `<span class="status-badge unverified">✉ ${lead.emails.length}</span>`
              : `<span class="empty-hint">—</span>`
          }
          ${handlers.onGenerateEmail ? `<button class="icon-btn generate-email-btn" type="button" title="Generate Email">📧</button>` : ""}
        </div>
      </td>
      ${handlers.showListColumn !== false ? `<td>${lead.list_name ? `<span class="status-badge list-badge">${escapeHtml(lead.list_name)}</span>` : ""}</td>` : ""}
      ${handlers.onSaveNotes !== undefined
        ? `<td class="notes-cell"><textarea class="notes-textarea" rows="1" placeholder="Add note…">${escapeHtml(lead.notes || "")}</textarea></td>`
        : ""}
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

    const lookupPhoneBtn = row.querySelector<HTMLButtonElement>(".lookup-phone-btn");
    lookupPhoneBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      lookupPhoneBtn.textContent = "⏳";
      lookupPhoneBtn.disabled = true;
      handlers.onLookupPhone!(lead);
    });

    const selectCb = row.querySelector<HTMLInputElement>(".select-cb");
    selectCb?.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onToggleSelect!(lead, selectCb.checked, (event as MouseEvent).shiftKey);
    });

    const calledCb = row.querySelector<HTMLInputElement>(".called-cb");
    calledCb?.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onToggleCalled!(lead);
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

    const activityDot = row.querySelector<HTMLElement>(".activity-dot");
    activityDot?.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onActivityClick!(lead);
    });

    const notesTextarea = row.querySelector<HTMLTextAreaElement>(".notes-textarea");
    if (notesTextarea && handlers.onSaveNotes) {
      const originalNotes = lead.notes || "";
      notesTextarea.addEventListener("click", (e) => e.stopPropagation());
      notesTextarea.addEventListener("focus", () => {
        notesTextarea.style.height = "auto";
        notesTextarea.style.height = Math.max(notesTextarea.scrollHeight, 60) + "px";
        notesTextarea.style.overflow = "auto";
      });
      notesTextarea.addEventListener("blur", () => {
        notesTextarea.style.height = "28px";
        notesTextarea.style.overflow = "hidden";
        const val = notesTextarea.value;
        if (val !== originalNotes) void handlers.onSaveNotes!(lead, val);
      });
      notesTextarea.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); notesTextarea.blur(); }
        if (e.key === "Escape") { notesTextarea.value = originalNotes; notesTextarea.blur(); }
      });
    }

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
