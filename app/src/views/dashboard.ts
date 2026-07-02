import { open, save } from "@tauri-apps/plugin-dialog";
import {
  type Lead,
  addLeadEmail,
  addLeadPhone,
  assignLead,
  deleteLeadEmail,
  deleteLeadPhone,
  exportLogCsv,
  generateLeadIntelligence,
  getBatchActivitySummaries,
  importLeadsToDashboard,
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
  getSelectedIndustries,
  initFiltersToggle,
  renderIndustrySidebar,
  subscribeIndustryFilter,
} from "../components/industryFilter";
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

export function initDashboard(): void {
  const companiesInput = document.querySelector<HTMLTextAreaElement>("#companies")!;
  const lookupBtn = document.querySelector<HTMLButtonElement>("#lookup-btn")!;
  const importCsvBtn = document.querySelector<HTMLButtonElement>("#import-csv-btn")!;
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
  const sortableHeaders = document.querySelectorAll<HTMLTableCellElement>("#results-table th[data-sort]");
  const statCards = document.querySelectorAll<HTMLDivElement>(".stats-grid .stat-card[data-status-filter]");

  let sortColumn: SortColumn = null;
  let sortDirection: SortDirection = "asc";
  let searchText = "";
  let isInitialLoad = true;
  let statusFilter: Lead["status"] | null = null;
  let contactStatusMinRank: number | null = null;

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
    const visible = sortLeadsStable(
      filterLeads(leads, searchText, getSelectedIndustries(), statusFilter, contactStatusMinRank),
      sortColumn,
      sortDirection
    );
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
        openTab("email-writer", "AI Email Writer");
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
    onScrapeEmail: async (id) => {
      await scrapeLeadEmail(id);
      await refreshLeads();
    },
    onGenerateIntelligence: async (id) => {
      await generateLeadIntelligence(id);
      await refreshLeads();
    },
  };

  subscribe(renderTable);
  subscribeIndustryFilter(renderTable);
  initFiltersToggle();
  subscribeTeam(() => setTeamMembers(getTeamMembers()));
  initSidePanel(dashboardSidePanelCallbacks);

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
      statusMessage.textContent = `Imported ${imported} lead(s).`;
      await refreshLeads();
    } catch (err) {
      statusMessage.textContent = `Import failed: ${err}`;
    } finally {
      importCsvBtn.disabled = false;
      importCsvBtn.textContent = "Import CSV";
    }
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
      await Promise.all([refreshLeads(), refreshTeamMembers()]);
      isInitialLoad = false;
      renderTable();
    })();
  });
}
