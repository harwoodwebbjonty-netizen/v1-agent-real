import { open } from "@tauri-apps/plugin-dialog";
import {
  type Lead,
  type LeadList,
  addLeadEmail,
  addLeadPhone,
  assignLead,
  createLeadList,
  deleteLeadEmail,
  deleteLeadPhone,
  generateLeadIntelligence,
  getListLeads,
  importLeadsCsv,
  lookupCompanyPhone,
  scrapeLeadEmail,
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

const LIST_COLUMN_COUNT = 8; // 7 standard columns + the contacted-toggle column

export function initColdCallLists(): void {
  const container = document.querySelector<HTMLDivElement>("#view-cold-call-lists")!;
  container.innerHTML = `
    <main class="container">
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

      <div id="cold-call-list-detail" class="hidden">
        <section class="card">
          <div class="card-header-row">
            <div>
              <button id="back-to-lists-btn" class="btn btn-ghost">← Back to lists</button>
              <h2 class="card-title" id="list-detail-title"></h2>
            </div>
          </div>
        </section>

        <section class="card">
          <h2 class="card-title">Add companies</h2>
          <p class="card-subtitle">Enter one company name per line — runs the same AI phone lookup as the Dashboard, scoped to this list. Or upload a CSV instead.</p>
          <textarea id="list-companies-input" rows="4" placeholder="Acme Ltd&#10;Example Widgets Inc"></textarea>
          <div class="card-actions">
            <button id="list-lookup-btn" class="btn btn-primary">Look up</button>
            <button id="upload-csv-btn" class="btn btn-secondary">Upload CSV</button>
            <span id="list-detail-status" class="status-message"></span>
          </div>
        </section>

        <section class="card">
          <div class="card-header-row">
            <h2 class="card-title">Leads</h2>
            <div class="card-header-actions">
              <input id="list-search-input" type="search" class="search-input" placeholder="Search leads..." />
            </div>
          </div>

          <div class="table-wrap">
            <table id="list-results-table">
              <thead>
                <tr>
                  <th></th>
                  <th data-sort="company">Company</th>
                  <th data-sort="phone_number">Phone</th>
                  <th>Source</th>
                  <th data-sort="status">Status</th>
                  <th data-sort="industry">Industry</th>
                  <th data-sort="contact_status">Contact Status</th>
                  <th>Emails</th>
                </tr>
              </thead>
              <tbody id="list-results-body"></tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  `;

  const overviewEl = document.querySelector<HTMLDivElement>("#cold-call-lists-overview")!;
  const detailEl = document.querySelector<HTMLDivElement>("#cold-call-list-detail")!;
  const myListsEl = document.querySelector<HTMLUListElement>("#my-lists")!;
  const myListsEmptyEl = document.querySelector<HTMLParagraphElement>("#my-lists-empty")!;
  const adminListsCard = document.querySelector<HTMLDivElement>("#admin-lists-card")!;
  const adminListsEl = document.querySelector<HTMLUListElement>("#admin-lists")!;
  const newListForm = document.querySelector<HTMLDivElement>("#new-list-form")!;
  const newListNameInput = document.querySelector<HTMLInputElement>("#new-list-name-input")!;
  const newListError = document.querySelector<HTMLSpanElement>("#new-list-error")!;
  const listDetailTitle = document.querySelector<HTMLHeadingElement>("#list-detail-title")!;
  const listDetailStatus = document.querySelector<HTMLSpanElement>("#list-detail-status")!;
  const listCompaniesInput = document.querySelector<HTMLTextAreaElement>("#list-companies-input")!;
  const listLookupBtn = document.querySelector<HTMLButtonElement>("#list-lookup-btn")!;
  const listResultsBody = document.querySelector<HTMLTableSectionElement>("#list-results-body")!;
  const listSearchInput = document.querySelector<HTMLInputElement>("#list-search-input")!;
  const sortableHeaders = document.querySelectorAll<HTMLTableCellElement>("#list-results-table th[data-sort]");

  let currentListId: string | null = null;
  let currentListLeads: Lead[] = [];
  let sortColumn: SortColumn = null;
  let sortDirection: SortDirection = "asc";
  let searchText = "";

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

  function renderListTable(): void {
    refreshIfOpen(currentListLeads);
    updateSortIndicators();

    if (currentListLeads.length === 0) {
      renderEmptyState(listResultsBody, "No leads in this list yet — upload a CSV to get started.", LIST_COLUMN_COUNT);
      return;
    }
    const visible = sortLeadsStable(filterLeads(currentListLeads, searchText, new Set()), sortColumn, sortDirection);
    if (visible.length === 0) {
      renderEmptyState(listResultsBody, "No leads match your search.", LIST_COLUMN_COUNT);
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
      onGenerateEmail: (lead) => {
        setPendingEmailWriterLead(lead.id);
        openTab("email-writer", "AI Email Writer");
      },
    });
  }

  async function refreshCurrentList(): Promise<void> {
    if (!currentListId) return;
    currentListLeads = await getListLeads(currentListId);
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

  async function openListDetail(listId: string): Promise<void> {
    currentListId = listId;
    sortColumn = null;
    sortDirection = "asc";
    searchText = "";
    listSearchInput.value = "";
    listDetailStatus.textContent = "";
    listDetailTitle.textContent = getLeadLists().find((l) => l.id === listId)?.name ?? "List";

    overviewEl.classList.add("hidden");
    detailEl.classList.remove("hidden");

    renderSkeletonRows(listResultsBody, 3, LIST_COLUMN_COUNT);
    await refreshCurrentList();
  }

  function backToOverview(): void {
    closeSidePanel();
    currentListId = null;
    detailEl.classList.add("hidden");
    overviewEl.classList.remove("hidden");
    void refreshLeadLists();
  }

  subscribeLeadLists(renderOverview);
  subscribeAuth(() => {
    if (!getCurrentUser()) return;
    void refreshLeadLists();
  });

  // window.prompt() doesn't render in the Tauri webview — use an inline
  // form instead (same reasoning as the avatar/identity flows elsewhere).
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

  document.querySelector("#new-list-btn")!.addEventListener("click", openNewListForm);
  document.querySelector("#create-list-cancel-btn")!.addEventListener("click", closeNewListForm);
  document.querySelector("#create-list-confirm-btn")!.addEventListener("click", () => void submitNewList());
  newListNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void submitNewList();
    if (event.key === "Escape") closeNewListForm();
  });

  document.querySelector("#back-to-lists-btn")!.addEventListener("click", backToOverview);

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

  document.querySelector("#upload-csv-btn")!.addEventListener("click", async () => {
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
