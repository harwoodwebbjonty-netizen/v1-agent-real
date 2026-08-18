import {
  addChargeAsLead,
  getActivityStatus,
  getChargeFeed,
  getChargeFeedStatus,
  getGlobalActivityFeed,
  type ActivityEvent,
  type ChCharge,
} from "../api";
import { escapeHtml, skeletonBlockHtml } from "../utils";

// ── Filing type labels (all common CH types) ────────────────────────────────
const FILING_LABELS: Record<string, string> = {
  AA: "Annual Accounts", AA01: "Amended Accounts", AAMD: "Amended Accounts",
  CS01: "Confirmation Statement",
  AP01: "Director Appointed", AP02: "Corporate Director Appointed",
  AP03: "Secretary Appointed", AP04: "Corporate Secretary Appointed",
  TM01: "Director Resigned", TM02: "Corporate Director Resigned",
  TM03: "Secretary Resigned", TM04: "Corporate Secretary Resigned",
  CH01: "Director Details Changed", CH02: "Corporate Director Details Changed",
  PSC01: "PSC Registered", PSC02: "Corporate PSC Registered",
  PSC03: "Legal Entity PSC Registered",
  PSC07: "PSC Ceased", PSC08: "Corporate PSC Ceased", PSC09: "Legal Entity PSC Ceased",
  MR01: "New Charge", MR02: "New Charge", MR03: "New Charge (Overseas)",
  MR04: "Charge Satisfied", MR05: "Charge Part-Satisfied",
  SH01: "Shares Allotted", SH06: "Shares Cancelled",
  AD01: "Address Changed", AD02: "SAIL Address Changed",
  NM01: "Name Changed", NM04: "Name Changed (Court Order)",
  DISS40: "Strike Off Notice", DISS16: "Strike Off Suspended",
  GAZ1: "Gazette Notice", GAZ2: "Final Gazette Notice",
};

// Grouped filter chips for CH filings
const CH_FILTER_GROUPS: { label: string; types: string[] }[] = [
  { label: "Directors",     types: ["AP01", "AP02", "TM01", "TM02", "CH01", "CH02"] },
  { label: "PSC",           types: ["PSC01", "PSC02", "PSC03", "PSC07", "PSC08", "PSC09"] },
  { label: "Charges",       types: ["MR01", "MR02", "MR03", "MR04", "MR05"] },
  { label: "Accounts",      types: ["AA", "AA01", "AAMD"] },
  { label: "Confirmation",  types: ["CS01"] },
  { label: "Shares",        types: ["SH01", "SH06"] },
  { label: "Address / Name", types: ["AD01", "NM01", "NM04"] },
  { label: "Strike Off",    types: ["DISS40", "GAZ1", "GAZ2"] },
];

const ACT_EVENT_TYPES = [
  "NEW_CHARGE", "CHARGE_SATISFIED", "CHARGE_UPDATED",
  "DIRECTOR_APPOINTMENT", "DIRECTOR_RESIGNATION", "PSC_CHANGE",
  "RISK_INCREASE", "FINANCIAL_CHANGE", "COMPANY_EVENT",
];

const TIME_RANGES: { label: string; hours: number | null }[] = [
  { label: "24h",     hours: 24 },
  { label: "7 days",  hours: 7 * 24 },
  { label: "30 days", hours: 30 * 24 },
  { label: "All time", hours: null },
];

const PAGE_SIZE = 100;

// ── State ───────────────────────────────────────────────────────────────────
interface State {
  tab: "ch" | "dg";
  // CH filings
  chCharges: ChCharge[];
  chLoading: boolean;
  chConfigured: boolean;
  chLoadFailed: boolean;
  chTimepoint: string | null;
  chSearch: string;
  chGroups: Set<string>;   // selected group labels
  chNotAdded: boolean;
  chOffset: number;
  chHasMore: boolean;
  chAddingIds: Set<string>;
  // Lead activity (Companies House) — dg* names kept for stable data-attr wiring
  dgEvents: ActivityEvent[];
  dgLoading: boolean;
  dgConfigured: boolean;
  dgLoadFailed: boolean;
  dgSearch: string;
  dgTypes: Set<string>;
  dgHours: number | null;
  // shared
  poll: ReturnType<typeof setInterval> | null;
}

const s: State = {
  tab: "ch",
  chCharges: [], chLoading: false, chConfigured: false, chLoadFailed: false,
  // Default to Charges — debentures and new borrowing are the signal this
  // feed exists for; director changes etc. are opt-in via the chips.
  chTimepoint: null, chSearch: "", chGroups: new Set(["Charges"]),
  chNotAdded: false, chOffset: 0, chHasMore: false, chAddingIds: new Set(),
  dgEvents: [], dgLoading: false, dgConfigured: false, dgLoadFailed: false,
  dgSearch: "", dgTypes: new Set(), dgHours: 7 * 24,
  poll: null,
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function formatTime(iso: string): string {
  const d = new Date(iso);
  const diffH = (Date.now() - d.getTime()) / 3600000;
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${Math.floor(diffH)}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function sinceFromHours(h: number | null): string | undefined {
  if (!h) return undefined;
  return new Date(Date.now() - h * 3600000).toISOString();
}

// Expand group labels → individual filing type codes
function chSelectedTypes(): string[] {
  const types: string[] = [];
  for (const grp of CH_FILTER_GROUPS) {
    if (s.chGroups.has(grp.label)) types.push(...grp.types);
  }
  return types;
}

// ── CH Filings rendering ─────────────────────────────────────────────────────
function chBadge(type: string): string {
  const label = FILING_LABELS[type] ?? type;
  const isMortgage = ["MR01","MR02","MR03"].includes(type);
  const isRisk = ["DISS40","GAZ1","GAZ2"].includes(type);
  const isDir = ["AP01","AP02","TM01","TM02"].includes(type);
  const cls = isMortgage ? "charge-badge-new"
    : isRisk ? "charge-badge-satisfied"
    : isDir  ? "charge-badge-director"
    : "charge-badge-default";
  return `<span class="charge-badge ${cls}">${escapeHtml(label)}</span>`;
}

function renderChRow(c: ChCharge): string {
  const added = !!c.lead_id;
  const adding = s.chAddingIds.has(c.id);
  const btn = added
    ? `<span class="charge-added-label">In Leads</span>`
    : `<button class="btn btn-sm btn-secondary cf-add-btn" data-id="${c.id}" ${adding ? "disabled" : ""}>
         ${adding ? "Adding…" : "Add to Leads"}
       </button>`;
  return `
    <div class="charge-feed-row" data-charge-id="${c.id}">
      <div class="charge-feed-row-main">
        <span class="charge-company">${escapeHtml(c.company_name ?? c.company_number)}</span>
        ${c.company_name ? `<span class="company-number mono">${escapeHtml(c.company_number)}</span>` : ""}
        ${chBadge(c.filing_type)}
        <span class="charge-desc">${escapeHtml(c.charge_description ?? "")}</span>
      </div>
      <div class="charge-feed-row-meta">
        <span class="charge-reg-date">${c.filing_date ? escapeHtml(c.filing_date) : ""}</span>
        <span class="charge-detected">${formatTime(c.detected_at)}</span>
        ${btn}
      </div>
    </div>`;
}

function renderChFilters(): string {
  const chips = CH_FILTER_GROUPS.map(({ label }) => {
    const active = s.chGroups.has(label);
    return `<button class="p-filter-chip ${active ? "active" : ""}" data-ch-group="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
  }).join("");
  return `
    <div class="charge-feed-filters">
      <div class="charge-filter-row">
        <label class="p-section-label">Filing category</label>
        <div class="charge-type-chips">${chips}</div>
      </div>
      <div class="charge-filter-row">
        <input id="cf-search" type="text" class="inline-edit" placeholder="Search company name…"
          value="${escapeHtml(s.chSearch)}" style="max-width:280px" />
        <button class="p-filter-chip ${s.chNotAdded ? "active" : ""}" id="cf-not-added">Not yet added</button>
      </div>
    </div>`;
}

function renderChBody(): string {
  if (s.chLoadFailed) {
    return `<div class="activity-empty-state">
      <strong>Couldn't load the charge feed</strong>
      <p class="text-muted">The backend may be unreachable — check your connection and try again.</p>
    </div>`;
  }
  if (!s.chConfigured) {
    return `<div class="activity-empty-state">
      <strong>Charge feed not configured</strong>
      <p class="text-muted">Add <code>COMPANIES_HOUSE_STREAM_KEY</code> to the backend <code>.env</code> and restart.</p>
    </div>`;
  }
  if (s.chLoading && s.chCharges.length === 0) {
    return skeletonBlockHtml(4);
  }
  if (s.chCharges.length === 0) {
    return `<div class="activity-empty-state">No filings yet — the stream will populate this feed automatically.</div>`;
  }
  const rows = s.chCharges.map(renderChRow).join("");
  const more = s.chHasMore
    ? `<div class="cf-load-more-wrap"><button class="btn btn-secondary" id="cf-load-more">Load more</button></div>` : "";
  return rows + more;
}

// ── Lead activity (Companies House) rendering ────────────────────────────────
function renderDgRow(ev: ActivityEvent): string {
  const label = ev.event_type.replace(/_/g, " ");
  return `
    <div class="activity-feed-row">
      <div class="activity-event-body">
        <div class="activity-event-header">
          <span class="activity-feed-company">${escapeHtml(ev.company_name)}</span>
          <span class="company-number mono">${escapeHtml(ev.company_number)}</span>
          <span class="event-badge event-badge-${ev.event_type}">${escapeHtml(label)}</span>
          <span class="activity-event-desc">${escapeHtml(ev.description)}</span>
          <span class="activity-event-time">${formatTime(ev.detected_at)}</span>
        </div>
      </div>
    </div>`;
}

function renderDgFilters(): string {
  const chips = ACT_EVENT_TYPES.map((t) => {
    const active = s.dgTypes.has(t);
    return `<button class="p-filter-chip ${active ? "active" : ""}" data-dg-type="${t}">${t.replace(/_/g, " ")}</button>`;
  }).join("");
  const rangeButtons = TIME_RANGES.map(({ label, hours }) =>
    `<button class="p-date-preset ${s.dgHours === hours ? "active" : ""}" data-dg-hours="${hours ?? ""}">${label}</button>`
  ).join("");
  return `
    <div class="activity-feed-filters">
      <div class="activity-filter-row">
        <label class="p-section-label">Event Type</label>
        <div class="activity-type-chips">${chips}</div>
      </div>
      <div class="activity-filter-row">
        <label class="p-section-label">Time Range</label>
        <div class="p-date-presets">${rangeButtons}</div>
      </div>
      <div class="activity-filter-row">
        <label class="p-section-label">Company</label>
        <input id="dg-search" type="text" class="inline-edit" placeholder="Filter by company name…"
          value="${escapeHtml(s.dgSearch)}" style="max-width:280px" />
      </div>
    </div>`;
}

function renderDgBody(): string {
  if (s.dgLoadFailed) {
    return `<div class="activity-empty-state">
      <strong>Couldn't load the activity feed</strong>
      <p class="text-muted">The backend may be unreachable — check your connection and try again.</p>
    </div>`;
  }
  if (!s.dgConfigured) {
    return `<div class="activity-empty-state">
      <strong>Activity feed not configured</strong>
      <p class="text-muted">Add <code>COMPANIES_HOUSE_API_KEY</code> to the backend <code>.env</code> to enable lead activity signals.</p>
    </div>`;
  }
  if (s.dgLoading && s.dgEvents.length === 0) return skeletonBlockHtml(4);
  if (s.dgEvents.length === 0) return `<div class="activity-empty-state">No events found for the selected filters.</div>`;
  return s.dgEvents.map(renderDgRow).join("");
}

// ── Main render ──────────────────────────────────────────────────────────────
function render(): void {
  const container = document.getElementById("view-activity-feed");
  if (!container) return;

  const tp = s.chTimepoint
    ? `<span class="cf-timepoint-label" title="Stream position">TP ${s.chTimepoint}</span>` : "";

  const chActive = s.tab === "ch";
  container.innerHTML = `
    <div class="view-header">
      <header class="page-head">
        <div>
          <h1 class="page-title">Activity Feed ${chActive ? tp : ""}</h1>
          <div class="page-meta"><span>${chActive
            ? "Live Companies House filings — all types, streamed in real time"
            : "Lead activity signals from Companies House for companies in your CRM"}</span></div>
        </div>
      </header>
    </div>
    <div class="af-tab-bar">
      <button class="af-tab ${chActive ? "active" : ""}" data-tab="ch">
        CH Filings
      </button>
      <button class="af-tab ${!chActive ? "active" : ""}" data-tab="dg">
        Lead Activity
      </button>
    </div>
    ${chActive ? renderChFilters() : renderDgFilters()}
    <div id="af-body" class="${chActive ? "charge-feed-body" : "activity-feed-body"}">
      ${chActive ? renderChBody() : renderDgBody()}
    </div>`;

  bindEvents(container);
}

function rebuildBody(): void {
  const body = document.getElementById("af-body");
  if (!body) return;
  body.innerHTML = s.tab === "ch" ? renderChBody() : renderDgBody();
  // Only the body is re-rendered here, so only re-bind body-level handlers.
  // The filter chips persist across reloads — re-binding them (as the old
  // combined bindEvents did on every load, incl. the 30s poll) stacked up
  // duplicate listeners, so each chip click toggled an even number of times
  // and cancelled itself out.
  const container = document.getElementById("view-activity-feed");
  if (container) bindBodyEvents(container);
}

// ── Event binding ────────────────────────────────────────────────────────────
function bindEvents(container: HTMLElement): void {
  bindFilterEvents(container);
  bindBodyEvents(container);
}

// Filters live outside #af-body and are only re-created by a full render(),
// so their handlers are bound once per render — never from rebuildBody().
function bindFilterEvents(container: HTMLElement): void {
  // Tab switches
  container.querySelectorAll<HTMLButtonElement>(".af-tab[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      s.tab = btn.dataset.tab as "ch" | "dg";
      render();
    });
  });

  // CH group chips (multi-select) — toggle .active immediately for feedback
  container.querySelectorAll<HTMLButtonElement>("[data-ch-group]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = btn.dataset.chGroup!;
      if (s.chGroups.has(g)) s.chGroups.delete(g); else s.chGroups.add(g);
      btn.classList.toggle("active", s.chGroups.has(g));
      s.chOffset = 0;
      void loadCh(true);
    });
  });

  // CH not-added toggle
  const notAdded = document.getElementById("cf-not-added");
  notAdded?.addEventListener("click", () => {
    s.chNotAdded = !s.chNotAdded;
    notAdded.classList.toggle("active", s.chNotAdded);
    s.chOffset = 0;
    void loadCh(true);
  });

  // CH company search
  let chDebounce: ReturnType<typeof setTimeout>;
  const cfSearch = document.getElementById("cf-search") as HTMLInputElement | null;
  cfSearch?.addEventListener("input", () => {
    s.chSearch = cfSearch.value;
    clearTimeout(chDebounce);
    chDebounce = setTimeout(() => { s.chOffset = 0; void loadCh(true); }, 300);
  });

  // DG type chips (multi-select)
  container.querySelectorAll<HTMLButtonElement>("[data-dg-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.dgType!;
      if (s.dgTypes.has(t)) s.dgTypes.delete(t); else s.dgTypes.add(t);
      btn.classList.toggle("active", s.dgTypes.has(t));
      void loadDg();
    });
  });

  // DG time range (single-select)
  container.querySelectorAll<HTMLButtonElement>("[data-dg-hours]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const h = btn.dataset.dgHours;
      s.dgHours = h ? parseInt(h, 10) : null;
      container.querySelectorAll<HTMLButtonElement>("[data-dg-hours]")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      void loadDg();
    });
  });

  // DG company search
  let dgDebounce: ReturnType<typeof setTimeout>;
  const dgSearch = document.getElementById("dg-search") as HTMLInputElement | null;
  dgSearch?.addEventListener("input", () => {
    s.dgSearch = dgSearch.value;
    clearTimeout(dgDebounce);
    dgDebounce = setTimeout(() => void loadDg(), 300);
  });
}

// Body-level handlers — safe to re-bind after every rebuildBody() because the
// body is fully re-rendered each time, so no listeners survive to duplicate.
function bindBodyEvents(container: HTMLElement): void {
  // CH load more
  document.getElementById("cf-load-more")?.addEventListener("click", () => {
    s.chOffset += PAGE_SIZE;
    void loadCh(false);
  });

  // CH add to leads
  container.querySelectorAll<HTMLButtonElement>(".cf-add-btn").forEach((btn) => {
    btn.addEventListener("click", () => { void handleAddToLeads(btn.dataset.id!); });
  });
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function handleAddToLeads(chargeId: string): Promise<void> {
  s.chAddingIds.add(chargeId);
  const btn = document.querySelector<HTMLButtonElement>(`.cf-add-btn[data-id="${chargeId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
  try {
    const result = await addChargeAsLead(chargeId);
    const charge = s.chCharges.find((c) => c.id === chargeId);
    if (charge) charge.lead_id = result.lead_id;
    s.chAddingIds.delete(chargeId);
    const row = document.querySelector<HTMLElement>(`.charge-feed-row[data-charge-id="${chargeId}"]`);
    if (row && charge) {
      row.outerHTML = renderChRow(charge);
      document.querySelector<HTMLButtonElement>(`.cf-add-btn[data-id="${chargeId}"]`)
        ?.addEventListener("click", () => void handleAddToLeads(chargeId));
    }
  } catch {
    s.chAddingIds.delete(chargeId);
    if (btn) { btn.disabled = false; btn.textContent = "Add to Leads"; }
  }
}

async function loadCh(reset = false): Promise<void> {
  const types = chSelectedTypes();
  s.chLoadFailed = false;
  try {
    // No per-call .catch() here on purpose — letting either request's
    // rejection reach this outer catch is what lets us tell "backend
    // unreachable" (chLoadFailed) apart from "reachable, but genuinely not
    // configured" (chConfigured: false, a real, successful response).
    const [status, charges] = await Promise.all([
      getChargeFeedStatus(),
      getChargeFeed({
        companyName: s.chSearch || undefined,
        filingTypes: types.length > 0 ? types.join(",") : undefined,
        notAdded: s.chNotAdded,
        limit: PAGE_SIZE,
        offset: s.chOffset,
      }),
    ]);
    s.chConfigured = status.configured;
    s.chTimepoint = status.timepoint ?? null;
    if (reset || s.chOffset === 0) s.chCharges = charges;
    else s.chCharges = [...s.chCharges, ...charges];
    s.chHasMore = charges.length >= PAGE_SIZE;
  } catch (err) {
    console.error("Activity Feed: failed to load charge feed", err);
    s.chLoadFailed = true;
    if (reset) s.chCharges = [];
  }
  if (s.tab === "ch") rebuildBody();
}

async function loadDg(): Promise<void> {
  s.dgLoadFailed = false;
  try {
    const [status, events] = await Promise.all([
      getActivityStatus(),
      getGlobalActivityFeed({
        eventTypes: s.dgTypes.size > 0 ? Array.from(s.dgTypes).join(",") : undefined,
        since: sinceFromHours(s.dgHours),
        companyName: s.dgSearch || undefined,
      }),
    ]);
    s.dgConfigured = status.configured;
    s.dgEvents = events as ActivityEvent[];
  } catch (err) {
    console.error("Activity Feed: failed to load activity feed", err);
    s.dgLoadFailed = true;
    s.dgEvents = [];
  }
  if (s.tab === "dg") rebuildBody();
}

// ── Init ─────────────────────────────────────────────────────────────────────
export function initActivityFeed(): void {
  render();
  void loadCh(true);
  void loadDg();

  if (s.poll) clearInterval(s.poll);
  s.poll = setInterval(() => {
    const visible = document.getElementById("view-activity-feed")?.style.display !== "none";
    if (!visible) return;
    if (s.tab === "ch") { s.chOffset = 0; void loadCh(true); }
    else void loadDg();
  }, 30_000);
}
