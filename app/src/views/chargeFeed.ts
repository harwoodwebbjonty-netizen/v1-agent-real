import { addChargeAsLead, getChargeFeedStatus, getChargeFeed, type ChCharge } from "../api";
import { escapeHtml } from "../utils";

const FILING_LABELS: Record<string, string> = {
  MR01: "New Charge",
  MR02: "New Charge",
  MR03: "New Charge (Overseas)",
  MR04: "Charge Satisfied",
  MR05: "Charge Part-Satisfied",
};

const FILING_TYPES = [
  { value: "MR01", label: "New Charges (MR01)" },
  { value: "MR02", label: "New Charges (MR02)" },
  { value: "MR03", label: "New Charge Overseas (MR03)" },
  { value: "MR04", label: "Satisfaction (MR04)" },
  { value: "MR05", label: "Part Satisfaction (MR05)" },
];

interface FeedState {
  charges: ChCharge[];
  loading: boolean;
  configured: boolean;
  timepoint: string | null;
  companySearch: string;
  selectedTypes: Set<string>;
  notAdded: boolean;
  offset: number;
  hasMore: boolean;
  addingIds: Set<string>;
  pollingInterval: ReturnType<typeof setInterval> | null;
}

const PAGE_SIZE = 100;

const state: FeedState = {
  charges: [],
  loading: false,
  configured: false,
  timepoint: null,
  companySearch: "",
  selectedTypes: new Set(),
  notAdded: false,
  offset: 0,
  hasMore: false,
  addingIds: new Set(),
  pollingInterval: null,
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = diffMs / 3600000;
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${Math.floor(diffH)}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function filingBadge(type: string): string {
  const label = FILING_LABELS[type] ?? type;
  const cls = type.startsWith("MR0") && parseInt(type[3]) <= 3
    ? "charge-badge-new"
    : "charge-badge-satisfied";
  return `<span class="charge-badge ${cls}">${escapeHtml(label)}</span>`;
}

function renderFilters(): string {
  const chips = FILING_TYPES.map(({ value, label }) => {
    const active = state.selectedTypes.has(value);
    return `<button class="p-filter-chip ${active ? "active" : ""}" data-type="${value}" type="button">${escapeHtml(label)}</button>`;
  }).join("");
  const notAddedActive = state.notAdded ? "active" : "";
  return `
    <div class="charge-feed-filters">
      <div class="charge-filter-row">
        <label class="p-section-label">Filing type</label>
        <div class="charge-type-chips">${chips}</div>
      </div>
      <div class="charge-filter-row">
        <input type="text" id="cf-company-search" class="inline-edit" placeholder="Search company name…"
          value="${escapeHtml(state.companySearch)}" style="max-width:280px" />
        <button class="p-filter-chip ${notAddedActive}" id="cf-not-added-btn" type="button">Not yet added</button>
      </div>
    </div>
  `;
}

function renderRow(c: ChCharge): string {
  const alreadyAdded = !!c.lead_id;
  const isAdding = state.addingIds.has(c.id);
  const btn = alreadyAdded
    ? `<span class="charge-added-label">In Leads</span>`
    : `<button class="btn btn-sm btn-secondary cf-add-btn" data-id="${c.id}" ${isAdding ? "disabled" : ""} type="button">
        ${isAdding ? "Adding…" : "Add to Leads"}
       </button>`;
  return `
    <div class="charge-feed-row" data-charge-id="${c.id}">
      <div class="charge-feed-row-main">
        <span class="charge-company">${escapeHtml(c.company_name ?? c.company_number)}</span>
        ${filingBadge(c.filing_type)}
        <span class="charge-desc">${escapeHtml(c.charge_description ?? "")}</span>
      </div>
      <div class="charge-feed-row-meta">
        <span class="charge-reg-date">${c.filing_date ? escapeHtml(c.filing_date) : ""}</span>
        <span class="charge-detected">${formatTime(c.detected_at)}</span>
        ${btn}
      </div>
    </div>
  `;
}

function renderBody(): string {
  if (state.loading && state.charges.length === 0) {
    return `<div class="activity-empty-state">Loading charge feed…</div>`;
  }
  if (!state.configured) {
    return `
      <div class="activity-empty-state">
        <strong>Charge feed not configured</strong>
        <p class="text-muted">Add <code>COMPANIES_HOUSE_API_KEY</code> to the backend <code>.env</code> and restart.</p>
      </div>
    `;
  }
  if (state.charges.length === 0) {
    return `<div class="activity-empty-state">No charge filings yet — the stream will populate this automatically.</div>`;
  }
  const rows = state.charges.map(renderRow).join("");
  const loadMore = state.hasMore
    ? `<div class="cf-load-more-wrap"><button class="btn btn-secondary" id="cf-load-more">Load more</button></div>`
    : "";
  return rows + loadMore;
}

function render(): void {
  const container = document.getElementById("view-charge-feed");
  if (!container) return;

  const timepointInfo = state.timepoint
    ? `<span class="cf-timepoint-label" title="Stream position">TP ${state.timepoint}</span>`
    : "";

  container.innerHTML = `
    <div class="view-header">
      <h2>Live Charge Feed ${timepointInfo}</h2>
      <p class="text-muted" style="margin:0">Real-time UK company charge registrations from Companies House filing stream</p>
    </div>
    ${renderFilters()}
    <div id="cf-body" class="charge-feed-body">${renderBody()}</div>
  `;

  bindEvents(container);
}

function bindEvents(container: HTMLElement): void {
  container.querySelectorAll<HTMLButtonElement>(".p-filter-chip[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.type!;
      if (state.selectedTypes.has(t)) state.selectedTypes.delete(t);
      else state.selectedTypes.add(t);
      state.offset = 0;
      void loadAndRender(true);
    });
  });

  const notAddedBtn = document.getElementById("cf-not-added-btn");
  notAddedBtn?.addEventListener("click", () => {
    state.notAdded = !state.notAdded;
    state.offset = 0;
    void loadAndRender(true);
  });

  let searchDebounce: ReturnType<typeof setTimeout>;
  const searchInput = document.getElementById("cf-company-search") as HTMLInputElement | null;
  searchInput?.addEventListener("input", () => {
    state.companySearch = searchInput.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.offset = 0;
      void loadAndRender(true);
    }, 300);
  });

  document.getElementById("cf-load-more")?.addEventListener("click", () => {
    state.offset += PAGE_SIZE;
    void loadAndRender(false);
  });

  container.querySelectorAll<HTMLButtonElement>(".cf-add-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id!;
      void handleAddToLeads(id);
    });
  });
}

async function handleAddToLeads(chargeId: string): Promise<void> {
  state.addingIds.add(chargeId);
  // Re-render just the button in-place
  const btn = document.querySelector<HTMLButtonElement>(`.cf-add-btn[data-id="${chargeId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }

  try {
    const result = await addChargeAsLead(chargeId);
    // Update state so the button reflects added status
    const charge = state.charges.find((c) => c.id === chargeId);
    if (charge) charge.lead_id = result.lead_id;
    state.addingIds.delete(chargeId);
    // Update just the row
    const row = document.querySelector<HTMLElement>(`.charge-feed-row[data-charge-id="${chargeId}"]`);
    if (row) row.outerHTML = renderRow(charge!);
    // Re-bind the new element
    const newRow = document.querySelector<HTMLElement>(`.charge-feed-row[data-charge-id="${chargeId}"]`);
    newRow?.querySelector<HTMLButtonElement>(".cf-add-btn")?.addEventListener("click", () => {
      void handleAddToLeads(chargeId);
    });
  } catch (err) {
    state.addingIds.delete(chargeId);
    if (btn) { btn.disabled = false; btn.textContent = "Add to Leads"; }
    console.error("Failed to add charge as lead:", err);
  }
}

async function loadAndRender(reset = false): Promise<void> {
  const body = document.getElementById("cf-body");
  if (reset && body) body.innerHTML = `<div class="activity-empty-state">Loading…</div>`;

  try {
    const [statusResult, charges] = await Promise.all([
      getChargeFeedStatus().catch(() => ({ configured: false, timepoint: null })),
      getChargeFeed({
        companyName: state.companySearch || undefined,
        filingTypes: state.selectedTypes.size > 0 ? Array.from(state.selectedTypes).join(",") : undefined,
        notAdded: state.notAdded,
        limit: PAGE_SIZE,
        offset: state.offset,
      }).catch(() => []),
    ]);
    state.configured = statusResult.configured;
    state.timepoint = statusResult.timepoint ?? null;
    if (reset || state.offset === 0) {
      state.charges = charges;
    } else {
      state.charges = [...state.charges, ...charges];
    }
    state.hasMore = charges.length >= PAGE_SIZE;
  } catch {
    state.charges = reset ? [] : state.charges;
  }

  if (body) body.innerHTML = renderBody();
  // Re-bind action buttons in the body after partial update
  const container = document.getElementById("view-charge-feed");
  if (container) bindEvents(container);
}

export function initChargeFeed(): void {
  render();
  void loadAndRender(true);

  if (state.pollingInterval) clearInterval(state.pollingInterval);
  state.pollingInterval = setInterval(() => {
    const el = document.getElementById("view-charge-feed");
    const isVisible = el && el.style.display !== "none";
    if (isVisible) {
      state.offset = 0;
      void loadAndRender(true);
    }
  }, 30_000);
}
