import { consumePendingEmailWriterLead } from "../emailWriterHandoff";
import { getLeadLists, refreshLeadLists, subscribeLeadLists } from "../leadLists";
import { getLeads, subscribe } from "../state";
import { getActiveTabId, subscribeTabs } from "../tabs";
import { escapeHtml } from "../utils";
import type { EmailWriterHandle } from "./emailWriter";
import type { ListCampaignHandle } from "./listCampaign";
import type { SequencesHandle } from "./sequences";

// Outreach used to be three peer tabs (Email Writer / List Campaign /
// Sequences) that each owned their own recipient-picking UI. This is the
// unified front door instead: one recipient picker drives everything —
// exactly one lead selected shows the rich Email Writer editor, a whole
// list or several hand-picked leads shows the bulk draft-review grid
// (listCampaign.ts, shared with the list path via draftReviewGrid.ts). Once
// leads are selected, a small mode toggle lets the rep choose "Send an
// email" (the default — Email Writer / List Campaign as above) vs "Start a
// sequence" (hands the current selection to sequences.ts's enroll-picker
// overlay). Sequence *definitions* (creating a sequence, editing its steps)
// still live only in the separate "Sequences" sub-tab — this toggle is only
// a second entry point into enrollment.

const LEAD_LIST_CAP = 50;

export function initOutreach(emailWriter: EmailWriterHandle, listCampaign: ListCampaignHandle, sequences: SequencesHandle): void {
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
  const modeToggleEl = document.querySelector<HTMLDivElement>("#or-mode-toggle")!;
  const sequenceModeEl = document.querySelector<HTMLDivElement>("#or-sequence-mode")!;
  const sequenceModeSummaryEl = document.querySelector<HTMLParagraphElement>("#or-sequence-mode-summary")!;
  const startSequenceBtn = document.querySelector<HTMLButtonElement>("#or-start-sequence-btn")!;

  let searchText = "";
  const selectedLeadIds = new Set<string>();
  let selectedListId = "";
  let mode: "send" | "sequence" = "send";

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

  // Resolves the current selection (whole list or hand-picked leads) down to
  // a flat lead-id list — what sequences.ts's enroll-picker needs, since
  // enrollment always happens one lead at a time regardless of how the
  // selection was made.
  function currentSelectionLeadIds(): string[] {
    if (selectedListId) return getLeads().filter((l) => l.list_id === selectedListId).map((l) => l.id);
    return [...selectedLeadIds];
  }

  function updateModeToggleUI(): void {
    modeToggleEl.querySelectorAll<HTMLButtonElement>(".or-mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
  }

  function renderSequenceModeSummary(): void {
    const leadIds = currentSelectionLeadIds();
    sequenceModeSummaryEl.textContent = selectedListId
      ? `Ready to enroll the whole "${currentListName()}" list (${leadIds.length} lead${leadIds.length === 1 ? "" : "s"}) in a sequence.`
      : `Ready to enroll ${leadIds.length} lead${leadIds.length === 1 ? "" : "s"} in a sequence.`;
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

    const hasSelection = !!selectedListId || selectedLeadIds.size > 0;
    if (!hasSelection) mode = "send";

    emailWriterEl.style.display = "none";
    listCampaignEl.style.display = "none";
    sequenceModeEl.style.display = "none";
    emptyStateEl.style.display = "none";
    modeToggleEl.style.display = hasSelection ? "" : "none";

    if (!hasSelection) {
      emptyStateEl.style.display = "";
      return;
    }

    updateModeToggleUI();

    if (mode === "sequence") {
      sequenceModeEl.style.display = "";
      renderSequenceModeSummary();
      return;
    }

    if (selectedListId) {
      listCampaignEl.style.display = "";
      listCampaign.start({ kind: "list", listId: selectedListId, listName: currentListName() });
    } else if (selectedLeadIds.size === 1) {
      emailWriterEl.style.display = "";
      emailWriter.focusLead([...selectedLeadIds][0]);
    } else if (selectedLeadIds.size >= 2) {
      listCampaignEl.style.display = "";
      listCampaign.start({ kind: "leads", leadIds: [...selectedLeadIds] });
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

  modeToggleEl.querySelectorAll<HTMLButtonElement>(".or-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      mode = btn.dataset.mode === "sequence" ? "sequence" : "send";
      applySelection();
    });
  });

  startSequenceBtn.addEventListener("click", () => {
    sequences.enrollLeads(currentSelectionLeadIds());
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
    mode = "send";
    showSubView("compose");
    applySelection();
  }

  subscribeTabs(() => {
    if (getActiveTabId() === "outreach") checkPendingHandoff();
  });
  checkPendingHandoff();

  applySelection();
}
