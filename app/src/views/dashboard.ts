import { open, save } from "@tauri-apps/plugin-dialog";
import {
  type Lead,
  type SavedView,
  addLeadEmail,
  addLeadPhone,
  addLeadTag,
  assignLead,
  chEnrichAll,
  chEnrichAuto,
  chEnrichStatus,
  chEnrichStop,
  createSavedView,
  dedupLeads,
  deleteLeadEmail,
  deleteLeadPhone,
  deleteLeadTag,
  deleteSavedView,
  exportLogCsv,
  generateLeadIntelligence,
  getBatchActivitySummaries,
  importLeadsToDashboard,
  listSavedViews,
  lookupCompanyPhone,
  scrapeLeadEmail,
  updateLead,
  updateLeadEmail,
  updateLeadPhone,
} from "../api";
import { openActivityModal, updatePulseDots } from "../components/activityModal";
import { getCurrentUser, subscribeAuth } from "../auth";
import { consumePendingDashboardContactStatusFilter } from "../dashboardFilterHandoff";
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
  getHasChargesFilter,
  getSelectedChargeTypes,
  getSelectedIndustries,
  initFiltersToggle,
  renderIndustrySidebar,
  setChargesFilter,
  setIndustryFilter,
  subscribeIndustryFilter,
} from "../components/industryFilter";
import { confirmDialog, openOverlay } from "../components/modal";
import {
  initSidePanel,
  openSidePanel,
  refreshIfOpen,
  setSidePanelCallbacks,
  setTeamMembers,
  type SidePanelCallbacks,
} from "../components/sidePanel";
import { CONTACT_STATUS_ORDER } from "../constants";
import { setPendingEmailWriterLead } from "../emailWriterHandoff";
import { getDefaultContactStatus } from "../preferences";
import { getLeads, refreshLeads, subscribe } from "../state";
import { getTeamMembers, refreshTeamMembers, subscribeTeam } from "../team";
import { getActiveTabId, openTab, subscribeTabs } from "../tabs";
import { showToast } from "../toast";
import { escapeHtml } from "../utils";

export function initDashboard(): void {
  const companiesInput = document.querySelector<HTMLTextAreaElement>("#companies")!;
  const lookupBtn = document.querySelector<HTMLButtonElement>("#lookup-btn")!;
  const importCsvBtn = document.querySelector<HTMLButtonElement>("#import-csv-btn")!;
  const enrichBtn = document.querySelector<HTMLButtonElement>("#enrich-btn")!;
  const autoEnrichBtn = document.querySelector<HTMLButtonElement>("#auto-enrich-btn")!;
  const enrichProgress = document.querySelector<HTMLDivElement>("#enrich-progress")!;
  const enrichProgressFill = document.querySelector<HTMLDivElement>("#enrich-progress-fill")!;
  const enrichProgressLabel = document.querySelector<HTMLSpanElement>("#enrich-progress-label")!;
  const exportBtn = document.querySelector<HTMLButtonElement>("#export-btn")!;
  const refreshBtn = document.querySelector<HTMLButtonElement>("#refresh-btn")!;
  const searchInput = document.querySelector<HTMLInputElement>("#search-input")!;
  const resultsBody = document.querySelector<HTMLTableSectionElement>("#results-body")!;
  const statusMessage = document.querySelector<HTMLSpanElement>("#status-message")!;
  const statTotal = document.querySelector<HTMLSpanElement>("#stat-total")!;
  const statVerified = document.querySelector<HTMLSpanElement>("#stat-verified")!;
  const statUnverified = document.querySelector<HTMLSpanElement>("#stat-unverified")!;
  const statNotFound = document.querySelector<HTMLSpanElement>("#stat-not_found")!;
  const industrySidebar = document.querySelector<HTMLElement>("#industry-sidebar")!;
  const viewsToggleBtn = document.querySelector<HTMLButtonElement>("#views-toggle-btn")!;
  const viewsPopover = document.querySelector<HTMLElement>("#views-popover")!;
  const sortableHeaders = document.querySelectorAll<HTMLTableCellElement>("#results-table th[data-sort]");
  const statCards = document.querySelectorAll<HTMLDivElement>(".stats-grid .stat-card[data-status-filter]");

  let sortColumn: SortColumn = null;
  let sortDirection: SortDirection = "asc";
  let searchText = "";
  let isInitialLoad = true;
  let statusFilter: Lead["status"] | null = null;
  let contactStatusMinRank: number | null = null;
  let dashPhoneFilter: "all" | "has-phone" | "no-phone" = "all";
  let dashEnrichFilter: "all" | "has-charges" | "enriched" | "not-enriched" = "all";
  let savedViews: SavedView[] = [];

  // Animates a stat card's number from its current displayed value to the
  // new one — purely cosmetic, runs once per data refresh, cheap (a single
  // short rAF loop per call, four numbers total).
  const statAnimations = new WeakMap<HTMLElement, number>();
  function animateStatValue(el: HTMLElement, target: number): void {
    const from = Number(el.textContent) || 0;
    if (from === target) return;
    const existing = statAnimations.get(el);
    if (existing) cancelAnimationFrame(existing);
    const start = performance.now();
    const duration = 500;
    const tick = (now: number): void => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = String(Math.round(from + (target - from) * eased));
      if (progress < 1) {
        statAnimations.set(el, requestAnimationFrame(tick));
      } else {
        statAnimations.delete(el);
      }
    };
    statAnimations.set(el, requestAnimationFrame(tick));
  }

  function updateStats(): void {
    const leads = getLeads();
    animateStatValue(statTotal, leads.length);
    animateStatValue(statVerified, leads.filter((l) => l.status === "verified").length);
    animateStatValue(statUnverified, leads.filter((l) => l.status === "unverified").length);
    animateStatValue(statNotFound, leads.filter((l) => l.status === "not_found").length);
  }

  function updateSortIndicators(): void {
    sortableHeaders.forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.sort === sortColumn) {
        th.classList.add(sortDirection === "asc" ? "sorted-asc" : "sorted-desc");
      }
    });
  }

  async function handleIndustryChange(lead: Lead, value: string): Promise<void> {
    await updateLead(lead.id, { industry: value });
    await refreshLeads();
  }

  async function handleContactStatusChange(lead: Lead, value: string): Promise<void> {
    await updateLead(lead.id, { contactStatus: value });
    await refreshLeads();
  }

  function renderTable(): void {
    const leads = getLeads();
    renderIndustrySidebar(industrySidebar, leads);
    updateStats();
    updateSortIndicators();
    refreshIfOpen(leads);

    if (isInitialLoad) {
      renderSkeletonRows(resultsBody, 4);
      return;
    }
    if (leads.length === 0) {
      renderEmptyState(resultsBody, "No leads yet — run a lookup above to get started.");
      return;
    }
    let filtered = filterLeads(leads, searchText, getSelectedIndustries(), statusFilter, contactStatusMinRank, getHasChargesFilter(), getSelectedChargeTypes());
    if (dashPhoneFilter === "has-phone") filtered = filtered.filter((l) => !!(l.phone_number && l.phone_number !== "not_found"));
    else if (dashPhoneFilter === "no-phone") filtered = filtered.filter((l) => !l.phone_number || l.phone_number === "not_found");
    if (dashEnrichFilter === "has-charges") {
      filtered = filtered.filter((l) => { try { return JSON.parse(l.ch_data || "{}").charges?.length > 0; } catch { return false; } });
    } else if (dashEnrichFilter === "enriched") {
      filtered = filtered.filter((l) => { try { const d = JSON.parse(l.ch_data || "{}"); return !!d.company_number && !d.not_found; } catch { return false; } });
    } else if (dashEnrichFilter === "not-enriched") {
      filtered = filtered.filter((l) => { try { const d = JSON.parse(l.ch_data || "{}"); return !d.company_number || !!d.not_found; } catch { return true; } });
    }
    const visible = sortLeadsStable(filtered, sortColumn, sortDirection);
    if (visible.length === 0) {
      renderEmptyState(resultsBody, "No leads match the current filters.");
      return;
    }
    renderRows(resultsBody, visible, {
      onRowClick: (lead) => {
        setSidePanelCallbacks(dashboardSidePanelCallbacks);
        openSidePanel(lead);
      },
      onIndustryChange: handleIndustryChange,
      onContactStatusChange: handleContactStatusChange,
      onGenerateEmail: (lead) => {
        setPendingEmailWriterLead(lead.id);
        openTab("outreach", "Outreach");
      },
      onActivityClick: (lead) => openActivityModal(lead),
    });

    // Batch-load activity summaries after rows are in the DOM — dots start grey,
    // then upgrade their pulse class once data arrives.
    const leadIds = visible.map((l) => l.id);
    void getBatchActivitySummaries(leadIds)
      .then((summaries) => updatePulseDots(resultsBody, summaries))
      .catch(() => { /* non-critical — dots stay grey */ });
  }

  function setStatusFilter(value: Lead["status"] | null): void {
    statusFilter = value === null ? null : statusFilter === value ? null : value;
    statCards.forEach((card) => {
      const cardValue = (card.dataset.statusFilter || null) as Lead["status"] | null;
      card.classList.toggle("stat-card-active", cardValue === statusFilter);
    });
    renderTable();
  }

  // Named so `onRowClick` above can re-assert it via `setSidePanelCallbacks`
  // — the shared side panel is also used by the Cold Call Lists view, which
  // swaps in its own callbacks while it's active.
  const dashboardSidePanelCallbacks: SidePanelCallbacks = {
    onSaveNotes: async (id, notes) => {
      await updateLead(id, { leadNotes: notes });
      await refreshLeads();
    },
    onAssign: async (id, assignedUserId) => {
      await assignLead(id, assignedUserId);
      await refreshLeads();
    },
    onSaveDetails: async (id, contactName, contactTitle, website, linkedin) => {
      await updateLead(id, { contactName, contactTitle, website, linkedin });
      await refreshLeads();
    },
    onAddPhone: async (id, phoneNumber) => {
      await addLeadPhone(id, phoneNumber);
      await refreshLeads();
    },
    onUpdatePhone: async (id, phoneId, phoneNumber) => {
      await updateLeadPhone(id, phoneId, phoneNumber);
      await refreshLeads();
    },
    onDeletePhone: async (id, phoneId) => {
      await deleteLeadPhone(id, phoneId);
      await refreshLeads();
    },
    onAddEmail: async (id, email) => {
      await addLeadEmail(id, email);
      await refreshLeads();
    },
    onUpdateEmail: async (id, emailId, email) => {
      await updateLeadEmail(id, emailId, email);
      await refreshLeads();
    },
    onDeleteEmail: async (id, emailId) => {
      await deleteLeadEmail(id, emailId);
      await refreshLeads();
    },
    onAddTag: async (id, tag) => {
      await addLeadTag(id, tag);
      await refreshLeads();
    },
    onDeleteTag: async (id, tag) => {
      await deleteLeadTag(id, tag);
      await refreshLeads();
    },
    onScrapeEmail: async (id) => {
      await scrapeLeadEmail(id);
      await refreshLeads();
    },
    onGenerateIntelligence: async (id) => {
      await generateLeadIntelligence(id);
      await refreshLeads();
    },
  };

  // --- Saved/shared filter views: capture every filter dimension the
  // toolbar exposes into one JSON blob the backend stores opaquely, so a
  // new filter only ever needs a frontend change (add a field here), never
  // a migration, to become saveable. ---
  interface DashboardFilterState {
    search: string;
    statusFilter: Lead["status"] | null;
    contactStatusMinRank: number | null;
    phoneFilter: "all" | "has-phone" | "no-phone";
    enrichFilter: "all" | "has-charges" | "enriched" | "not-enriched";
    industries: string[];
    hasCharges: boolean;
    chargeTypes: string[];
    sortColumn: SortColumn;
    sortDirection: SortDirection;
  }

  function captureCurrentFilters(): DashboardFilterState {
    return {
      search: searchText,
      statusFilter,
      contactStatusMinRank,
      phoneFilter: dashPhoneFilter,
      enrichFilter: dashEnrichFilter,
      industries: Array.from(getSelectedIndustries()),
      hasCharges: getHasChargesFilter(),
      chargeTypes: Array.from(getSelectedChargeTypes()),
      sortColumn,
      sortDirection,
    };
  }

  function applySavedFilters(raw: Record<string, unknown>): void {
    const f = raw as Partial<DashboardFilterState>;
    searchText = typeof f.search === "string" ? f.search : "";
    searchInput.value = searchText;
    statusFilter = f.statusFilter ?? null;
    contactStatusMinRank = typeof f.contactStatusMinRank === "number" ? f.contactStatusMinRank : null;
    dashPhoneFilter = f.phoneFilter ?? "all";
    dashEnrichFilter = f.enrichFilter ?? "all";
    sortColumn = f.sortColumn ?? null;
    sortDirection = f.sortDirection ?? "asc";

    dashPhoneBtns.forEach((b) => b.classList.toggle("active", b.dataset.phone === dashPhoneFilter));
    dashEnrichBtns.forEach((b) => b.classList.toggle("active", b.dataset.enrich === dashEnrichFilter));
    statCards.forEach((card) => {
      const cardValue = (card.dataset.statusFilter || null) as Lead["status"] | null;
      card.classList.toggle("stat-card-active", cardValue === statusFilter);
    });

    // These two call notify() internally, which re-renders via subscribeIndustryFilter.
    setIndustryFilter(Array.isArray(f.industries) ? f.industries : []);
    setChargesFilter(!!f.hasCharges, Array.isArray(f.chargeTypes) ? f.chargeTypes : []);
    renderTable();
  }

  function renderViewsPopover(): void {
    const currentUser = getCurrentUser();
    viewsPopover.innerHTML = `
      <div class="sidebar-section">
        <div class="sidebar-section-header"><span>Saved Views</span></div>
        <button id="save-view-btn" class="btn btn-secondary btn-sm">Save current as...</button>
        ${
          savedViews.length === 0
            ? '<p class="empty-hint" style="margin-top:6px">No saved views yet</p>'
            : savedViews
                .map(
                  (v) => `
          <div class="saved-view-row">
            <button class="saved-view-apply" data-view-id="${v.id}">${escapeHtml(v.name)}${
                    v.is_shared ? ' <span class="view-shared-badge">Shared</span>' : ""
                  }</button>
            ${
              currentUser && (v.owner_user_id === currentUser.id || currentUser.role === "admin")
                ? `<button class="saved-view-delete" data-view-id="${v.id}" title="Delete">✕</button>`
                : ""
            }
          </div>`
                )
                .join("")
        }
      </div>
    `;

    viewsPopover.querySelectorAll<HTMLButtonElement>(".saved-view-apply").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = savedViews.find((v) => v.id === btn.dataset.viewId);
        if (view) applySavedFilters(view.filters);
        viewsPopover.classList.add("hidden");
      });
    });

    viewsPopover.querySelectorAll<HTMLButtonElement>(".saved-view-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const view = savedViews.find((v) => v.id === btn.dataset.viewId);
        if (!view) return;
        const action = await confirmDialog({
          title: "Delete saved view?",
          descriptionHtml: `"${escapeHtml(view.name)}" will be removed${
            view.is_shared ? " for everyone on the team" : ""
          }. This can't be undone.`,
          actions: [
            { id: "cancel", label: "Cancel", variant: "secondary" },
            { id: "delete", label: "Delete", variant: "primary" },
          ],
        });
        if (action !== "delete") return;
        await deleteSavedView(view.id);
        await refreshSavedViews();
      });
    });

    viewsPopover.querySelector("#save-view-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openSaveViewModal();
    });
  }

  async function refreshSavedViews(): Promise<void> {
    try {
      savedViews = await listSavedViews();
    } catch {
      savedViews = [];
    }
    renderViewsPopover();
  }

  function openSaveViewModal(): void {
    const { overlay, close } = openOverlay(
      `<div class="conflict-modal">
        <div class="conflict-modal-title">Save current filters as a view</div>
        <input id="sv-name-input" type="text" class="search-input" placeholder="View name" maxlength="60" style="width:100%;margin-bottom:8px" />
        <label class="checkbox-row" style="margin-bottom:8px">
          <input type="checkbox" id="sv-shared-cb" />
          Share with the whole team
        </label>
        <p id="sv-error" style="color:var(--danger);font-size:0.82rem;min-height:1.2em;margin-bottom:4px"></p>
        <div class="conflict-modal-actions">
          <button id="sv-save-btn" class="btn btn-primary">Save</button>
          <button id="sv-cancel-btn" class="btn btn-ghost">Cancel</button>
        </div>
      </div>`,
      { onEscape: () => close() }
    );

    const nameInput = overlay.querySelector<HTMLInputElement>("#sv-name-input")!;
    const sharedCb = overlay.querySelector<HTMLInputElement>("#sv-shared-cb")!;
    const errorEl = overlay.querySelector<HTMLParagraphElement>("#sv-error")!;
    setTimeout(() => nameInput.focus(), 40);

    overlay.querySelector("#sv-cancel-btn")!.addEventListener("click", close);

    overlay.querySelector("#sv-save-btn")!.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        errorEl.textContent = "Give this view a name.";
        return;
      }
      try {
        await createSavedView(name, sharedCb.checked, { ...captureCurrentFilters() });
        close();
        await refreshSavedViews();
        showToast("View saved.");
      } catch (err) {
        errorEl.textContent = `Failed: ${err}`;
      }
    });
  }

  viewsToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    viewsPopover.classList.toggle("hidden");
  });
  viewsPopover.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => viewsPopover.classList.add("hidden"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") viewsPopover.classList.add("hidden");
  });
  void refreshSavedViews();

  subscribe(renderTable);
  subscribeIndustryFilter(renderTable);
  initFiltersToggle();
  subscribeTeam(() => setTeamMembers(getTeamMembers()));
  initSidePanel(dashboardSidePanelCallbacks);

  const dashPhoneBtns = document.querySelectorAll<HTMLButtonElement>(".dash-phone-btn");
  dashPhoneBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      dashPhoneFilter = btn.dataset.phone as "all" | "has-phone" | "no-phone";
      dashPhoneBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderTable();
    });
  });

  const dashEnrichBtns = document.querySelectorAll<HTMLButtonElement>(".dash-enrich-btn");
  dashEnrichBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      dashEnrichFilter = btn.dataset.enrich as "all" | "has-charges" | "enriched" | "not-enriched";
      dashEnrichBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderTable();
    });
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
      renderTable();
    });
  });

  statCards.forEach((card) => {
    card.addEventListener("click", () => {
      const value = (card.dataset.statusFilter || null) as Lead["status"] | null;
      setStatusFilter(value);
    });
  });

  searchInput.addEventListener("input", () => {
    searchText = searchInput.value;
    renderTable();
  });

  async function runLookups(companies: string[]): Promise<void> {
    lookupBtn.disabled = true;
    for (const company of companies) {
      statusMessage.textContent = `Looking up ${company}...`;
      try {
        await lookupCompanyPhone(company);
        await refreshLeads();
        const defaultStatus = getDefaultContactStatus();
        if (defaultStatus !== CONTACT_STATUS_ORDER[0]) {
          const newest = getLeads()[getLeads().length - 1];
          if (newest && newest.company === company) {
            await updateLead(newest.id, { contactStatus: defaultStatus });
            await refreshLeads();
          }
        }
      } catch (err) {
        statusMessage.textContent = `Error looking up ${company}: ${err}`;
      }
    }
    statusMessage.textContent = "";
    lookupBtn.disabled = false;
  }

  lookupBtn.addEventListener("click", () => {
    const companies = companiesInput.value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (companies.length > 0) {
      void runLookups(companies);
    }
  });

  importCsvBtn.addEventListener("click", async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof path !== "string") return;

    importCsvBtn.disabled = true;
    importCsvBtn.textContent = "Importing...";
    try {
      const imported = await importLeadsToDashboard(path);
      await refreshLeads();
      showToast(`Imported ${imported} lead(s) successfully.`);
    } catch (err) {
      showToast(`Import failed: ${err}`);
    } finally {
      importCsvBtn.disabled = false;
      importCsvBtn.textContent = "Import CSV";
    }
  });

  enrichBtn.addEventListener("click", async () => {
    enrichBtn.disabled = true;
    enrichBtn.textContent = "Enriching...";
    try {
      const { enriched, remaining } = await chEnrichAll();
      await refreshLeads();
      if (remaining > 0) {
        enrichBtn.textContent = `Enrich from CH (${remaining} left)`;
        statusMessage.textContent = `Enriched ${enriched} — ${remaining} still to go. Click again to continue.`;
      } else {
        statusMessage.textContent = `Enriched ${enriched} lead(s). All done.`;
        enrichBtn.textContent = "Enrich from CH";
      }
    } catch (err) {
      statusMessage.textContent = `Enrichment failed: ${err}`;
      enrichBtn.textContent = "Enrich from CH";
    } finally {
      enrichBtn.disabled = false;
    }
  });

  let _enrichPollInterval: ReturnType<typeof setInterval> | null = null;

  function updateEnrichProgress(status: { running: boolean; enriched: number; remaining: number; failed: number }): void {
    const total = status.enriched + status.remaining;
    enrichProgress.classList.toggle("hidden", !status.running && status.enriched === 0);
    if (total > 0) {
      const pct = Math.round((status.enriched / total) * 100);
      enrichProgressFill.style.width = `${pct}%`;
    } else {
      enrichProgressFill.style.width = "0%";
    }
    enrichProgressLabel.textContent = status.running
      ? `Enriching… ${status.enriched} done, ${status.remaining} remaining${status.failed ? `, ${status.failed} failed` : ""}`
      : `Done — enriched ${status.enriched}${status.failed ? `, ${status.failed} failed` : ""}`;
    if (status.running) {
      autoEnrichBtn.textContent = "Stop Auto-Enrich";
      autoEnrichBtn.dataset.state = "running";
    } else {
      autoEnrichBtn.textContent = "Auto-Enrich All";
      autoEnrichBtn.dataset.state = "idle";
      if (_enrichPollInterval) { clearInterval(_enrichPollInterval); _enrichPollInterval = null; }
      void refreshLeads();
    }
  }

  void chEnrichStatus().then(updateEnrichProgress).catch(() => {/* ignore */});

  autoEnrichBtn.addEventListener("click", async () => {
    if (autoEnrichBtn.dataset.state === "running") {
      try { const s = await chEnrichStop(); updateEnrichProgress(s); } catch { /* ignore */ }
    } else {
      try { const s = await chEnrichAuto(); updateEnrichProgress(s); } catch { return; }
      _enrichPollInterval = setInterval(async () => {
        try { const s = await chEnrichStatus(); updateEnrichProgress(s); } catch { /* ignore */ }
      }, 5000);
    }
  });

  const findPhonesDashboardBtn = document.querySelector<HTMLButtonElement>("#find-phones-dashboard-btn")!;
  findPhonesDashboardBtn.addEventListener("click", async () => {
    const leads = getLeads();
    const missing = leads.filter((l) => !l.phone_number || l.phone_number === "not_found");
    if (missing.length === 0) {
      statusMessage.textContent = "All leads already have phone numbers.";
      setTimeout(() => { statusMessage.textContent = ""; }, 3000);
      return;
    }
    const estimatedCost = (missing.length * 0.03).toFixed(2);
    if (!confirm(`Find phone numbers for ${missing.length} lead${missing.length === 1 ? "" : "s"} without a number?\n\nEstimated cost: ~£${estimatedCost}\n\nThis uses phone lookup credits.`)) return;
    findPhonesDashboardBtn.disabled = true;
    for (let i = 0; i < missing.length; i++) {
      statusMessage.textContent = `Looking up ${missing[i].company} (${i + 1}/${missing.length})...`;
      try {
        await lookupCompanyPhone(missing[i].company);
        await refreshLeads();
      } catch { /* continue */ }
    }
    statusMessage.textContent = "";
    findPhonesDashboardBtn.disabled = false;
  });

  exportBtn.addEventListener("click", async () => {
    const path = await save({
      defaultPath: "phone_lookups_export.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (path) {
      try {
        await exportLogCsv(path);
        statusMessage.textContent = `Exported to ${path}`;
      } catch (err) {
        statusMessage.textContent = `Export failed: ${err}`;
      }
    }
  });

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add("is-loading");
    try { await dedupLeads(); } catch { /* non-critical */ }
    await refreshLeads();
    refreshBtn.classList.remove("is-loading");
    refreshBtn.disabled = false;
  });

  // External hand-off from Analytics' funnel rows. Checked whenever this
  // tab actually becomes active, same pattern as the email-writer hand-off.
  subscribeTabs(() => {
    if (getActiveTabId() !== "dashboard") return;
    const pendingRank = consumePendingDashboardContactStatusFilter();
    if (pendingRank !== null) {
      contactStatusMinRank = pendingRank;
      renderTable();
    }
  });

  renderTable();

  // Leads/team data require a logged-in session — fetch once auth resolves
  // (on boot if a session is already stored, or right after a fresh login).
  subscribeAuth(() => {
    if (!getCurrentUser()) return;
    void (async () => {
      try {
        await Promise.all([refreshLeads(), refreshTeamMembers()]);
      } catch (err) {
        showToast(`Could not load leads: ${err}`);
      }
      isInitialLoad = false;
      renderTable();
    })();
  });
}
