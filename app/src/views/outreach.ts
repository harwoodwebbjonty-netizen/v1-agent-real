import { consumePendingEmailWriterLead } from "../emailWriterHandoff";
import { getLeadLists, refreshLeadLists, subscribeLeadLists } from "../leadLists";
import { getLeads, subscribe } from "../state";
import { getActiveTabId, subscribeTabs } from "../tabs";
import { escapeHtml } from "../utils";
import type { EmailWriterHandle } from "./emailWriter";
import type { ListCampaignHandle } from "./listCampaign";

// Outreach used to be three peer tabs (Email Writer / List Campaign /
// Sequences) that each owned their own recipient-picking UI. This is the
// unified front door instead: one recipient picker drives everything —
// exactly one lead selected shows the rich Email Writer editor, a whole
// list or several hand-picked leads shows the bulk draft-review grid
// (listCampaign.ts, shared with the list path via draftReviewGrid.ts).
// Sequences remains a separate sub-tab for now (folding enrollment into
// this same picker is a follow-up piece of work, not this pass).

const LEAD_LIST_CAP = 50;

export function initOutreach(emailWriter: EmailWriterHandle, listCampaign: ListCampaignHandle): void {
  const container = document.querySelector<HTMLDivElement>("#view-outreach")!;
  const composeView = document.querySelector<HTMLDivElement>("#view-compose")!;
  const sequencesView = document.querySelector<HTMLDivElement>("#view-sequences")!;
  const emailWriterEl = document.querySelector<HTMLDivElement>("#view-email-writer")!;
  const listCampaignEl = document.querySelector<HTMLDivElement>("#view-list-campaign")!;
  const emptyStateEl = document.querySelector<HTMLDivElement>("#outreach-empty-state")!;
  const searchInput = document.querySelector<HTMLInputElement>("#or-lead-search")!;
  const listSelect = document.querySelector<HTMLSelectElement>("#or-list-select")!;
  const leadListEl = document.querySelector<HTMLUListElement>("#or-lead-list")!;
  const summaryEl = document.querySelector<HTMLParagraphElement>("#or-selection-summary")!;

  let searchText = "";
  const selectedLeadIds = new Set<string>();
  let selectedListId = "";

  // Cheap, safe to re-run on any unrelated lead-state change (e.g. a company
  // name edited elsewhere) — only redraws the picker list itself, never
  // touches the content area, so it can't interrupt an in-progress draft.
  function renderPickerList(): void {
    const leads = getLeads().filter((l) => l.company.toLowerCase().includes(searchText.toLowerCase()));
    leadListEl.innerHTML = leads
      .slice(0, LEAD_LIST_CAP)
      .map(
        (l) => `
        <li class="history-list-row outreach-lead-row" data-lead-id="${escapeHtml(l.id)}">
          <label class="outreach-lead-check">
            <input type="checkbox" ${selectedLeadIds.has(l.id) ? "checked" : ""} />
            <span>${escapeHtml(l.company)}</span>
          </label>
        </li>`
      )
      .join("");
    leadListEl.querySelectorAll<HTMLLIElement>(".outreach-lead-row").forEach((row) => {
      const leadId = row.dataset.leadId!;
      row.querySelector("input")!.addEventListener("change", (e) => {
        if ((e.target as HTMLInputElement).checked) {
          selectedListId = "";
          listSelect.value = "";
          selectedLeadIds.add(leadId);
        } else {
          selectedLeadIds.delete(leadId);
        }
        applySelection();
      });
    });
  }

  function renderListOptions(): void {
    const lists = getLeadLists();
    listSelect.innerHTML =
      `<option value="">— or pick a whole list —</option>` +
      lists.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)} (${l.lead_count})</option>`).join("");
    listSelect.value = selectedListId;
  }

  function currentListName(): string {
    return getLeadLists().find((l) => l.id === selectedListId)?.name ?? "";
  }

  // Heavier — only run when the actual selection changes (checkbox, list
  // dropdown, or an incoming hand-off), never from unrelated re-renders.
  // Re-fetching/regenerating a draft on every unrelated tick would blow
  // away whatever the rep is mid-typing.
  function applySelection(): void {
    renderPickerList();

    const listCount = selectedListId ? getLeadLists().find((l) => l.id === selectedListId)?.lead_count ?? 0 : 0;
    summaryEl.textContent = selectedListId
      ? `Composing for the whole "${currentListName()}" list (${listCount} lead${listCount === 1 ? "" : "s"}).`
      : selectedLeadIds.size > 0
        ? `${selectedLeadIds.size} lead${selectedLeadIds.size === 1 ? "" : "s"} selected.`
        : "";

    emailWriterEl.style.display = "none";
    listCampaignEl.style.display = "none";
    emptyStateEl.style.display = "none";

    if (selectedListId) {
      listCampaignEl.style.display = "";
      listCampaign.start({ kind: "list", listId: selectedListId, listName: currentListName() });
    } else if (selectedLeadIds.size === 1) {
      emailWriterEl.style.display = "";
      emailWriter.focusLead([...selectedLeadIds][0]);
    } else if (selectedLeadIds.size >= 2) {
      listCampaignEl.style.display = "";
      listCampaign.start({ kind: "leads", leadIds: [...selectedLeadIds] });
    } else {
      emptyStateEl.style.display = "";
    }
  }

  searchInput.addEventListener("input", () => {
    searchText = searchInput.value;
    renderPickerList();
  });

  listSelect.addEventListener("change", () => {
    selectedListId = listSelect.value;
    if (selectedListId) selectedLeadIds.clear();
    applySelection();
  });

  subscribe(renderPickerList);
  subscribeLeadLists(renderListOptions);
  void refreshLeadLists();
  renderListOptions();

  // --- Compose vs Sequences sub-tabs ---
  const subViews = ["compose", "sequences"] as const;
  function showSubView(target: (typeof subViews)[number]): void {
    container.querySelectorAll<HTMLButtonElement>(".sub-view-tab").forEach((b) => b.classList.toggle("active", b.dataset.sub === target));
    composeView.style.display = target === "compose" ? "" : "none";
    sequencesView.style.display = target === "sequences" ? "" : "none";
  }
  container.querySelectorAll<HTMLButtonElement>(".sub-view-tab").forEach((btn) => {
    btn.addEventListener("click", () => showSubView(btn.dataset.sub as (typeof subViews)[number]));
  });

  // --- External hand-off from "Write Email" buttons elsewhere in the app
  // (side panel, dashboard, cold call lists, call queue, action centre,
  // opportunity workspace) — checked every time the user actually
  // navigates to Outreach, via the shared tab-subscription mechanism the
  // rest of the app already uses for this pattern. ---
  function checkPendingHandoff(): void {
    const pendingLeadId = consumePendingEmailWriterLead();
    if (!pendingLeadId) return;
    selectedListId = "";
    selectedLeadIds.clear();
    selectedLeadIds.add(pendingLeadId);
    showSubView("compose");
    applySelection();
  }

  subscribeTabs(() => {
    if (getActiveTabId() === "outreach") checkPendingHandoff();
  });
  checkPendingHandoff();

  applySelection();
}
