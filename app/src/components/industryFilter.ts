import type { Lead } from "../api";
import { escapeHtml } from "../utils";

const SAVED_VIEWS_KEY = "savedIndustryViews";

interface SavedView {
  name: string;
  industries: string[];
}

let selected = new Set<string>();
let hasChargesFilter = false;
let selectedChargeTypes = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

export function getSelectedIndustries(): Set<string> {
  return selected;
}

export function getHasChargesFilter(): boolean {
  return hasChargesFilter;
}

export function getSelectedChargeTypes(): Set<string> {
  return selectedChargeTypes;
}

/** External setter — used by Analytics' industry chart click-through to
 * filter the Dashboard down to one industry without duplicating this
 * already-real filter mechanism. */
export function setIndustryFilter(industries: string[]): void {
  selected = new Set(industries);
  notify();
}

export function subscribeIndustryFilter(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Wires up the "Filters" button: click to open/close the popover, badge shows active filter count. */
export function initFiltersToggle(): void {
  const trigger = document.querySelector<HTMLButtonElement>("#filters-toggle-btn")!;
  const popover = document.querySelector<HTMLElement>("#industry-sidebar")!;
  const badge = document.querySelector<HTMLSpanElement>("#filters-count-badge")!;

  function updateBadge(): void {
    const count = selected.size + (hasChargesFilter ? 1 : 0) + selectedChargeTypes.size;
    badge.textContent = String(count);
    badge.classList.toggle("hidden", count === 0);
  }
  subscribeIndustryFilter(updateBadge);
  updateBadge();

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    popover.classList.toggle("hidden");
  });
  popover.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => popover.classList.add("hidden"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") popover.classList.add("hidden");
  });
}

function loadSavedViews(): SavedView[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_VIEWS_KEY) || "[]");
  } catch {
    return [];
  }
}

function persistSavedViews(views: SavedView[]): void {
  localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views));
}

function toggleIndustry(name: string): void {
  if (selected.has(name)) {
    selected.delete(name);
  } else {
    selected.add(name);
  }
  notify();
}

function clearIndustryFilter(): void {
  selected.clear();
  notify();
}

function saveCurrentView(name: string): void {
  const views = loadSavedViews();
  views.push({ name, industries: Array.from(selected) });
  persistSavedViews(views);
  notify();
}

function applyView(name: string): void {
  const view = loadSavedViews().find((v) => v.name === name);
  if (view) {
    selected = new Set(view.industries);
    notify();
  }
}

function deleteView(name: string): void {
  persistSavedViews(loadSavedViews().filter((v) => v.name !== name));
  notify();
}

function extractChargeTypes(leads: Lead[]): string[] {
  const types = new Set<string>();
  for (const lead of leads) {
    try {
      const chData = JSON.parse(lead.ch_data || "{}");
      for (const charge of chData.charges || []) {
        const classification = (charge.classification || "").trim();
        if (classification) types.add(classification);
      }
    } catch {
      // ignore malformed ch_data
    }
  }
  return Array.from(types).sort();
}

export function renderIndustrySidebar(container: HTMLElement, leads: Lead[]): void {
  const industries = Array.from(new Set(leads.map((l) => l.industry || "Uncategorized"))).sort();
  const chargeTypes = extractChargeTypes(leads);
  const views = loadSavedViews();

  container.innerHTML = `
    <div class="sidebar-section">
      <div class="sidebar-section-header">
        <span>Charges (Companies House)</span>
        ${selectedChargeTypes.size > 0 ? '<button id="clear-charge-filter-btn" class="btn btn-ghost btn-sm">Clear</button>' : ""}
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="charges-filter-cb" ${hasChargesFilter ? "checked" : ""} />
        Any charge registered
      </label>
      ${
        chargeTypes.length === 0
          ? '<p class="empty-hint" style="margin-top:6px">Enrich leads with CH data to filter by type</p>'
          : chargeTypes
              .map(
                (ct) => `
        <label class="checkbox-row" style="padding-left:20px">
          <input type="checkbox" data-charge-type="${escapeHtml(ct)}" ${selectedChargeTypes.has(ct) ? "checked" : ""} />
          ${escapeHtml(ct)}
        </label>`
              )
              .join("")
      }
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-header">
        <span>Industries</span>
        ${selected.size > 0 ? '<button id="clear-industry-filter-btn" class="btn btn-ghost btn-sm">Clear</button>' : ""}
      </div>
      ${
        industries.length === 0
          ? '<p class="empty-hint">No industries yet</p>'
          : industries
              .map(
                (ind) => `
        <label class="checkbox-row">
          <input type="checkbox" data-industry="${escapeHtml(ind)}" ${selected.has(ind) ? "checked" : ""} />
          ${escapeHtml(ind)}
        </label>`
              )
              .join("")
      }
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-header"><span>Saved Views</span></div>
      <button id="save-view-btn" class="btn btn-secondary btn-sm">Save current as...</button>
      ${views
        .map(
          (v) => `
        <div class="saved-view-row">
          <button class="saved-view-apply" data-view="${escapeHtml(v.name)}">${escapeHtml(v.name)}</button>
          <button class="saved-view-delete" data-view="${escapeHtml(v.name)}" title="Delete">✕</button>
        </div>`
        )
        .join("")}
    </div>
  `;

  container.querySelector<HTMLInputElement>("#charges-filter-cb")?.addEventListener("change", (e) => {
    hasChargesFilter = (e.target as HTMLInputElement).checked;
    if (hasChargesFilter) selectedChargeTypes.clear();
    notify();
  });

  container.querySelectorAll<HTMLInputElement>("[data-charge-type]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const ct = cb.dataset.chargeType!;
      if (cb.checked) {
        selectedChargeTypes.add(ct);
        hasChargesFilter = false;
      } else {
        selectedChargeTypes.delete(ct);
      }
      notify();
    });
  });

  container.querySelector("#clear-charge-filter-btn")?.addEventListener("click", () => {
    selectedChargeTypes.clear();
    hasChargesFilter = false;
    notify();
  });

  container.querySelectorAll<HTMLInputElement>("[data-industry]").forEach((cb) => {
    cb.addEventListener("change", () => toggleIndustry(cb.dataset.industry!));
  });
  container.querySelector("#clear-industry-filter-btn")?.addEventListener("click", clearIndustryFilter);
  container.querySelector("#save-view-btn")?.addEventListener("click", () => {
    const name = prompt("Name this filter view:");
    if (name) saveCurrentView(name);
  });
  container.querySelectorAll<HTMLButtonElement>(".saved-view-apply").forEach((btn) => {
    btn.addEventListener("click", () => applyView(btn.dataset.view!));
  });
  container.querySelectorAll<HTMLButtonElement>(".saved-view-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteView(btn.dataset.view!));
  });
}
