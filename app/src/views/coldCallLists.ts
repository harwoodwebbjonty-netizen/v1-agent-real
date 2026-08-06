import { open } from "@tauri-apps/plugin-dialog";
import {
  type CallOutcome,
  type EmailDraft,
  type EmailOAuthAccount,
  type EmailProvider,
  type Lead,
  type LeadList,
  addLeadEmail,
  addLeadPhone,
  addLeadsToList,
  assignLead,
  createCallLog,
  createLeadList,
  deleteLeadEmail,
  deleteLeadList,
  deleteLeadPhone,
  generateFollowUpDraft,
  generateLeadIntelligence,
  getLogEntries,
  importLeadsCsv,
  listEmailOAuthAccounts,
  listTeamMembers,
  lookupCompanyPhone,
  scoreLeadList,
  scrapeLeadEmail,
  sendEmailDraft,
  setLeadShared,
  toggleListLeadCalled,
  updateEmailDraft,
  updateLead,
  updateLeadEmail,
  updateLeadPhone,
} from "../api";
import { CHARGE_TYPES, bindMultiSelect, buildMultiSelectHtml } from "../components/multiSelect";
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
import { getLeads, refreshLeads } from "../state";
import { openTab } from "../tabs";
import { escapeHtml } from "../utils";

// select + called + dot + company + phone + status + industry + contact-status + emails + list + notes
const CALL_SHEET_COL_COUNT = 11;
// checkbox + company + phone + industry + list
const SELECTOR_COL_COUNT = 5;

export function initColdCallLists(): void {
  const container = document.querySelector<HTMLDivElement>("#view-cold-call-lists")!;
  container.innerHTML = `
    <!-- ── Screen 1: Overview ── -->
    <main class="container" id="ccl-overview-wrapper">
      <div id="cold-call-lists-overview">
        <section class="card">
          <div class="card-header-row">
            <div>
              <h2 class="card-title">Cold Call Lists</h2>
              <p class="card-subtitle">Private lead lists for the sales team to call from.</p>
            </div>
            <div class="card-header-actions">
              <button id="new-list-btn" class="btn btn-primary">+ New list</button>
            </div>
          </div>
          <ul id="my-lists" class="history-list"></ul>
          <p id="my-lists-empty" class="empty-state hidden">No lists yet — click "New list" to create your first call list.</p>
        </section>

        <section class="card hidden" id="admin-lists-card">
          <h2 class="card-title">All Team Lists</h2>
          <p class="card-subtitle">Visible to admins only.</p>
          <ul id="admin-lists" class="history-list"></ul>
        </section>
      </div>
    </main>

    <!-- ── Screen 2: Name your list ── -->
    <div id="ccl-name-screen" class="call-sheet-view hidden">
      <div class="call-sheet-header">
        <button id="name-back-btn" class="btn btn-ghost btn-sm">← Back</button>
        <h2 class="call-sheet-title">Create a new call list</h2>
      </div>
      <div class="ccl-name-body">
        <div class="ccl-name-form">
          <label class="form-label" for="list-name-input-screen">Name your list</label>
          <input id="list-name-input-screen" type="text" class="search-input ccl-name-input"
            placeholder="e.g. London Construction Q3" autocomplete="off" />
          <div id="list-for-wrap" class="hidden">
            <label class="form-label" for="list-for-select">Create list for</label>
            <select id="list-for-select" class="ccl-filter-select">
              <option value="">Myself</option>
            </select>
          </div>
          <p class="ccl-name-hint">You'll select which leads to include on the next step.</p>
          <button id="name-next-btn" class="btn btn-primary ccl-name-next-btn">Next: Select leads →</button>
        </div>
      </div>
    </div>

    <!-- ── Screen 3: Lead selector ── -->
    <div id="ccl-lead-selector" class="call-sheet-view hidden">
      <div class="call-sheet-header">
        <button id="selector-back-btn" class="btn btn-ghost btn-sm">← Back</button>
        <h2 class="call-sheet-title" id="selector-list-name-display"></h2>
        <div class="call-sheet-header-spacer"></div>
        <input id="selector-search-input" type="search" class="search-input call-sheet-search" placeholder="Search leads..." />
        <span id="selector-count-label" class="status-message"></span>
        <button id="selector-create-btn" class="btn btn-primary btn-sm hidden">Create list</button>
      </div>

      <div class="call-sheet-filter-bar">
        <div class="call-sheet-filter-row">
          <div class="ccl-phone-filter">
            <button class="sel-phone-btn active" data-phone="all">All</button>
            <button class="sel-phone-btn" data-phone="has-phone">Has Phone</button>
            <button class="sel-phone-btn" data-phone="no-phone">No Phone</button>
          </div>
          <div class="ccl-status-filter">
            <button class="sel-status-btn active" data-status="">All Status</button>
            <button class="sel-status-btn" data-status="verified">Verified</button>
            <button class="sel-status-btn" data-status="unverified">Unverified</button>
            <button class="sel-status-btn" data-status="not_found">Not Found</button>
          </div>
        </div>
        <div class="call-sheet-filter-row">
          <select id="sel-contact-status-select" class="ccl-filter-select">
            <option value="">All Contact Status</option>
            <option value="New">New</option>
            <option value="Contacted">Contacted</option>
            <option value="Replied">Replied</option>
            <option value="Converted">Converted</option>
          </select>
          <div id="sel-industry-wrap" class="sel-ms-wrap"></div>
          <div id="sel-charge-wrap" class="sel-ms-wrap"></div>
          <div class="ccl-sort-select">
            <label for="sel-sort-select">Sort</label>
            <select id="sel-sort-select">
              <option value="">Default</option>
              <option value="lead_score:asc">Score (high–low)</option>
              <option value="company:asc">Company A–Z</option>
              <option value="phone_number:asc">Phone first</option>
              <option value="industry:asc">Industry A–Z</option>
              <option value="contact_status:asc">Contact Status</option>
            </select>
          </div>
          <label class="selector-select-all-label">
            <input type="checkbox" id="selector-all-cb" />
            Select all visible
          </label>
        </div>
      </div>

      <div class="call-sheet-table-wrap">
        <table class="call-sheet-table">
          <thead>
            <tr>
              <th style="width:36px"></th>
              <th>Company</th>
              <th>Phone</th>
              <th>Industry</th>
              <th>Current List</th>
            </tr>
          </thead>
          <tbody id="selector-body"></tbody>
        </table>
      </div>
    </div>

    <!-- ── Screen 4: Call sheet (the working list) ── -->
    <div id="cold-call-list-detail" class="call-sheet-view hidden">
      <div class="call-sheet-header">
        <button id="back-to-lists-btn" class="btn btn-ghost btn-sm">← Back</button>
        <h2 class="call-sheet-title" id="list-detail-title"></h2>
        <div class="call-sheet-header-actions">
          <button id="toggle-add-btn" class="btn btn-ghost btn-sm">+ Add companies</button>
          <button id="score-list-btn" class="btn btn-secondary btn-sm" title="Rank leads by value so the best calls sort to the top (free, no AI)">Score list</button>
          <button id="find-phones-btn" class="btn btn-secondary btn-sm">Find phones</button>
          <button id="delete-list-btn" class="btn btn-ghost btn-danger btn-sm">Delete</button>
        </div>
        <div class="call-sheet-header-spacer"></div>
        <input id="list-search-input" type="search" class="search-input call-sheet-search" placeholder="Search leads..." />
        <span id="list-detail-status" class="status-message"></span>
      </div>

      <div id="add-companies-panel" class="add-companies-panel hidden">
        <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 var(--space-2)">Enter one company name per line, or upload a CSV.</p>
        <div class="add-companies-row">
          <textarea id="list-companies-input" rows="3" placeholder="Acme Ltd&#10;Example Widgets Inc"></textarea>
          <div class="add-companies-btns">
            <button id="list-lookup-btn" class="btn btn-primary btn-sm">Look up</button>
            <button id="upload-csv-btn" class="btn btn-secondary btn-sm">Upload CSV</button>
          </div>
        </div>
      </div>

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
              <option value="">Priority (high–low)</option>
              <option value="lead_score:asc">AI score (high–low)</option>
              <option value="lead_score:desc">AI score (low–high)</option>
              <option value="company:asc">Company A–Z</option>
              <option value="company:desc">Company Z–A</option>
              <option value="phone_number:asc">Phone first</option>
              <option value="status:asc">Status</option>
              <option value="industry:asc">Industry A–Z</option>
              <option value="contact_status:asc">Contact Status</option>
            </select>
          </div>
        </div>
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

      <div class="call-sheet-table-wrap">
        <table id="list-results-table" class="call-sheet-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="ccl-select-all-cb" title="Select all visible" /></th>
              <th>Called</th>
              <th></th>
              <th data-sort="company">Company</th>
              <th data-sort="phone_number">Phone</th>
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

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const overviewWrapper = container.querySelector<HTMLElement>("#ccl-overview-wrapper")!;
  const nameScreen = container.querySelector<HTMLDivElement>("#ccl-name-screen")!;
  const selectorEl = container.querySelector<HTMLDivElement>("#ccl-lead-selector")!;
  const detailEl = container.querySelector<HTMLDivElement>("#cold-call-list-detail")!;

  // Overview
  const myListsEl = container.querySelector<HTMLUListElement>("#my-lists")!;
  const myListsEmptyEl = container.querySelector<HTMLParagraphElement>("#my-lists-empty")!;
  const adminListsCard = container.querySelector<HTMLDivElement>("#admin-lists-card")!;
  const adminListsEl = container.querySelector<HTMLUListElement>("#admin-lists")!;

  // Name screen
  const nameBackBtn = container.querySelector<HTMLButtonElement>("#name-back-btn")!;
  const listNameInputScreen = container.querySelector<HTMLInputElement>("#list-name-input-screen")!;
  const nameNextBtn = container.querySelector<HTMLButtonElement>("#name-next-btn")!;
  const listForWrap = container.querySelector<HTMLDivElement>("#list-for-wrap")!;
  const listForSelect = container.querySelector<HTMLSelectElement>("#list-for-select")!;

  // Selector
  const selectorBackBtn = container.querySelector<HTMLButtonElement>("#selector-back-btn")!;
  const selectorListNameDisplay = container.querySelector<HTMLElement>("#selector-list-name-display")!;
  const selectorSearchInput = container.querySelector<HTMLInputElement>("#selector-search-input")!;
  const selectorBody = container.querySelector<HTMLTableSectionElement>("#selector-body")!;
  const selectorAllCb = container.querySelector<HTMLInputElement>("#selector-all-cb")!;
  const selectorPhoneBtns = container.querySelectorAll<HTMLButtonElement>(".sel-phone-btn");
  const selectorStatusBtns = container.querySelectorAll<HTMLButtonElement>(".sel-status-btn");
  const selectorSortSelect = container.querySelector<HTMLSelectElement>("#sel-sort-select")!;
  const selectorCreateBtn = container.querySelector<HTMLButtonElement>("#selector-create-btn")!;
  const selectorCountLabel = container.querySelector<HTMLSpanElement>("#selector-count-label")!;
  const selContactStatusSelect = container.querySelector<HTMLSelectElement>("#sel-contact-status-select")!;
  const selIndustryWrap = container.querySelector<HTMLDivElement>("#sel-industry-wrap")!;
  const selChargeWrap = container.querySelector<HTMLDivElement>("#sel-charge-wrap")!;

  // Call sheet
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
  const scoreListBtn = container.querySelector<HTMLButtonElement>("#score-list-btn")!;
  const sortSelect = container.querySelector<HTMLSelectElement>("#ccl-sort-select")!;
  const toggleAddBtn = container.querySelector<HTMLButtonElement>("#toggle-add-btn")!;
  const addCompaniesPanel = container.querySelector<HTMLDivElement>("#add-companies-panel")!;
  const phoneFilterBtns = container.querySelectorAll<HTMLButtonElement>(".ccl-phone-btn");

  // ── State ─────────────────────────────────────────────────────────────────
  let pendingListName = "";
  let pendingForUserId = "";

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
  let doneTodayCollapsed = true;

  // Selector state
  let selectorSearch = "";
  let selectorPhone: "all" | "has-phone" | "no-phone" = "all";
  let selectorStatus: Lead["status"] | "" = "";
  let selectorContactStatus = "";
  let selectorIndustries: string[] = [];
  let selectorChargeTypes: string[] = [];
  let selectorSort: SortColumn = null;
  let selectorSortDir: SortDirection = "asc";
  let selectorSelected = new Set<string>();
  let selectorLastIndex = -1;

  // Drag-select state
  let isDragging = false;
  let dragStartIdx = -1;
  let dragSelectValue = true;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function hasPhone(lead: Lead): boolean {
    return !!(lead.phone_number && lead.phone_number !== "not_found");
  }
  function hasCharges(lead: Lead): boolean {
    try { return JSON.parse(lead.ch_data || "{}").charges?.length > 0; } catch { return false; }
  }

  // ── Screen switching ──────────────────────────────────────────────────────
  function showOverview(): void {
    container.classList.remove("ccl-fullscreen");
    overviewWrapper.classList.remove("hidden");
    nameScreen.classList.add("hidden");
    selectorEl.classList.add("hidden");
    detailEl.classList.add("hidden");
    closeSidePanel();
  }

  function showNameScreen(): void {
    container.classList.add("ccl-fullscreen");
    overviewWrapper.classList.add("hidden");
    nameScreen.classList.remove("hidden");
    selectorEl.classList.add("hidden");
    detailEl.classList.add("hidden");
    listNameInputScreen.value = "";
    pendingListName = "";
    pendingForUserId = "";
    listForSelect.innerHTML = '<option value="">Myself</option>';
    if (isAdmin()) {
      void listTeamMembers().then((members) => {
        const current = getCurrentUser();
        const others = members.filter((m) => m.id !== current?.id);
        if (others.length > 0) {
          listForSelect.innerHTML =
            '<option value="">Myself</option>' +
            others.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join("");
          listForWrap.classList.remove("hidden");
        }
      });
    } else {
      listForWrap.classList.add("hidden");
    }
    setTimeout(() => listNameInputScreen.focus(), 50);
  }

  function showSelector(): void {
    container.classList.add("ccl-fullscreen");
    overviewWrapper.classList.add("hidden");
    nameScreen.classList.add("hidden");
    selectorEl.classList.remove("hidden");
    detailEl.classList.add("hidden");
  }

  function showDetail(): void {
    container.classList.add("ccl-fullscreen");
    overviewWrapper.classList.add("hidden");
    nameScreen.classList.add("hidden");
    selectorEl.classList.add("hidden");
    detailEl.classList.remove("hidden");
  }

  // ── Overview ──────────────────────────────────────────────────────────────
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

  // ── Name screen ───────────────────────────────────────────────────────────
  nameBackBtn.addEventListener("click", showOverview);

  function proceedToSelector(): void {
    const name = listNameInputScreen.value.trim();
    if (!name) { listNameInputScreen.focus(); return; }
    pendingListName = name;
    selectorListNameDisplay.textContent = `"${name}"`;
    openSelectorScreen();
  }

  nameNextBtn.addEventListener("click", proceedToSelector);
  listNameInputScreen.addEventListener("keydown", (e) => {
    if (e.key === "Enter") proceedToSelector();
  });
  listForSelect.addEventListener("change", () => { pendingForUserId = listForSelect.value; });

  // ── Selector ──────────────────────────────────────────────────────────────
  function renderIndustryMultiSelect(): void {
    const leads = getLeads();
    const industries = [...new Set(leads.map((l) => l.industry || "Uncategorized").filter(Boolean))].sort();
    const opts = industries.map((ind) => ({ value: ind, label: ind }));
    selIndustryWrap.innerHTML = buildMultiSelectHtml("sel-industry", opts, selectorIndustries, "Filter by industry…");
    bindMultiSelect(selIndustryWrap, "sel-industry", selectorIndustries, () => renderSelector());
  }

  function renderChargeTypeMultiSelect(): void {
    const opts = CHARGE_TYPES.map((t) => ({ value: t, label: t }));
    selChargeWrap.innerHTML = buildMultiSelectHtml("sel-charge", opts, selectorChargeTypes, "Filter by charge type…");
    bindMultiSelect(selChargeWrap, "sel-charge", selectorChargeTypes, () => renderSelector());
  }

  function applySelFilters(leads: Lead[]): Lead[] {
    const statusArg = selectorStatus || null;
    const hasCharges = selectorChargeTypes.length > 0;
    let filtered = filterLeads(leads, selectorSearch, new Set(selectorIndustries), statusArg as Lead["status"] | null, null, hasCharges, new Set(selectorChargeTypes));
    if (selectorContactStatus) filtered = filtered.filter((l) => l.contact_status === selectorContactStatus);
    if (selectorPhone === "has-phone") filtered = filtered.filter(hasPhone);
    else if (selectorPhone === "no-phone") filtered = filtered.filter((l) => !hasPhone(l));
    return sortLeadsStable(filtered, selectorSort, selectorSortDir);
  }

  function updateSelectorBtn(): void {
    const count = selectorSelected.size;
    selectorCountLabel.textContent = count > 0 ? `${count} selected` : "";
    selectorCreateBtn.classList.toggle("hidden", count === 0);
  }

  function renderSelector(): void {
    const sorted = applySelFilters(getLeads());
    if (sorted.length === 0) {
      selectorBody.innerHTML = `<tr><td colspan="${SELECTOR_COL_COUNT}" class="empty-state">No leads match your filters.</td></tr>`;
      updateSelectorBtn();
      return;
    }

    selectorBody.innerHTML = sorted.map((lead) => {
      const isSelected = selectorSelected.has(lead.id);
      let dirs: string[] = [];
      try { dirs = JSON.parse(lead.ch_data || "{}").directors || []; } catch { /* ignore */ }
      return `
        <tr class="lead-row selector-row${isSelected ? " lead-row-selected" : ""}" data-lead-id="${lead.id}">
          <td class="select-cell"><input type="checkbox" class="select-cb" ${isSelected ? "checked" : ""} /></td>
          <td>
            <div>${escapeHtml(lead.company)}</div>
            ${dirs.length > 0 ? `<div class="lead-directors">${escapeHtml(dirs.slice(0, 3).join(", "))}</div>` : ""}
          </td>
          <td>${hasPhone(lead) ? escapeHtml(lead.phone_number) : '<span class="empty-hint">—</span>'}</td>
          <td>${escapeHtml(lead.industry || "—")}</td>
          <td>${lead.list_name ? `<span class="status-badge list-badge">${escapeHtml(lead.list_name)}</span>` : '<span class="empty-hint">—</span>'}</td>
        </tr>
      `;
    }).join("");

    selectorBody.querySelectorAll<HTMLTableRowElement>(".selector-row").forEach((row, idx) => {
      const leadId = row.dataset.leadId!;
      const cb = row.querySelector<HTMLInputElement>(".select-cb")!;

      // ── Drag-to-select ──────────────────────────────────────────────────
      row.addEventListener("mousedown", (e) => {
        if ((e.target as HTMLElement).closest("input[type=checkbox]")) return;
        e.preventDefault();
        isDragging = true;
        dragStartIdx = idx;
        dragSelectValue = !selectorSelected.has(leadId);
        selectorEl.classList.add("selector-no-select");
        if (dragSelectValue) selectorSelected.add(leadId); else selectorSelected.delete(leadId);
        row.classList.toggle("lead-row-selected", dragSelectValue);
        cb.checked = dragSelectValue;
        selectorLastIndex = idx;
        updateSelectorBtn();
      });

      row.addEventListener("mouseover", () => {
        if (!isDragging) return;
        const allRows = Array.from(selectorBody.querySelectorAll<HTMLTableRowElement>(".selector-row"));
        const lo = Math.min(dragStartIdx, idx);
        const hi = Math.max(dragStartIdx, idx);
        for (let i = lo; i <= hi; i++) {
          const rid = allRows[i].dataset.leadId!;
          if (dragSelectValue) selectorSelected.add(rid); else selectorSelected.delete(rid);
          allRows[i].classList.toggle("lead-row-selected", dragSelectValue);
          const rcb = allRows[i].querySelector<HTMLInputElement>(".select-cb");
          if (rcb) rcb.checked = dragSelectValue;
        }
        updateSelectorBtn();
      });

      // ── Checkbox click (shift-range + normal toggle) ────────────────────
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        const selected = cb.checked;
        const allRows = Array.from(selectorBody.querySelectorAll<HTMLTableRowElement>(".selector-row"));
        if ((e as MouseEvent).shiftKey && selectorLastIndex >= 0) {
          const lo = Math.min(selectorLastIndex, idx);
          const hi = Math.max(selectorLastIndex, idx);
          for (let i = lo; i <= hi; i++) {
            const rid = allRows[i].dataset.leadId!;
            if (selected) selectorSelected.add(rid); else selectorSelected.delete(rid);
            allRows[i].classList.toggle("lead-row-selected", selected);
            const rcb = allRows[i].querySelector<HTMLInputElement>(".select-cb");
            if (rcb) rcb.checked = selected;
          }
        } else {
          if (selected) selectorSelected.add(leadId); else selectorSelected.delete(leadId);
          row.classList.toggle("lead-row-selected", selected);
          // Auto-advance: scroll the next row into view when selecting
          if (selected) {
            const nextRow = allRows[idx + 1];
            if (nextRow) nextRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
          }
        }
        selectorLastIndex = idx;
        updateSelectorBtn();
        const total = allRows.length;
        const selCount = allRows.filter((r) => selectorSelected.has(r.dataset.leadId!)).length;
        selectorAllCb.checked = selCount === total;
        selectorAllCb.indeterminate = selCount > 0 && selCount < total;
      });
    });

    const total = sorted.length;
    const selCount = sorted.filter((l) => selectorSelected.has(l.id)).length;
    selectorAllCb.checked = selCount === total && total > 0;
    selectorAllCb.indeterminate = selCount > 0 && selCount < total;
    updateSelectorBtn();
  }

  function openSelectorScreen(): void {
    selectorSearch = "";
    selectorPhone = "all";
    selectorStatus = "";
    selectorContactStatus = "";
    selectorIndustries = [];
    selectorChargeTypes = [];
    selectorSort = null;
    selectorSortDir = "asc";
    selectorSelected.clear();
    selectorLastIndex = -1;
    selectorSearchInput.value = "";
    selectorSortSelect.value = "";
    selContactStatusSelect.value = "";
    selectorPhoneBtns.forEach((b) => b.classList.toggle("active", b.dataset.phone === "all"));
    selectorStatusBtns.forEach((b) => b.classList.toggle("active", b.dataset.status === ""));
    showSelector();
    renderIndustryMultiSelect();
    renderChargeTypeMultiSelect();
    void refreshLeads().then(() => { renderIndustryMultiSelect(); renderSelector(); });
  }

  selectorBackBtn.addEventListener("click", showNameScreen);

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      selectorEl.classList.remove("selector-no-select");
    }
  });

  selectorSearchInput.addEventListener("input", () => {
    selectorSearch = selectorSearchInput.value;
    renderSelector();
  });

  selectorPhoneBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      selectorPhone = btn.dataset.phone as "all" | "has-phone" | "no-phone";
      selectorPhoneBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderSelector();
    });
  });

  selectorStatusBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      selectorStatus = btn.dataset.status as Lead["status"] | "";
      selectorStatusBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderSelector();
    });
  });

  selContactStatusSelect.addEventListener("change", () => {
    selectorContactStatus = selContactStatusSelect.value;
    renderSelector();
  });

  selectorSortSelect.addEventListener("change", () => {
    const val = selectorSortSelect.value;
    if (!val) { selectorSort = null; selectorSortDir = "asc"; }
    else { const [col, dir] = val.split(":") as [SortColumn, SortDirection]; selectorSort = col; selectorSortDir = dir || "asc"; }
    renderSelector();
  });

  selectorAllCb.addEventListener("change", () => {
    const allRows = Array.from(selectorBody.querySelectorAll<HTMLTableRowElement>(".selector-row"));
    allRows.forEach((row) => {
      const rid = row.dataset.leadId!;
      if (selectorAllCb.checked) selectorSelected.add(rid); else selectorSelected.delete(rid);
      row.classList.toggle("lead-row-selected", selectorAllCb.checked);
      const cb = row.querySelector<HTMLInputElement>(".select-cb");
      if (cb) cb.checked = selectorAllCb.checked;
    });
    updateSelectorBtn();
  });

  selectorCreateBtn.addEventListener("click", () => void confirmCreateList());

  function showConflictDialog(conflicted: Lead[]): Promise<"move" | "skip" | "cancel"> {
    return new Promise((resolve) => {
      const byList: Record<string, number> = {};
      for (const l of conflicted) {
        const name = l.list_name || "Unknown list";
        byList[name] = (byList[name] || 0) + 1;
      }
      const listLines = Object.entries(byList)
        .map(([name, count]) => `<li>"${escapeHtml(name)}" — ${count} lead${count === 1 ? "" : "s"}</li>`)
        .join("");
      const overlay = document.createElement("div");
      overlay.className = "conflict-modal-overlay";
      overlay.innerHTML = `
        <div class="conflict-modal">
          <h3 class="conflict-modal-title">Some leads are already in a list</h3>
          <p class="conflict-modal-desc">${conflicted.length} selected lead${conflicted.length === 1 ? " is" : "s are"} already assigned to:</p>
          <ul class="conflict-modal-list">${listLines}</ul>
          <p class="conflict-modal-question">What would you like to do?</p>
          <div class="conflict-modal-actions">
            <button id="conflict-move-btn" class="btn btn-primary btn-sm">Move to new list</button>
            <button id="conflict-skip-btn" class="btn btn-secondary btn-sm">Skip these leads</button>
            <button id="conflict-cancel-btn" class="btn btn-ghost btn-sm">Cancel</button>
          </div>
          <p class="conflict-modal-hint">
            <strong>Move</strong> — reassign them to this new list.
            <strong>Skip</strong> — only add the ${selectorSelected.size - conflicted.length} unassigned leads.
          </p>
        </div>
      `;
      document.body.appendChild(overlay);
      const cleanup = (result: "move" | "skip" | "cancel") => {
        document.body.removeChild(overlay);
        resolve(result);
      };
      overlay.querySelector("#conflict-move-btn")!.addEventListener("click", () => cleanup("move"));
      overlay.querySelector("#conflict-skip-btn")!.addEventListener("click", () => cleanup("skip"));
      overlay.querySelector("#conflict-cancel-btn")!.addEventListener("click", () => cleanup("cancel"));
    });
  }

  async function confirmCreateList(): Promise<void> {
    const ids = Array.from(selectorSelected);
    if (ids.length === 0 || !pendingListName) return;

    const allLeads = getLeads();
    const conflicted = allLeads.filter((l) => selectorSelected.has(l.id) && l.list_name);
    if (conflicted.length > 0) {
      const action = await showConflictDialog(conflicted);
      if (action === "cancel") return;
      if (action === "skip") {
        conflicted.forEach((l) => selectorSelected.delete(l.id));
        if (selectorSelected.size === 0) return;
      }
    }

    const finalIds = Array.from(selectorSelected);
    selectorCreateBtn.disabled = true;
    selectorCreateBtn.textContent = "Creating…";
    try {
      const list = await createLeadList(pendingListName, pendingForUserId || undefined);
      await addLeadsToList(list.id, finalIds);
      await refreshLeadLists();
      await openListDetail(list.id);
    } catch (err) {
      alert(`Failed to create list: ${err}`);
      selectorCreateBtn.disabled = false;
      selectorCreateBtn.textContent = "Create list";
    }
  }

  // ── Call sheet ────────────────────────────────────────────────────────────
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

  function isEnriched(lead: Lead): boolean {
    try { const d = JSON.parse(lead.ch_data || "{}"); return !!d.company_number && !d.not_found; } catch { return false; }
  }

  function renderListTable(): void {
    refreshIfOpen(currentListLeads);
    updateSortIndicators();

    if (currentListLeads.length === 0) {
      renderEmptyState(listResultsBody, "No leads yet — add companies above.", CALL_SHEET_COL_COUNT);
      return;
    }

    const now = new Date();
    const isFollowUpDue = (l: Lead) => !!l.follow_up_at && new Date(l.follow_up_at) <= now;

    let filtered = filterLeads(currentListLeads, searchText, new Set());
    if (scopeFilter === "this-list") filtered = filtered.filter((l) => l.list_id === currentListId);
    else if (scopeFilter === "unassigned") filtered = filtered.filter((l) => !l.list_id);
    if (calledFilter === "called") filtered = filtered.filter((l) => !!l.called_at);
    else if (calledFilter === "not-called") filtered = filtered.filter((l) => !l.called_at);
    else if (calledFilter === "follow-up") filtered = filtered.filter(isFollowUpDue);
    if (phoneFilter === "has-phone") filtered = filtered.filter(hasPhone);
    else if (phoneFilter === "no-phone") filtered = filtered.filter((l) => !hasPhone(l));
    if (enrichFilter === "has-charges") filtered = filtered.filter(hasCharges);
    else if (enrichFilter === "enriched") filtered = filtered.filter(isEnriched);
    else if (enrichFilter === "not-enriched") filtered = filtered.filter((l) => !isEnriched(l));

    // Default order = deterministic priority (highest-value first) so the next
    // best lead sits at the top; an explicit sort choice overrides it. The
    // priority_score comparator already returns high-first, so "asc" (multiplier
    // +1) preserves that — same convention the AI lead_score sort uses.
    const effectiveCol: SortColumn = sortColumn ?? "priority_score";
    const effectiveDir: SortDirection = sortColumn ? sortDirection : "asc";
    const sorted = sortLeadsStable(filtered, effectiveCol, effectiveDir);

    // Leads called TODAY drop into a "Done today" group at the bottom, so the
    // active queue always advances to the next un-worked lead automatically.
    const isDoneToday = (l: Lead) => {
      if (!l.called_at) return false;
      const d = new Date(l.called_at);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    };
    const doneToday = sorted.filter(isDoneToday);
    const active = sorted.filter((l) => !isDoneToday(l));
    const activeOrdered = [...active.filter(isFollowUpDue), ...active.filter((l) => !isFollowUpDue(l))];
    const visible = [...activeOrdered, ...doneToday];

    if (visible.length === 0) {
      renderEmptyState(listResultsBody, "No leads match your filters.", CALL_SHEET_COL_COUNT);
      return;
    }

    renderRows(listResultsBody, visible, {
      onRowClick: (lead) => { setSidePanelCallbacks(listSidePanelCallbacks); openSidePanel(lead); },
      onIndustryChange: async (lead, value) => { await updateLead(lead.id, { industry: value }); await refreshCurrentList(); },
      onContactStatusChange: async (lead, value) => { await updateLead(lead.id, { contactStatus: value }); await refreshCurrentList(); },
      onToggleContacted: async (lead) => {
        const next = lead.contact_status === CONTACT_STATUS_ORDER[0] ? "Contacted" : CONTACT_STATUS_ORDER[0];
        await updateLead(lead.id, { contactStatus: next }); await refreshCurrentList();
      },
      onToggleCalled: async (lead) => {
        if (!currentListId) return;
        await toggleListLeadCalled(currentListId, lead.id); await refreshCurrentList();
      },
      onLogOutcome: async (lead, outcome) => {
        if (!currentListId || outcome === "__called__") return;
        if (outcome === "") {
          // Clear the called state — lead returns to the active queue.
          if (lead.called_at) await toggleListLeadCalled(currentListId, lead.id);
          await refreshCurrentList();
          return;
        }
        try { await createCallLog(lead.id, outcome as CallOutcome, ""); } catch { /* history is non-critical */ }
        if (!lead.called_at) await toggleListLeadCalled(currentListId, lead.id);
        // They answered → advance a fresh lead out of "New" automatically.
        if (outcome === "connected" && lead.contact_status === CONTACT_STATUS_ORDER[0]) {
          await updateLead(lead.id, { contactStatus: "Contacted" });
        }
        await refreshCurrentList();
      },
      onToggleSelect: (lead, selected, shiftKey) => {
        const currentIndex = visible.findIndex((l) => l.id === lead.id);
        if (shiftKey && lastToggledIndex >= 0) {
          const lo = Math.min(lastToggledIndex, currentIndex);
          const hi = Math.max(lastToggledIndex, currentIndex);
          for (let i = lo; i <= hi; i++) {
            if (selected) selectedLeadIds.add(visible[i].id);
            else selectedLeadIds.delete(visible[i].id);
            const r = listResultsBody.querySelector<HTMLTableRowElement>(`[data-lead-id="${visible[i].id}"]`);
            if (r) { r.classList.toggle("lead-row-selected", selected); const cb = r.querySelector<HTMLInputElement>(".select-cb"); if (cb) cb.checked = selected; }
          }
        } else {
          if (selected) selectedLeadIds.add(lead.id); else selectedLeadIds.delete(lead.id);
          const row = listResultsBody.querySelector<HTMLTableRowElement>(`[data-lead-id="${lead.id}"]`);
          if (row) row.classList.toggle("lead-row-selected", selected);
        }
        lastToggledIndex = currentIndex;
        updateBulkBar(visible);
      },
      onGenerateEmail: (lead) => { setPendingEmailWriterLead(lead.id); openTab("outreach", "Outreach"); },
      onSendFollowUp: (lead) => { openFollowUpModal(lead); },
      onLookupPhone: (lead) => { void lookupCompanyPhone(lead.company, currentListId ?? undefined).then(() => refreshCurrentList()); },
      onSaveNotes: async (lead, notes) => {
        await updateLead(lead.id, { leadNotes: notes });
        const idx = currentListLeads.findIndex((l) => l.id === lead.id);
        if (idx >= 0) currentListLeads[idx] = { ...currentListLeads[idx], notes };
      },
      showListColumn: true,
      showPriority: true,
    }, selectedLeadIds);

    // "Done today" divider: a collapsible section that fills as calls are logged.
    if (doneToday.length > 0) {
      const firstDone = listResultsBody.querySelector<HTMLTableRowElement>(`[data-lead-id="${doneToday[0].id}"]`);
      const divider = document.createElement("tr");
      divider.className = "done-today-divider";
      divider.innerHTML = `<td colspan="${CALL_SHEET_COL_COUNT}">
        <button type="button" class="done-today-toggle">
          <span class="done-today-caret">${doneTodayCollapsed ? "▸" : "▾"}</span> Done today (${doneToday.length})
        </button></td>`;
      if (firstDone) listResultsBody.insertBefore(divider, firstDone);
      for (const l of doneToday) {
        const r = listResultsBody.querySelector<HTMLTableRowElement>(`[data-lead-id="${l.id}"]`);
        if (r) r.classList.toggle("done-today-row-hidden", doneTodayCollapsed);
      }
      divider.querySelector<HTMLButtonElement>(".done-today-toggle")?.addEventListener("click", () => {
        doneTodayCollapsed = !doneTodayCollapsed;
        renderListTable();
      });
    }

    updateBulkBar(visible);
  }

  async function refreshCurrentList(): Promise<void> {
    if (!currentListId) return;
    currentListLeads = await getLogEntries();
    renderListTable();
  }

  // One-click "Send follow-up": drafts from the lead's call notes + previous
  // emails (backend), then an inline review-and-send from the rep's own account.
  async function openFollowUpModal(lead: Lead): Promise<void> {
    const overlay = document.createElement("div");
    overlay.className = "follow-up-overlay";
    overlay.innerHTML = `
      <div class="follow-up-modal" role="dialog" aria-modal="true">
        <div class="follow-up-modal-head">
          <h3>Follow-up · ${escapeHtml(lead.company)}</h3>
          <button class="follow-up-close icon-btn" type="button" title="Close">✕</button>
        </div>
        <div class="follow-up-body">
          <div class="follow-up-loading">Drafting a follow-up from your call notes and previous emails…</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector<HTMLButtonElement>(".follow-up-close")!.addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    let draft: EmailDraft;
    try {
      draft = await generateFollowUpDraft(lead.id);
    } catch (err) {
      const body = overlay.querySelector<HTMLDivElement>(".follow-up-body")!;
      body.innerHTML = `<div class="follow-up-error">${escapeHtml(String(err))}</div>`;
      return;
    }

    const accounts = await listEmailOAuthAccounts().catch(() => [] as EmailOAuthAccount[]);
    const existingEmail = lead.emails[0]?.email ?? "";

    const body = overlay.querySelector<HTMLDivElement>(".follow-up-body")!;
    body.innerHTML = `
      <label class="follow-up-field"><span>To</span>
        <input class="fu-to search-input" type="email" placeholder="${existingEmail ? "" : "No email on file — add one to send"}" />
      </label>
      <label class="follow-up-field"><span>Subject</span>
        <input class="fu-subject search-input" type="text" />
      </label>
      <label class="follow-up-field"><span>Message</span>
        <textarea class="fu-body" rows="11"></textarea>
      </label>
      <div class="follow-up-actions">
        <div class="follow-up-provider">
          ${accounts.length > 0
            ? `<span>Send from</span><select class="fu-provider search-input">${accounts
                .map((a) => `<option value="${a.provider}">${escapeHtml(a.email_address)}</option>`)
                .join("")}</select>`
            : `<span class="follow-up-hint">Connect a Gmail or Microsoft account in Settings to send.</span>`}
        </div>
        <div class="follow-up-buttons">
          <button class="btn btn-ghost btn-sm fu-cancel" type="button">Close</button>
          <button class="btn btn-primary btn-sm fu-send" type="button" ${accounts.length === 0 ? "disabled" : ""}>Send</button>
        </div>
      </div>
      <div class="fu-status status-message"></div>`;

    const toInput = body.querySelector<HTMLInputElement>(".fu-to")!;
    const subjectInput = body.querySelector<HTMLInputElement>(".fu-subject")!;
    const bodyTextarea = body.querySelector<HTMLTextAreaElement>(".fu-body")!;
    const providerSelect = body.querySelector<HTMLSelectElement>(".fu-provider");
    const sendBtn = body.querySelector<HTMLButtonElement>(".fu-send")!;
    const statusEl = body.querySelector<HTMLDivElement>(".fu-status")!;

    subjectInput.value = draft.subject;
    bodyTextarea.value = draft.body;
    if (existingEmail) { toInput.value = existingEmail; toInput.readOnly = true; }

    body.querySelector<HTMLButtonElement>(".fu-cancel")!.addEventListener("click", close);

    sendBtn.addEventListener("click", async () => {
      const provider = providerSelect?.value as EmailProvider | undefined;
      if (!provider) return;
      let recipient = existingEmail;
      const typed = toInput.value.trim();
      if (!recipient) {
        if (!typed) { statusEl.textContent = "Add a recipient email address first."; return; }
        recipient = typed;
      }
      sendBtn.disabled = true;
      statusEl.textContent = "Sending…";
      try {
        await updateEmailDraft(draft.id, { subject: subjectInput.value, body: bodyTextarea.value });
        if (!existingEmail && typed) { await addLeadEmail(lead.id, typed).catch(() => {}); }
        await sendEmailDraft(draft.id, provider);
        statusEl.textContent = "Sent ✓";
        await refreshCurrentList();
        setTimeout(close, 900);
      } catch (err) {
        statusEl.textContent = `Send failed: ${err}`;
        sendBtn.disabled = false;
      }
    });
  }

  const listSidePanelCallbacks: SidePanelCallbacks = {
    onSaveNotes: async (id, notes) => { await updateLead(id, { leadNotes: notes }); await refreshCurrentList(); },
    onAssign: async (id, uid) => { await assignLead(id, uid); await refreshCurrentList(); },
    onSetShared: async (id, isShared) => { await setLeadShared(id, isShared); await refreshCurrentList(); },
    onSaveDetails: async (id, contactName, contactTitle, website, linkedin) => { await updateLead(id, { contactName, contactTitle, website, linkedin }); await refreshCurrentList(); },
    onAddPhone: async (id, phoneNumber) => { await addLeadPhone(id, phoneNumber); await refreshCurrentList(); },
    onUpdatePhone: async (id, phoneId, phoneNumber) => { await updateLeadPhone(id, phoneId, phoneNumber); await refreshCurrentList(); },
    onDeletePhone: async (id, phoneId) => { await deleteLeadPhone(id, phoneId); await refreshCurrentList(); },
    onAddEmail: async (id, email) => { await addLeadEmail(id, email); await refreshCurrentList(); },
    onUpdateEmail: async (id, emailId, email) => { await updateLeadEmail(id, emailId, email); await refreshCurrentList(); },
    onDeleteEmail: async (id, emailId) => { await deleteLeadEmail(id, emailId); await refreshCurrentList(); },
    onScrapeEmail: async (id) => { await scrapeLeadEmail(id); await refreshCurrentList(); },
    onGenerateIntelligence: async (id) => { await generateLeadIntelligence(id); await refreshCurrentList(); },
  };

  container.querySelectorAll<HTMLButtonElement>(".ccl-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      calledFilter = btn.dataset.called as "all" | "called" | "not-called" | "follow-up";
      container.querySelectorAll(".ccl-filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLeadIds.clear(); lastToggledIndex = -1; renderListTable();
    });
  });

  phoneFilterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      phoneFilter = btn.dataset.phone as "all" | "has-phone" | "no-phone";
      phoneFilterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLeadIds.clear(); lastToggledIndex = -1; renderListTable();
    });
  });

  enrichFilterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      enrichFilter = btn.dataset.enrich as "all" | "enriched" | "has-charges" | "not-enriched";
      enrichFilterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLeadIds.clear(); lastToggledIndex = -1; renderListTable();
    });
  });

  sortSelect.addEventListener("change", () => {
    const val = sortSelect.value;
    if (!val) { sortColumn = null; sortDirection = "asc"; }
    else { const [col, dir] = val.split(":") as [SortColumn, SortDirection]; sortColumn = col; sortDirection = dir; }
    renderListTable();
  });

  deleteListBtn.addEventListener("click", async () => {
    if (!currentListId) return;
    const listName = listDetailTitle.textContent || "this list";
    if (!confirm(`Delete "${listName}"? Leads will be kept in Results (unassigned).`)) return;
    try { await deleteLeadList(currentListId); showOverview(); void refreshLeadLists(); }
    catch (err) { alert(`Failed to delete list: ${err}`); }
  });

  selectAllCb.addEventListener("change", () => {
    const visible = Array.from(listResultsBody.querySelectorAll<HTMLTableRowElement>("[data-lead-id]")).map((r) => r.dataset.leadId!);
    if (selectAllCb.checked) visible.forEach((id) => selectedLeadIds.add(id));
    else visible.forEach((id) => selectedLeadIds.delete(id));
    visible.forEach((id) => {
      const row = listResultsBody.querySelector<HTMLTableRowElement>(`[data-lead-id="${id}"]`);
      if (row) { row.classList.toggle("lead-row-selected", selectAllCb.checked); const cb = row.querySelector<HTMLInputElement>(".select-cb"); if (cb) cb.checked = selectAllCb.checked; }
    });
    updateBulkBar();
  });

  bulkClearBtn.addEventListener("click", () => {
    selectedLeadIds.clear(); lastToggledIndex = -1; closeGenerateForm();
    listResultsBody.querySelectorAll<HTMLTableRowElement>("[data-lead-id]").forEach((r) => {
      r.classList.remove("lead-row-selected");
      const cb = r.querySelector<HTMLInputElement>(".select-cb"); if (cb) cb.checked = false;
    });
    updateBulkBar();
  });

  bulkCalledBtn.addEventListener("click", async () => {
    if (!currentListId || selectedLeadIds.size === 0) return;
    bulkCalledBtn.disabled = true;
    await Promise.all(Array.from(selectedLeadIds).map((id) => toggleListLeadCalled(currentListId!, id).catch(() => {})));
    selectedLeadIds.clear(); await refreshCurrentList(); bulkCalledBtn.disabled = false;
  });

  bulkAddBtn.addEventListener("click", async () => {
    if (!currentListId || selectedLeadIds.size === 0) return;
    bulkAddBtn.disabled = true;
    try {
      const result = await addLeadsToList(currentListId, Array.from(selectedLeadIds));
      selectedLeadIds.clear(); lastToggledIndex = -1; await refreshCurrentList();
      if (result.skipped > 0) {
        const names = result.skipped_details.map((d) => `${d.company} (already in "${d.list_name}")`).join("\n");
        alert(`${result.added} added.\n\n${result.skipped} skipped — already in another list:\n${names}`);
      }
    } catch (err) { alert(`Failed to add leads: ${err}`); }
    bulkAddBtn.disabled = false;
  });

  findPhonesBtn.addEventListener("click", async () => {
    if (!currentListId) return;
    const missing = currentListLeads.filter((l) => l.list_id === currentListId && (!l.phone_number || l.phone_number === "not_found"));
    if (missing.length === 0) { listDetailStatus.textContent = "All leads already have phone numbers."; setTimeout(() => { listDetailStatus.textContent = ""; }, 3000); return; }
    const estimatedCost = (missing.length * 0.03).toFixed(2);
    if (!confirm(`Find phone numbers for ${missing.length} lead${missing.length === 1 ? "" : "s"} without a number?\n\nEstimated cost: ~£${estimatedCost}`)) return;
    findPhonesBtn.disabled = true;
    for (let i = 0; i < missing.length; i++) {
      listDetailStatus.textContent = `Looking up ${missing[i].company} (${i + 1}/${missing.length})...`;
      try { await lookupCompanyPhone(missing[i].company, currentListId); await refreshCurrentList(); } catch { /* continue */ }
    }
    listDetailStatus.textContent = ""; findPhonesBtn.disabled = false; await refreshLeadLists();
  });

  scoreListBtn.addEventListener("click", async () => {
    if (!currentListId) return;
    scoreListBtn.disabled = true;
    listDetailStatus.textContent = "Scoring leads…";
    try {
      const scored = await scoreLeadList(currentListId);
      await refreshCurrentList();
      listDetailStatus.textContent = `Scored ${scored} lead${scored === 1 ? "" : "s"} — highest-value first.`;
    } catch (err) {
      listDetailStatus.textContent = `Scoring failed: ${err}`;
    }
    scoreListBtn.disabled = false;
    setTimeout(() => { listDetailStatus.textContent = ""; }, 4000);
  });

  toggleAddBtn.addEventListener("click", () => {
    const isHidden = addCompaniesPanel.classList.toggle("hidden");
    toggleAddBtn.textContent = isHidden ? "+ Add companies" : "− Add companies";
  });

  function openGenerateForm(): void { generateForm.classList.remove("hidden"); bulkGenerateBtn.classList.add("hidden"); generateNameInput.value = ""; generateNameInput.focus(); }
  function closeGenerateForm(): void { generateForm.classList.add("hidden"); bulkGenerateBtn.classList.remove("hidden"); }

  async function submitGenerateList(): Promise<void> {
    const name = generateNameInput.value.trim();
    if (!name) return;
    generateConfirmBtn.disabled = true; generateConfirmBtn.textContent = "Creating...";
    const ids = Array.from(selectedLeadIds);
    try {
      const list = await createLeadList(name);
      await addLeadsToList(list.id, ids);
      await refreshLeadLists();
      selectedLeadIds.clear(); lastToggledIndex = -1; closeGenerateForm();
      await openListDetail(list.id);
    } catch (err) { alert(`Failed to create call list: ${err}`); }
    generateConfirmBtn.disabled = false; generateConfirmBtn.textContent = "Create";
  }

  bulkGenerateBtn.addEventListener("click", openGenerateForm);
  generateCancelBtn.addEventListener("click", closeGenerateForm);
  generateConfirmBtn.addEventListener("click", () => void submitGenerateList());
  generateNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void submitGenerateList(); if (e.key === "Escape") closeGenerateForm(); });

  scopeFilterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      scopeFilter = btn.dataset.scope as "all" | "this-list" | "unassigned";
      scopeFilterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedLeadIds.clear(); lastToggledIndex = -1; renderListTable();
    });
  });

  async function openListDetail(listId: string): Promise<void> {
    currentListId = listId;
    sortColumn = null; sortDirection = "asc"; searchText = "";
    calledFilter = "all"; enrichFilter = "all"; scopeFilter = "all"; phoneFilter = "all";
    selectedLeadIds.clear(); lastToggledIndex = -1;
    container.querySelectorAll(".ccl-filter-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.called === "all"));
    enrichFilterBtns.forEach((b) => b.classList.toggle("active", b.dataset.enrich === "all"));
    scopeFilterBtns.forEach((b) => b.classList.toggle("active", b.dataset.scope === "all"));
    phoneFilterBtns.forEach((b) => b.classList.toggle("active", b.dataset.phone === "all"));
    sortSelect.value = ""; listSearchInput.value = ""; listDetailStatus.textContent = "";
    addCompaniesPanel.classList.add("hidden"); toggleAddBtn.textContent = "+ Add companies";
    listDetailTitle.textContent = getLeadLists().find((l) => l.id === listId)?.name ?? "List";
    showDetail();
    renderSkeletonRows(listResultsBody, 5, CALL_SHEET_COL_COUNT);
    await refreshCurrentList();
  }

  container.querySelector("#back-to-lists-btn")!.addEventListener("click", () => {
    currentListId = null;
    showOverview();
    void refreshLeadLists();
  });

  subscribeLeadLists(renderOverview);
  subscribeAuth(() => { if (!getCurrentUser()) return; void refreshLeadLists(); });

  container.querySelector("#new-list-btn")!.addEventListener("click", showNameScreen);

  listSearchInput.addEventListener("input", () => { searchText = listSearchInput.value; renderListTable(); });

  sortableHeaders.forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort as SortColumn;
      if (sortColumn === col) sortDirection = sortDirection === "asc" ? "desc" : "asc";
      else { sortColumn = col; sortDirection = "asc"; }
      renderListTable();
    });
  });

  listLookupBtn.addEventListener("click", () => {
    const companies = listCompaniesInput.value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (companies.length > 0) { listCompaniesInput.value = ""; void runListLookups(companies); }
  });

  container.querySelector("#upload-csv-btn")!.addEventListener("click", async () => {
    if (!currentListId) return;
    const path = await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (typeof path !== "string") return;
    listDetailStatus.textContent = "Importing...";
    try {
      const imported = await importLeadsCsv(currentListId, path);
      listDetailStatus.textContent = `Imported ${imported} lead(s).`;
      await refreshCurrentList(); await refreshLeadLists();
    } catch (err) { listDetailStatus.textContent = `Import failed: ${err}`; }
  });

  async function runListLookups(companies: string[]): Promise<void> {
    if (!currentListId) return;
    listLookupBtn.disabled = true;
    for (const company of companies) {
      listDetailStatus.textContent = `Looking up ${company}...`;
      try { await lookupCompanyPhone(company, currentListId); await refreshCurrentList(); }
      catch (err) { listDetailStatus.textContent = `Error: ${err}`; }
    }
    listDetailStatus.textContent = ""; listLookupBtn.disabled = false; await refreshLeadLists();
  }
}
