import { open } from "@tauri-apps/plugin-dialog";
import {
  type Lead,
  type LeadList,
  addLeadEmail,
  addLeadPhone,
  addLeadsToList,
  assignLead,
  createLeadList,
  deleteLeadEmail,
  deleteLeadPhone,
  deleteLeadList,
  generateLeadIntelligence,
  getLogEntries,
  importLeadsCsv,
  lookupCompanyPhone,
  scrapeLeadEmail,
  toggleListLeadCalled,
  updateLead,
  updateLeadEmail,
  updateLeadPhone,
} from "../api";
import { getCurrentUser, isAdmin, subscribeAuth } from "../auth";
import {
  type SortColumn,
  type SortDirection,
  filterLeads,
  renderEmptyState,
  renderRows,
  renderSkeletonRows,
  sortLeadsStable,
} from "../components/leadTable";
import {
  closeSidePanel,
  openSidePanel,
  refreshIfOpen,
  setSidePanelCallbacks,
  type SidePanelCallbacks,
} from "../components/sidePanel";
import { CONTACT_STATUS_ORDER } from "../constants";
import { setPendingEmailWriterLead } from "../emailWriterHandoff";
import { getLeadLists, refreshLeadLists, subscribeLeadLists } from "../leadLists";
import { openTab } from "../tabs";
import { escapeHtml } from "../utils";

const LIST_COLUMN_COUNT = 12; // select + called + status-dot + company + phone + source + status + industry + contact-status + emails + list + notes

export function initColdCallLists(): void {
  const container = document.querySelector<HTMLDivElement>("#view-cold-call-lists")!;
  container.innerHTML = `
    <main class="container" id="ccl-overview-wrapper">
      <div id="cold-call-lists-overview">
        <section class="card">
          <div class="card-header-row">
            <div>
              <h2 class="card-title">Cold Call Lists</h2>
              <p class="card-subtitle">Private lead lists you upload and work yourself.</p>
            </div>
            <div class="card-header-actions">
              <button id="new-list-btn" class="btn btn-primary">New list</button>
            </div>
          </div>
          <div id="new-list-form" class="new-list-form hidden">
            <input id="new-list-name-input" type="text" class="search-input" placeholder="List name" />
            <button id="create-list-confirm-btn" class="btn btn-primary">Create</button>
            <button id="create-list-cancel-btn" class="btn btn-ghost">Cancel</button>
          </div>
          <span id="new-list-error" class="status-message"></span>
          <ul id="my-lists" class="history-list"></ul>
          <p id="my-lists-empty" class="empty-state hidden">You don't have any cold call lists yet — create one to get started.</p>
        </section>

        <section class="card hidden" id="admin-lists-card">
          <h2 class="card-title">All Team Lists</h2>
          <p class="card-subtitle">Visible to admins only.</p>
          <ul id="admin-lists" class="history-list"></ul>
        </section>
      </div>
    </main>

    <!-- Full-screen call sheet — shown when a list is open -->
    <div id="cold-call-list-detail" class="call-sheet-view hidden">

      <!-- Top header bar -->
      <div class="call-sheet-header">
        <button id="back-to-lists-btn" class="btn btn-ghost btn-sm">← Back</button>
        <h2 class="call-sheet-title" id="list-detail-title"></h2>
        <div class="call-sheet-header-actions">
          <button id="toggle-add-btn" class="btn btn-ghost btn-sm">+ Add companies</button>
          <button id="find-phones-btn" class="btn btn-secondary btn-sm">Find phones</button>
          <button id="delete-list-btn" class="btn btn-ghost btn-danger btn-sm">Delete</button>
        </div>
        <div class="call-sheet-header-spacer"></div>
        <input id="list-search-input" type="search" class="search-input call-sheet-search" placeholder="Search leads..." />
        <span id="list-detail-status" class="status-message"></span>
      </div>

      <!-- Collapsible add-companies panel -->
      <div id="add-companies-panel" class="add-companies-panel hidden">
        <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 var(--space-2)">Enter one company name per line — AI phone lookup, scoped to this list. Or upload a CSV.</p>
        <div class="add-companies-row">
          <textarea id="list-companies-input" rows="3" placeholder="Acme Ltd&#10;Example Widgets Inc"></textarea>
          <div class="add-companies-btns">
            <button id="list-lookup-btn" class="btn btn-primary btn-sm">Look up</button>
            <button id="upload-csv-btn" class="btn btn-secondary btn-sm">Upload CSV</button>
          </div>
        </div>
      </div>

      <!-- Filter bar -->
      <div class="call-sheet-filter-bar">
        <div class="call-sheet-filter-row">
          <div class="ccl-called-filter">
            <button class="ccl-filter-btn active" data-called="all">All</button>
            <button class="ccl-filter-btn" data-called="not-called">Not Called</button>
            <button class="ccl-filter-btn" data-called="called">Called</button>
            <button class="ccl-filter-btn" data-called="follow-up">Follow-up</button>
          </div>
          <div class="ccl-phone-filter">
            <button class="ccl-phone-btn active" data-phone="all">All</button>
            <button class="ccl-phone-btn" data-phone="has-phone">Has Phone</button>
            <button class="ccl-phone-btn" data-phone="no-phone">No Phone</button>
          </div>
          <div class="ccl-scope-filter">
            <button class="ccl-scope-btn active" data-scope="all">All Leads</button>
            <button class="ccl-scope-btn" data-scope="this-list">This List</button>
            <button class="ccl-scope-btn" data-scope="unassigned">Unassigned</button>
          </div>
          <div class="ccl-enrich-filter ccl-enrich-inline">
            <button class="ccl-enrich-btn active" data-enrich="all">All</button>
            <button class="ccl-enrich-btn" data-enrich="has-charges">Has Charges</button>
            <button class="ccl-enrich-btn" data-enrich="enriched">Enriched</button>
            <button class="ccl-enrich-btn" data-enrich="not-enriched">Not Enriched</button>
          </div>
          <div class="ccl-sort-select">
            <label for="ccl-sort-select">Sort</label>
            <select id="ccl-sort-select">
              <option value="">Default</option>
              <option value="lead_score:asc">Score (high–low)</option>
              <option value="lead_score:desc">Score (low–high)</option>
              <option value="company:asc">Company A–Z</option>
              <option value="company:desc">Company Z–A</option>
              <option value="phone_number:asc">Phone first</option>
              <option value="status:asc">Status</option>
              <option value="industry:asc">Industry A–Z</option>
              <option value="contact_status:asc">Contact Status</option>
            </select>
          </div>
        </div>

        <!-- Bulk action bar (sits inside the filter bar strip) -->
        <div id="ccl-bulk-bar" class="ccl-bulk-bar ccl-bulk-bar-inline hidden">
          <span id="ccl-bulk-count"></span>
          <button id="ccl-bulk-called-btn" class="btn btn-secondary btn-sm">Mark as Called</button>
          <button id="ccl-bulk-add-btn" class="btn btn-secondary btn-sm">Add to This List</button>
          <button id="ccl-bulk-generate-btn" class="btn btn-primary btn-sm">Generate call list</button>
          <div id="ccl-generate-form" class="ccl-generate-form hidden">
            <input id="ccl-generate-name-input" type="text" class="search-input" placeholder="List name…" />
            <button id="ccl-generate-confirm-btn" class="btn btn-primary btn-sm">Create</button>
            <button id="ccl-generate-cancel-btn" class="btn btn-ghost btn-sm">Cancel</button>
          </div>
          <button id="ccl-bulk-clear-btn" class="btn btn-ghost btn-sm">Clear</button>
        </div>
      </div>

      <!-- Scrollable table -->
      <div class="call-sheet-table-wrap">
        <table id="list-results-table" class="call-sheet-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="ccl-select-all-cb" title="Select all visible" /></th>
              <th>Called</th>
              <th></th>
              <th data-sort="company">Company</th>
              <th data-sort="phone_number">Phone</th>
              <th>Source</th>
              <th data-sort="status">Status</th>
              <th data-sort="industry">Industry</th>
              <th data-sort="contact_status">Contact Status</th>
              <th>Emails</th>
              <th>List</th>
              <th class="notes-header-col">Notes</th>
            </tr>
          </thead>
          <tbody id="list-results-body"></tbody>
        </table>
      </div>
    </div>
  `;

  const overviewWrapper = container.querySelector<HTMLElement>("#ccl-overview-wrapper")!;
  const detailEl = container.querySelector<HTMLDivElement>("#cold-call-list-detail")!;
  const myListsEl = container.querySelector<HTMLUListElement>("#my-lists")!;
  const myListsEmptyEl = container.querySelector<HTMLParagraphElement>("#my-lists-empty")!;
  const adminListsCard = container.querySelector<HTMLDivElement>("#admin-lists-card")!;
  const adminListsEl = container.querySelector<HTMLUListElement>("#admin-lists")!;
  const newListForm = container.querySelector<HTMLDivElement>("#new-list-form")!;
  const newListNameInput = container.querySelector<HTMLInputElement>("#new-list-name-input")!;
  const newListError = container.querySelector<HTMLSpanElement>("#new-list-error")!;
  const listDetailTitle = container.querySelector<HTMLHeadingElement>("#list-detail-title")!;
  const listDetailStatus = container.querySelector<HTMLSpanElement>("#list-detail-status")!;
  const listCompaniesInput = container.querySelector<HTMLTextAreaElement>("#list-companies-input")!;
  const listLookupBtn = container.querySelector<HTMLButtonElement>("#list-lookup-btn")!;
  const listResultsBody = container.querySelector<HTMLTableSectionElement>("#list-results-body")!;
  const listSearchInput = container.querySelector<HTMLInputElement>("#list-search-input")!;
  const sortableHeaders = container.querySelectorAll<HTMLTableCellElement>("#list-results-table th[data-sort]");
  const bulkBar = container.querySelector<HTMLDivElement>("#ccl-bulk-bar")!;
  const bulkCount = container.querySelector<HTMLSpanElement>("#ccl-bulk-count")!;
  const bulkCalledBtn = container.querySelector<HTMLButtonElement>("#ccl-bulk-called-btn")!;
  const bulkAddBtn = container.querySelector<HTMLButtonElement>("#ccl-bulk-add-btn")!;
  const bulkGenerateBtn = container.querySelector<HTMLButtonElement>("#ccl-bulk-generate-btn")!;
  const generateForm = container.querySelector<HTMLDivElement>("#ccl-generate-form")!;
  const generateNameInput = container.querySelector<HTMLInputElement>("#ccl-generate-name-input")!;
  const generateConfirmBtn = container.querySelector<HTMLButtonElement>("#ccl-generate-confirm-btn")!;
  const generateCancelBtn = container.querySelector<HTMLButtonElement>("#ccl-generate-cancel-btn")!;
  const bulkClearBtn = container.querySelector<HTMLButtonElement>("#ccl-bulk-clear-btn")!;
  const selectAllCb = container.querySelector<HTMLInputElement>("#ccl-select-all-cb")!;
  const deleteListBtn = container.querySelector<HTMLButtonElement>("#delete-list-btn")!;
  const enrichFilterBtns = container.querySelectorAll<HTMLButtonElement>(".ccl-enrich-btn");
  const scopeFilterBtns = container.querySelectorAll<HTMLButtonElement>(".ccl-scope-btn");
  const findPhonesBtn = container.querySelector<HTMLButtonElement>("#find-phones-btn")!;
  const sortSelect = container.querySelector<HTMLSelectElement>("#ccl-sort-select")!;
  const toggleAddBtn = container.querySelector<HTMLButtonElement>("#toggle-add-btn")!;
  const addCompaniesPanel = container.querySelector<HTMLDivElement>("#add-companies-panel")!;
  const phoneFilterBtns = container.querySelectorAll<HTMLButtonElement>(".ccl-phone-btn");

  let currentListId: string | null = null;
  let currentListLeads: Lead[] = [];
  let sortColumn: SortColumn = null;
  let sortDirection: SortDirection = "asc";
  let searchText = "";
  let calledFilter: "all" | "called" | "not-called" | "follow-up" = "all";
  let enrichFilter: "all" | "enriched" | "has-charges" | "not-enriched" = "all";
  let scopeFilter: "all" | "this-list" | "unassigned" = "all";
  let phoneFilter: "all" | "has-phone" | "no-phone" = "all";
  let selectedLeadIds = new Set<string>();
  let lastToggledIndex = -1;

  function listRowHtml(list: LeadList, showOwner: boolean): string {
    return `
      <li class="history-list-row list-row" data-list-id="${escapeHtml(list.id)}">
        <span class="list-row-name">${escapeHtml(list.name)}</span>
        ${showOwner ? `<span class="empty-hint">${escapeHtml(list.owner_name || "—")}</span>` : ""}
        <span class="empty-hint">${list.lead_count} lead${list.lead_count === 1 ? "" : "s"}</span>
      </li>
    `;
  }

  function wireListRows(el: HTMLUListElement): void {
    el.querySelectorAll<HTMLLIElement>(".list-row").forEach((row) => {
      row.addEventListener("click", () => void openListDetail(row.dataset.listId!));
    });
  }

  function renderOverview(): void {
    const current = getCurrentUser();
    const lists = getLeadLists();
    const mine = lists.filter((l) => l.owner_user_id === current?.id);
    const others = isAdmin() ? lists.filter((l) => l.owner_user_id !== current?.id) : [];

    if (mine.length === 0) {
      myListsEl.innerHTML = "";
      myListsEmptyEl.classList.remove("hidden");
    } else {
      myListsEmptyEl.classList.add("hidden");
      myListsEl.innerHTML = mine.map((l) => listRowHtml(l, false)).join("");
      wireListRows(myListsEl);
    }

    adminListsCard.classList.toggle("hidden", others.length === 0);
    adminListsEl.innerHTML = others.map((l) => listRowHtml(l, true)).join("");
    wireListRows(adminListsEl);
  }

  function updateSortIndicators(): void {
    sortableHeaders.forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.sort === sortColumn) {
        th.classList.add(sortDirection === "asc" ? "sorted-asc" : "sorted-desc");
      }
    });
  }

  function updateBulkBar(visibleLeads?: Lead[]): void {
    const count = selectedLeadIds.size;
    bulkBar.classList.toggle("hidden", count === 0);
    bulkCount.textContent = `${count} selected`;
    if (visibleLeads) {
      const allVisible = visibleLeads.length > 0 && visibleLeads.every((l) => selectedLeadIds.has(l.id));
      selectAllCb.checked = allVisible;
      selectAllCb.indeterminate = !allVisible && count > 0;
    }
  }

  function hasCharges(lead: Lead): boolean {
    try { return JSON.parse(lead.ch_data || "{}").charges?.length > 0; } catch { return false; }
  }
  function isEnriched(lead: Lead): boolean {
    try { const d = JSON.parse(lead.ch_data || "{}"); return !!d.company_number && !d.not_found; } catch { return false; }
  }
  function hasPhone(lead: Lead): boolean {
    return !!(lead.phone_number && lead.phone_number !== "not_found");
  }

  function renderListTable(): void {
    refreshIfOpen(currentListLeads);
    updateSortIndicators();

    if (currentListLeads.length === 0) {
      renderEmptyState(listResultsBody, "No leads yet — upload a CSV or add companies above.", LIST_COLUMN_COUNT);
      return;
    }

    const now = new Date();
    const isFollowUpDue = (l: Lead) => !!l.follow_up_at && new Date(l.follow_up_at) <= now;

    let filtered = filterLeads(currentListLeads, searchText, new Set());
    // Scope filter
    if (scopeFilter === "this-list") filtered = filtered.filter((l) => l.list_id === currentListId);
    else if (scopeFilter === "unassigned") filtered = filtered.filter((l) => !l.list_id);
    // Called filter
    if (calledFilter === "called") filtered = filtered.filter((l) => !!l.called_at);
    else if (calledFilter === "not-called") filtered = filtered.filter((l) => !l.called_at);
    else if (calledFilter === "follow-up") filtered = filtered.filter(isFollowUpDue);
    // Phone filter
    if (phoneFilter === "has-phone") filtered = filtered.filter(hasPhone);
    else if (phoneFilter === "no-phone") filtered = filtered.filter((l) => !hasPhone(l));
    // Enrichment filter
    if (enrichFilter === "has-charges") filtered = filtered.filter(hasCharges);
    else if (enrichFilter === "enriched") filtered = filtered.filter(isEnriched);
    else if (enrichFilter === "not-enriched") filtered = filtered.filter((l) => !isEnriched(l));

    const sorted = sortLeadsStable(filtered, sortColumn, sortDirection);
    const visible = [
      ...sorted.filter(isFollowUpDue),
      ...sorted.filter((l) => !isFollowUpDue(l)),
    ];
    if (visible.length === 0) {
      renderEmptyState(listResultsBody, "No leads match your filters.", LIST_COLUMN_COUNT);
      return;
    }
    renderRows(listResultsBody, visible, {
      onRowClick: (lead) => {
        setSidePanelCallbacks(listSidePanelCallbacks);
        openSidePanel(lead);
      },
      onIndustryChange: async (lead, value) => {
        await updateLead(lead.id, { industry: value });
        await refreshCurrentList();
      },
      onContactStatusChange: async (lead, value) => {
        await updateLead(lead.id, { contactStatus: value });
        await refreshCurrentList();
      },
      onToggleContacted: async (lead) => {
        const next = lead.contact_status === CONTACT_STATUS_ORDER[0] ? "Contacted" : CONTACT_STATUS_ORDER[0];
        await updateLead(lead.id, { contactStatus: next });
        await refreshCurrentList();
      },
      onToggleCalled: async (lead) => {
        if (!currentListId) return;
        await toggleListLeadCalled(currentListId, lead.id);
        await refreshCurrentList();
      },
      onToggleSelect: (lead, selected, shiftKey) => {
        const currentIndex = visible.findIndex((l) => l.id === lead.id);
        if (shiftKey && lastToggledIndex >= 0 && currentIndex >= 0) {
          const lo = Math.min(lastToggledIndex, currentIndex);
          const hi = Math.max(lastToggledIndex, currentIndex);
          for (let i = lo; i <= hi; i++) {
            if (selected) selectedLeadIds.add(visible[i].id);
            else selectedLeadIds.delete(visible[i].id);
            const r = listResultsBody.querySelector<HTMLTableRowElement>(`[data-lead-id="${visible[i].id}"]`);
            if (r) {
              r.classList.toggle("lead-row-selected", selected);
              const cb = r.querySelector<HTMLInputElement>(".select-cb");
              if (cb) cb.checked = selected;
            }
          }
        } else {
          if (selected) selectedLeadIds.add(lead.id);
          else selectedLeadIds.delete(lead.id);
          const row = listResultsBody.querySelector<HTMLTableRowElement>(`[data-lead-id="${lead.id}"]`);
          if (row) row.classList.toggle("lead-row-selected", selected);
        }
        lastToggledIndex = currentIndex;
        updateBulkBar(visible);
      },
      onGenerateEmail: (lead) => {
        setPendingEmailWriterLead(lead.id);
        openTab("outreach", "Outreach");
      },
      onLookupPhone: (lead) => {
        void lookupCompanyPhone(lead.company, currentListId ?? undefined).then(() => refreshCurrentList());
      },
      onSaveNotes: async (lead, notes) => {
        await updateLead(lead.id, { leadNotes: notes });
        // Update in-memory only — don't re-render (avoids scroll reset while editing)
        const idx = currentListLeads.findIndex((l) => l.id === lead.id);
        if (idx >= 0) currentListLeads[idx] = { ...currentListLeads[idx], notes };
      },
      showListColumn: true,
    }, selectedLeadIds);
    updateBulkBar(visible);
  }

  async function refreshCurrentList(): Promise<void> {
    if (!currentListId) return;
    currentListLeads = await getLogEntries();
    renderListTable();
  }

  const listSidePanelCallbacks: SidePanelCallbacks = {
    onSaveNotes: async (id, notes) => {
      await updateLead(id, { leadNotes: notes });
      await refreshCurrentList();
    },
    onAssign: async (id, assignedUserId) => {
      await assignLead(id, assignedUserId);
      await refreshCurrentList();
    },
    onSaveDetails: async (id, contactName, contactTitle, website, linkedin) => {
      await updateLead(id, { contactName, contactTitle, website, linkedin });
      await refreshCurrentList();
    },
    onAddPhone: async (id, phoneNumber) => {
      await addLeadPhone(id, phoneNumber);
      await refreshCurrentList();
    },
    onUpdatePhone: async (id, phoneId, phoneNumber) => {
      await updateLeadPhone(id, phoneId, phoneNumber);
      await refreshCurrentList();
    },
    onDeletePhone: async (id, phoneId) => {
      await deleteLeadPhone(id, phoneId);
      await refreshCurrentList();
    },
    onAddEmail: async (id, email) => {
      await addLeadEmail(id, email);
      await refreshCurrentList();
    },
    onUpdateEmail: async (id, emailId, email) => {
      await updateLeadEmail(id, emailId, email);
      await refreshCurrentList();
    },
    onDeleteEmail: async (id, emailId) => {
      await deleteLeadEmail(id, emailId);
      await refreshCurrentList();
    },
    onScrapeEmail: async (id) => {
      await scrapeLeadEmail(id);
      await refreshCurrentList();
    },
    onGenerateIntelligence: async (id) => {
      await generateLeadIntelligence(id);
      await refreshCurrentList();
    },
  };

  const calledFilterBtns = container.querySelectorAll<HTMLButtonElement>(".ccl-filter-btn");
  calledFilterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      calledFilter = btn.dataset.called as "all" | "called" | "not-called" | "follow-up";
      calledFilterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLeadIds.clear();
      lastToggledIndex = -1;
      renderListTable();
    });
  });

  phoneFilterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      phoneFilter = btn.dataset.phone as "all" | "has-phone" | "no-phone";
      phoneFilterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLeadIds.clear();
      lastToggledIndex = -1;
      renderListTable();
    });
  });

  enrichFilterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      enrichFilter = btn.dataset.enrich as "all" | "enriched" | "has-charges" | "not-enriched";
      enrichFilterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLeadIds.clear();
      lastToggledIndex = -1;
      renderListTable();
    });
  });

  sortSelect.addEventListener("change", () => {
    const val = sortSelect.value;
    if (!val) {
      sortColumn = null;
      sortDirection = "asc";
    } else {
      const [col, dir] = val.split(":") as [SortColumn, SortDirection];
      sortColumn = col;
      sortDirection = dir;
    }
    renderListTable();
  });

  deleteListBtn.addEventListener("click", async () => {
    if (!currentListId) return;
    const listName = listDetailTitle.textContent || "this list";
    if (!confirm(`Delete "${listName}"? This will also delete all leads in this list and cannot be undone.`)) return;
    try {
      await deleteLeadList(currentListId);
      backToOverview();
    } catch (err) {
      alert(`Failed to delete list: ${err}`);
    }
  });

  selectAllCb.addEventListener("change", () => {
    const visible = Array.from(listResultsBody.querySelectorAll<HTMLTableRowElement>("[data-lead-id]")).map((r) => r.dataset.leadId!);
    if (selectAllCb.checked) visible.forEach((id) => selectedLeadIds.add(id));
    else visible.forEach((id) => selectedLeadIds.delete(id));
    visible.forEach((id) => {
      const row = listResultsBody.querySelector<HTMLTableRowElement>(`[data-lead-id="${id}"]`);
      if (row) {
        row.classList.toggle("lead-row-selected", selectAllCb.checked);
        const cb = row.querySelector<HTMLInputElement>(".select-cb");
        if (cb) cb.checked = selectAllCb.checked;
      }
    });
    updateBulkBar();
  });

  bulkClearBtn.addEventListener("click", () => {
    selectedLeadIds.clear();
    lastToggledIndex = -1;
    closeGenerateForm();
    listResultsBody.querySelectorAll<HTMLTableRowElement>("[data-lead-id]").forEach((r) => {
      r.classList.remove("lead-row-selected");
      const cb = r.querySelector<HTMLInputElement>(".select-cb");
      if (cb) cb.checked = false;
    });
    updateBulkBar();
  });

  bulkCalledBtn.addEventListener("click", async () => {
    if (!currentListId || selectedLeadIds.size === 0) return;
    bulkCalledBtn.disabled = true;
    const ids = Array.from(selectedLeadIds);
    await Promise.all(ids.map((id) => toggleListLeadCalled(currentListId!, id).catch(() => {})));
    selectedLeadIds.clear();
    await refreshCurrentList();
    bulkCalledBtn.disabled = false;
  });

  bulkAddBtn.addEventListener("click", async () => {
    if (!currentListId || selectedLeadIds.size === 0) return;
    bulkAddBtn.disabled = true;
    const ids = Array.from(selectedLeadIds);
    try {
      const result = await addLeadsToList(currentListId, ids);
      selectedLeadIds.clear();
      lastToggledIndex = -1;
      await refreshCurrentList();
      if (result.skipped > 0) {
        const names = result.skipped_details.map((d) => `${d.company} (already in "${d.list_name}")`).join("\n");
        alert(`${result.added} lead${result.added !== 1 ? "s" : ""} added.\n\n${result.skipped} skipped — already in another list:\n${names}`);
      }
    } catch (err) {
      alert(`Failed to add leads: ${err}`);
    }
    bulkAddBtn.disabled = false;
  });

  findPhonesBtn.addEventListener("click", async () => {
    if (!currentListId) return;
    const missing = currentListLeads.filter(
      (l) => l.list_id === currentListId && (!l.phone_number || l.phone_number === "not_found")
    );
    if (missing.length === 0) {
      listDetailStatus.textContent = "All leads in this list already have phone numbers.";
      setTimeout(() => { listDetailStatus.textContent = ""; }, 3000);
      return;
    }
    const estimatedCost = (missing.length * 0.03).toFixed(2);
    if (!confirm(`Find phone numbers for ${missing.length} lead${missing.length === 1 ? "" : "s"} without a number?\n\nEstimated cost: ~£${estimatedCost}\n\nThis uses phone lookup credits.`)) return;
    findPhonesBtn.disabled = true;
    for (let i = 0; i < missing.length; i++) {
      const lead = missing[i];
      listDetailStatus.textContent = `Looking up ${lead.company} (${i + 1}/${missing.length})...`;
      try {
        await lookupCompanyPhone(lead.company, currentListId);
        await refreshCurrentList();
      } catch {
        // continue on error
      }
    }
    listDetailStatus.textContent = "";
    findPhonesBtn.disabled = false;
    await refreshLeadLists();
  });

  toggleAddBtn.addEventListener("click", () => {
    const isHidden = addCompaniesPanel.classList.toggle("hidden");
    toggleAddBtn.textContent = isHidden ? "+ Add companies" : "− Add companies";
  });

  function openGenerateForm(): void {
    generateForm.classList.remove("hidden");
    bulkGenerateBtn.classList.add("hidden");
    generateNameInput.value = "";
    generateNameInput.focus();
  }

  function closeGenerateForm(): void {
    generateForm.classList.add("hidden");
    bulkGenerateBtn.classList.remove("hidden");
  }

  async function submitGenerateList(): Promise<void> {
    const name = generateNameInput.value.trim();
    if (!name) return;
    generateConfirmBtn.disabled = true;
    generateConfirmBtn.textContent = "Creating...";
    const ids = Array.from(selectedLeadIds);
    try {
      const list = await createLeadList(name);
      await addLeadsToList(list.id, ids);
      await refreshLeadLists();
      selectedLeadIds.clear();
      lastToggledIndex = -1;
      closeGenerateForm();
      await openListDetail(list.id);
    } catch (err) {
      alert(`Failed to create call list: ${err}`);
    }
    generateConfirmBtn.disabled = false;
    generateConfirmBtn.textContent = "Create";
  }

  bulkGenerateBtn.addEventListener("click", openGenerateForm);
  generateCancelBtn.addEventListener("click", closeGenerateForm);
  generateConfirmBtn.addEventListener("click", () => void submitGenerateList());
  generateNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submitGenerateList();
    if (e.key === "Escape") closeGenerateForm();
  });

  scopeFilterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      scopeFilter = btn.dataset.scope as "all" | "this-list" | "unassigned";
      scopeFilterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLeadIds.clear();
      lastToggledIndex = -1;
      renderListTable();
    });
  });

  async function openListDetail(listId: string): Promise<void> {
    currentListId = listId;
    sortColumn = null;
    sortDirection = "asc";
    searchText = "";
    calledFilter = "all";
    enrichFilter = "all";
    scopeFilter = "all";
    phoneFilter = "all";
    selectedLeadIds.clear();
    lastToggledIndex = -1;
    calledFilterBtns.forEach((b) => b.classList.toggle("active", b.dataset.called === "all"));
    enrichFilterBtns.forEach((b) => b.classList.toggle("active", b.dataset.enrich === "all"));
    scopeFilterBtns.forEach((b) => b.classList.toggle("active", b.dataset.scope === "all"));
    phoneFilterBtns.forEach((b) => b.classList.toggle("active", b.dataset.phone === "all"));
    sortSelect.value = "";
    listSearchInput.value = "";
    listDetailStatus.textContent = "";
    addCompaniesPanel.classList.add("hidden");
    toggleAddBtn.textContent = "+ Add companies";
    listDetailTitle.textContent = getLeadLists().find((l) => l.id === listId)?.name ?? "List";

    overviewWrapper.classList.add("hidden");
    detailEl.classList.remove("hidden");

    renderSkeletonRows(listResultsBody, 3, LIST_COLUMN_COUNT);
    await refreshCurrentList();
  }

  function backToOverview(): void {
    closeSidePanel();
    currentListId = null;
    detailEl.classList.add("hidden");
    overviewWrapper.classList.remove("hidden");
    void refreshLeadLists();
  }

  subscribeLeadLists(renderOverview);
  subscribeAuth(() => {
    if (!getCurrentUser()) return;
    void refreshLeadLists();
  });

  function openNewListForm(): void {
    newListError.textContent = "";
    newListForm.classList.remove("hidden");
    newListNameInput.value = "";
    newListNameInput.focus();
  }

  function closeNewListForm(): void {
    newListForm.classList.add("hidden");
    newListNameInput.value = "";
    newListError.textContent = "";
  }

  async function submitNewList(): Promise<void> {
    const name = newListNameInput.value.trim();
    if (!name) return;
    try {
      const list = await createLeadList(name);
      await refreshLeadLists();
      closeNewListForm();
      await openListDetail(list.id);
    } catch (err) {
      newListError.textContent = `Failed to create list: ${err}`;
    }
  }

  container.querySelector("#new-list-btn")!.addEventListener("click", openNewListForm);
  container.querySelector("#create-list-cancel-btn")!.addEventListener("click", closeNewListForm);
  container.querySelector("#create-list-confirm-btn")!.addEventListener("click", () => void submitNewList());
  newListNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submitNewList();
    if (event.key === "Escape") closeNewListForm();
  });

  container.querySelector("#back-to-lists-btn")!.addEventListener("click", backToOverview);

  async function runListLookups(companies: string[]): Promise<void> {
    if (!currentListId) return;
    listLookupBtn.disabled = true;
    for (const company of companies) {
      listDetailStatus.textContent = `Looking up ${company}...`;
      try {
        await lookupCompanyPhone(company, currentListId);
        await refreshCurrentList();
      } catch (err) {
        listDetailStatus.textContent = `Error looking up ${company}: ${err}`;
      }
    }
    listDetailStatus.textContent = "";
    listLookupBtn.disabled = false;
    await refreshLeadLists();
  }

  listLookupBtn.addEventListener("click", () => {
    const companies = listCompaniesInput.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (companies.length > 0) {
      listCompaniesInput.value = "";
      void runListLookups(companies);
    }
  });

  listSearchInput.addEventListener("input", () => {
    searchText = listSearchInput.value;
    renderListTable();
  });

  sortableHeaders.forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort as SortColumn;
      if (sortColumn === col) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
      } else {
        sortColumn = col;
        sortDirection = "asc";
      }
      renderListTable();
    });
  });

  container.querySelector("#upload-csv-btn")!.addEventListener("click", async () => {
    if (!currentListId) return;
    const path = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof path !== "string") return;

    listDetailStatus.textContent = "Importing...";
    try {
      const imported = await importLeadsCsv(currentListId, path);
      listDetailStatus.textContent = `Imported ${imported} lead(s).`;
      await refreshCurrentList();
      await refreshLeadLists();
    } catch (err) {
      listDetailStatus.textContent = `Import failed: ${err}`;
    }
  });
}
