import { getActivityStatus, getGlobalActivityFeed, type ActivityEvent } from "../api";
import { escapeHtml } from "../utils";

const EVENT_TYPES = [
  "NEW_CHARGE",
  "CHARGE_SATISFIED",
  "CHARGE_UPDATED",
  "DIRECTOR_APPOINTMENT",
  "DIRECTOR_RESIGNATION",
  "PSC_CHANGE",
  "RISK_INCREASE",
  "FINANCIAL_CHANGE",
  "COMPANY_EVENT",
];


const TIME_RANGES: { label: string; hours: number | null }[] = [
  { label: "24h", hours: 24 },
  { label: "7 days", hours: 7 * 24 },
  { label: "30 days", hours: 30 * 24 },
  { label: "All time", hours: null },
];

interface FeedState {
  selectedTypes: Set<string>;
  timeRangeHours: number | null;
  companySearch: string;
  loading: boolean;
  events: ActivityEvent[];
  configured: boolean;
  pollingInterval: ReturnType<typeof setInterval> | null;
}

const state: FeedState = {
  selectedTypes: new Set(),
  timeRangeHours: 7 * 24,
  companySearch: "",
  loading: false,
  events: [],
  configured: false,
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
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function sinceFromHours(hours: number | null): string | undefined {
  if (!hours) return undefined;
  const d = new Date(Date.now() - hours * 3600000);
  return d.toISOString();
}

function renderEventRow(event: ActivityEvent): string {
  const label = event.event_type.replace(/_/g, " ");
  const badgeClass = `event-badge event-badge-${event.event_type}`;
  return `
    <div class="activity-feed-row">
      <div class="activity-event-body">
        <div class="activity-event-header">
          <span class="activity-feed-company">${escapeHtml(event.company_name)}</span>
          <span class="${badgeClass}">${escapeHtml(label)}</span>
          <span class="activity-event-desc">${escapeHtml(event.description)}</span>
          <span class="activity-event-time">${escapeHtml(formatTime(event.detected_at))}</span>
        </div>
      </div>
    </div>
  `;
}

function renderFilters(): string {
  const typeOptions = EVENT_TYPES.map((t) => {
    const label = t.replace(/_/g, " ");
    const active = state.selectedTypes.has(t);
    return `<button class="p-filter-chip ${active ? "active" : ""}" data-type="${t}" type="button">${label}</button>`;
  }).join("");

  const rangeButtons = TIME_RANGES.map(({ label, hours }) => {
    const active = state.timeRangeHours === hours;
    return `<button class="p-date-preset ${active ? "active" : ""}" data-hours="${hours ?? ""}" type="button">${label}</button>`;
  }).join("");

  return `
    <div class="activity-feed-filters">
      <div class="activity-filter-row">
        <label class="p-section-label">Event Type</label>
        <div class="activity-type-chips">${typeOptions}</div>
      </div>
      <div class="activity-filter-row">
        <label class="p-section-label">Time Range</label>
        <div class="p-date-presets">${rangeButtons}</div>
      </div>
      <div class="activity-filter-row">
        <label class="p-section-label">Company</label>
        <input type="text" class="inline-edit" id="activity-company-search"
          placeholder="Filter by company name…" value="${escapeHtml(state.companySearch)}" style="max-width:280px" />
      </div>
    </div>
  `;
}

function renderBody(): string {
  if (state.loading) {
    return `<div class="activity-empty-state">Loading activity feed…</div>`;
  }
  if (!state.configured) {
    return `
      <div class="activity-empty-state">
        <strong>Activity feed not configured</strong>
        <p class="text-muted">Add your <code>COMPANIES_HOUSE_API_KEY</code> to the backend <code>.env</code> file and restart the backend to enable the activity feed.</p>
      </div>
    `;
  }
  if (state.events.length === 0) {
    return `<div class="activity-empty-state">No events found for the selected filters.</div>`;
  }
  return state.events.map(renderEventRow).join("");
}

function render(): void {
  const container = document.getElementById("view-activity-feed");
  if (!container) return;

  container.innerHTML = `
    <div class="view-header">
      <h2>Activity Feed</h2>
      <p class="text-muted" style="margin:0">Live intelligence from Companies House — charges, directors, filings, PSC changes</p>
    </div>
    ${renderFilters()}
    <div id="activity-feed-body" class="activity-feed-body">
      ${renderBody()}
    </div>
  `;

  bindEvents();
}

function bindEvents(): void {
  const container = document.getElementById("view-activity-feed");
  if (!container) return;

  container.querySelectorAll<HTMLButtonElement>(".p-filter-chip[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.type!;
      if (state.selectedTypes.has(t)) state.selectedTypes.delete(t);
      else state.selectedTypes.add(t);
      void loadAndRender();
    });
  });

  container.querySelectorAll<HTMLButtonElement>(".p-date-preset[data-hours]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const h = btn.dataset.hours;
      state.timeRangeHours = h ? parseInt(h, 10) : null;
      void loadAndRender();
    });
  });

  const searchInput = document.getElementById("activity-company-search") as HTMLInputElement | null;
  let searchDebounce: ReturnType<typeof setTimeout>;
  searchInput?.addEventListener("input", () => {
    state.companySearch = searchInput.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void loadAndRender(), 300);
  });
}

async function loadAndRender(): Promise<void> {
  const body = document.getElementById("activity-feed-body");
  if (body) body.innerHTML = `<div class="activity-empty-state">Loading…</div>`;

  try {
    const [status, events] = await Promise.all([
      getActivityStatus().catch(() => ({ configured: false })),
      getGlobalActivityFeed({
        eventTypes: state.selectedTypes.size > 0 ? Array.from(state.selectedTypes).join(",") : undefined,
        since: sinceFromHours(state.timeRangeHours),
        companyName: state.companySearch || undefined,
      }).catch(() => []),
    ]);
    state.configured = status.configured;
    state.events = events as ActivityEvent[];
  } catch {
    state.events = [];
  }

  if (body) body.innerHTML = renderBody();
}

export function initActivityFeed(): void {
  render();
  void loadAndRender();

  // Restart auto-refresh interval each time the view is rendered
  if (state.pollingInterval) clearInterval(state.pollingInterval);
  state.pollingInterval = setInterval(() => {
    const isVisible = !document.getElementById("view-activity-feed")?.classList.contains("hidden");
    if (isVisible) void loadAndRender();
  }, 60_000);
}
