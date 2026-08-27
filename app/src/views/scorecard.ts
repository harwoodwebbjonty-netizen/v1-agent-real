import {
  getScorecardSettings,
  getScorecardWeeks,
  getScorecardWeeksAll,
  listTeamMembers,
  saveScorecardWeek,
  updateScorecardSettings,
  upsertScorecardWeek,
  type ScorecardEntryInput,
  type ScorecardMetricKey,
  type ScorecardSettings,
  type ScorecardSummaryEntry,
  type ScorecardWeek,
  type UserInfo,
} from "../api";
import { getCurrentUser, hasPermission, subscribeAuth } from "../auth";
import { confirmDialog, openOverlay } from "../components/modal";
import { showToast } from "../toast";
import { escapeHtml } from "../utils";

// Merged in from the standalone wcf-scorecard.web.app Firebase app (see
// PROJECT_CONTEXT.md). Metric names/units/weights stay hardcoded here,
// matching the source app — only the numeric target and RAG thresholds were
// ever actually editable in its own Settings tab, and that's all the
// backend's scorecard_metric_targets/scorecard_settings store. Weights
// mirror the source app's METRICS array exactly (CRM Compliance is a gate,
// not a scored metric — weight 0 keeps it out of the weighted score).
const METRICS: { key: ScorecardMetricKey; name: string; unit: string; isPercent?: boolean; weight: number }[] = [
  { key: "calls", name: "Calls", unit: "", weight: 0.15 },
  { key: "talk_time", name: "Talk Time", unit: "h", weight: 0.25 },
  { key: "leads", name: "Qualified Leads Passed", unit: "", weight: 0.3 },
  { key: "campaigns", name: "Mass Email Campaigns", unit: "", weight: 0.05 },
  { key: "follow_up", name: "Follow-up Emails", unit: "%", isPercent: true, weight: 0.05 },
  { key: "crm", name: "CRM Compliance", unit: "%", isPercent: true, weight: 0 },
];

type Draft = Record<ScorecardMetricKey, { actual: number | null; notes: string; action: string; source: "manual" | "auto" }>;
type Period = "week" | "month" | "quarter" | "all";
type Rag = "green" | "amber" | "red" | "none";

function emptyDraft(): Draft {
  const draft = {} as Draft;
  for (const m of METRICS) draft[m.key] = { actual: null, notes: "", action: "", source: "manual" };
  return draft;
}

function mondayOf(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatWeekLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function ragClass(pct: number | null, green: number, amber: number): Rag {
  if (pct === null) return "none";
  if (pct >= green) return "green";
  if (pct >= amber) return "amber";
  return "red";
}

function ragLabel(rag: Rag): string {
  switch (rag) {
    case "green":
      return "On track";
    case "amber":
      return "Watch";
    case "red":
      return "Behind";
    default:
      return "—";
  }
}

function pctText(pct: number | null): string {
  return pct === null ? "—" : `${Math.round(pct)}%`;
}

// --- Team-wide math, ported from the source app's mgr*/weightedPctForRows
// functions (WCF_BDE_Weekly_Scorecard_copy.html:983-2376) — same formulas,
// percentage-point units throughout instead of 0-1 fractions (matching this
// file's own entry-form convention above, and the backend's
// green_threshold/amber_threshold which are already stored as percentages). ---

interface PersonWeek {
  week_commencing: string;
  rows: Partial<Record<ScorecardMetricKey, number | null>>;
}

interface PersonSeries {
  userId: string;
  name: string;
  weeks: PersonWeek[]; // sorted ascending by week_commencing
}

function computeCellPct(m: (typeof METRICS)[number], actual: number | null, target: number): number | null {
  if (actual === null) return null;
  if (m.isPercent) return actual;
  return target > 0 ? (actual / target) * 100 : null;
}

function weightedPctForWeek(rows: PersonWeek["rows"], targets: Record<string, number>): number | null {
  let acc = 0;
  let wsum = 0;
  for (const m of METRICS) {
    if (m.weight <= 0) continue;
    const pct = computeCellPct(m, rows[m.key] ?? null, targets[m.key] ?? 0);
    if (pct === null) continue;
    acc += pct * m.weight;
    wsum += m.weight;
  }
  return wsum > 0 ? acc / wsum : null;
}

function scoreSeries(person: PersonSeries, targets: Record<string, number>): number[] {
  return person.weeks.map((w) => weightedPctForWeek(w.rows, targets)).filter((v): v is number => v !== null);
}

function periodScopedWeeks(person: PersonSeries, period: Period): PersonWeek[] {
  const n = period === "week" ? 1 : period === "month" ? 4 : period === "quarter" ? 13 : person.weeks.length;
  return person.weeks.slice(-n);
}

function periodScore(person: PersonSeries, targets: Record<string, number>, period: Period): number | null {
  const scores = periodScopedWeeks(person, period)
    .map((w) => weightedPctForWeek(w.rows, targets))
    .filter((v): v is number => v !== null);
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

function latestScore(person: PersonSeries, targets: Record<string, number>): number | null {
  const s = scoreSeries(person, targets);
  return s.length ? s[s.length - 1] : null;
}

function trendOf(person: PersonSeries, targets: Record<string, number>): { dir: "up" | "down" | "flat"; delta: number | null; declining: number } {
  const s = scoreSeries(person, targets);
  if (s.length < 2) return { dir: "flat", delta: null, declining: 0 };
  const delta = s[s.length - 1] - s[s.length - 2];
  let declining = 0;
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i] < s[i - 1] - 0.01) declining++;
    else break;
  }
  const dir = delta > 0.5 ? "up" : delta < -0.5 ? "down" : "flat";
  return { dir, delta, declining };
}

function streakOf(person: PersonSeries, targets: Record<string, number>, green: number): number {
  const s = scoreSeries(person, targets);
  let n = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] >= green) n++;
    else break;
  }
  return n;
}

function consistencyOf(person: PersonSeries, targets: Record<string, number>): { label: string } {
  const s = scoreSeries(person, targets).slice(-8);
  if (s.length < 2) return { label: "New" };
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) * (b - mean), 0) / s.length);
  return sd <= 10 ? { label: "Steady" } : { label: "Swingy" };
}

function conversionOf(person: PersonSeries, period: Period): { callsPerLead: number | null; talkPerCall: string } {
  let calls = 0;
  let leads = 0;
  let talkH = 0;
  let hasCalls = false;
  let hasLeads = false;
  for (const w of periodScopedWeeks(person, period)) {
    const c = w.rows.calls;
    const l = w.rows.leads;
    const t = w.rows.talk_time;
    if (c !== null && c !== undefined) {
      calls += c;
      hasCalls = true;
    }
    if (l !== null && l !== undefined) {
      leads += l;
      hasLeads = true;
    }
    if (t !== null && t !== undefined) talkH += t;
  }
  const callsPerLead = hasCalls && hasLeads && leads > 0 ? calls / leads : null;
  const talkPerCallSecs = hasCalls && calls > 0 ? (talkH * 3600) / calls : null;
  return { callsPerLead, talkPerCall: fmtSecs(talkPerCallSecs) };
}

function fmtSecs(s: number | null): string {
  if (s === null || isNaN(s)) return "–";
  const rounded = Math.round(s);
  if (rounded < 60) return `${rounded}s`;
  const m = Math.floor(rounded / 60);
  const r = rounded % 60;
  return `${m}m ${r < 10 ? "0" : ""}${r}s`;
}

function sparklineSvg(series: number[]): string {
  const w = 64;
  const h = 22;
  const pad = 3;
  if (series.length < 2) return "";
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo || 1;
  const pts = series
    .map((v, i) => {
      const x = pad + (w - 2 * pad) * (i / (series.length - 1));
      const y = h - pad - (h - 2 * pad) * ((v - lo) / span);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" aria-hidden="true"><polyline points="${pts}" stroke="var(--accent, #E31346)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// --- CSV "Import calls" — bulk-fills Calls/Talk Time for the current week
// from a phone system's extension-overview export. Ported near-verbatim
// from the source app (decodeUploadedText/durationToHours/parseCallsCsv/
// matchProfileByName, WCF_BDE_Weekly_Scorecard_copy.html:2694-2781), just
// matched against real CRM users instead of free-text profile names. ---

function decodeUploadedText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
  return new TextDecoder("utf-8").decode(buffer);
}

function durationToHours(str: string): number | null {
  const m = /(\d+)\s*d\s*(\d+)\s*h\s*(\d+)\s*m\s*(\d+)\s*s/i.exec(str || "");
  if (!m) return null;
  const hours = Number(m[1]) * 24 + Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600;
  return Math.round(hours * 100) / 100;
}

function cleanCsvName(raw: string): string {
  return (raw || "")
    .replace(/\(\s*\d+\s*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface CsvCallRow {
  name: string;
  calls: number | null;
  talkHours: number | null;
}

function parseCallsCsv(text: string): CsvCallRow[] {
  const out: CsvCallRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split("\t").map((c) => c.trim());
    const first = cells[0] || "";
    if (!first || first.toLowerCase() === "extension") continue;
    const name = cleanCsvName(first);
    if (!name) continue;
    const callsNum = parseInt((cells[2] || "").replace(/[^\d]/g, ""), 10);
    out.push({ name, calls: isNaN(callsNum) ? null : callsNum, talkHours: durationToHours(cells[5] || "") });
  }
  return out;
}

function matchMemberByName(csvName: string, members: UserInfo[]): UserInfo | null {
  const norm = (v: string) => (v || "").toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(csvName);
  if (!target) return null;
  const first = target.split(" ")[0];
  let m = members.filter((u) => norm(u.name) === target);
  if (m.length === 1) return m[0];
  m = members.filter((u) => {
    const nm = norm(u.name);
    return nm && (target.startsWith(nm) || nm.startsWith(target));
  });
  if (m.length === 1) return m[0];
  m = members.filter((u) => norm(u.name).split(" ")[0] === first);
  if (m.length === 1) return m[0];
  return null;
}

function buildPersonSeries(summary: ScorecardSummaryEntry[], members: UserInfo[]): PersonSeries[] {
  const byUser = new Map<string, Map<string, PersonWeek>>();
  for (const e of summary) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, new Map());
    const weeks = byUser.get(e.user_id)!;
    if (!weeks.has(e.week_commencing)) weeks.set(e.week_commencing, { week_commencing: e.week_commencing, rows: {} });
    weeks.get(e.week_commencing)!.rows[e.metric_key as ScorecardMetricKey] = e.actual;
  }
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  return [...byUser.entries()].map(([userId, weeks]) => ({
    userId,
    name: nameById.get(userId) ?? "Unknown",
    weeks: [...weeks.values()].sort((a, b) => (a.week_commencing < b.week_commencing ? -1 : 1)),
  }));
}

export function initScorecard(): void {
  const container = document.querySelector<HTMLDivElement>("#view-scorecard")!;
  container.innerHTML = `
    <main class="container">
      <header class="page-head">
        <div>
          <h1 class="page-title">Scorecard</h1>
          <div class="page-meta"><span>Weekly performance tracking</span></div>
        </div>
      </header>

      <div class="sub-view-tabs">
        <button class="sub-view-tab active" data-sub="entry">My Scorecard</button>
        <button class="sub-view-tab" data-sub="dashboard">Dashboard</button>
        <button class="sub-view-tab hidden" data-sub="manager" id="sc-tab-manager">Manager</button>
        <button class="sub-view-tab hidden" data-sub="settings" id="sc-tab-settings">Settings</button>
      </div>

      <div id="sc-view-entry">
        <div class="sec-head">
          <span class="sec-num">01</span>
          <h3 class="action-section-title">Week of <span id="sc-week-label"></span></h3>
          <span class="sec-rule"></span>
          <span class="sc-week-nav">
            <button type="button" class="btn-ghost" id="sc-week-prev" title="Previous week">‹</button>
            <button type="button" class="btn-ghost" id="sc-week-today">This week</button>
            <button type="button" class="btn-ghost" id="sc-week-next" title="Next week">›</button>
          </span>
        </div>
        <section class="panel">
          <div class="scorecard-table-wrap">
            <table class="scorecard-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Target</th>
                  <th>Actual</th>
                  <th>%</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="sc-entry-rows"></tbody>
            </table>
          </div>
        </section>
        <div class="sc-actions">
          <span class="mono sc-saved-label" id="sc-saved-label"></span>
          <button type="button" class="btn-primary" id="sc-save-btn">Save this week</button>
        </div>
      </div>

      <div id="sc-view-dashboard" class="hidden">
        <div class="sec-head">
          <span class="sec-num">01</span>
          <h3 class="action-section-title">Team leaderboard</h3>
          <span class="sec-rule"></span>
          <select id="sc-dash-period" class="sc-period-select">
            <option value="week">This week</option>
            <option value="month">Last 4 weeks</option>
            <option value="quarter">Last 13 weeks</option>
            <option value="all" selected>All time</option>
          </select>
        </div>
        <section class="metrics" id="sc-dash-kpis"></section>

        <section class="panel" id="sc-dash-leaderboard"></section>

        <div class="sec-head">
          <span class="sec-num">02</span>
          <h3 class="action-section-title">Team performance by metric</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel">
          <div class="scorecard-table-wrap">
            <table class="scorecard-table">
              <thead><tr><th>Metric</th><th>Team average</th><th>Status</th></tr></thead>
              <tbody id="sc-dash-metric-rows"></tbody>
            </table>
          </div>
        </section>
      </div>

      <div id="sc-view-manager" class="hidden">
        <div class="sec-head">
          <span class="sec-num">01</span>
          <h3 class="action-section-title">Team snapshot</h3>
          <span class="sec-rule"></span>
          <select id="sc-mgr-period" class="sc-period-select">
            <option value="week" selected>This week</option>
            <option value="month">Last 4 weeks</option>
            <option value="quarter">Last 13 weeks</option>
            <option value="all">All time</option>
          </select>
        </div>
        <section class="metrics" id="sc-mgr-kpis"></section>

        <div class="sec-head">
          <span class="sec-num">02</span>
          <h3 class="action-section-title">Needs attention</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel" id="sc-mgr-attention"></section>

        <div class="sec-head">
          <span class="sec-num">03</span>
          <h3 class="action-section-title">Leaderboard</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel" id="sc-mgr-leaderboard"></section>

        <div class="sec-head">
          <span class="sec-num">04</span>
          <h3 class="action-section-title">Import calls (this week)</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel sc-import-zone" id="sc-import-zone">
          <p>Drop the phone system's extension-overview export here, or</p>
          <label class="btn-ghost sc-import-browse">
            Browse file
            <input type="file" id="sc-import-file-input" accept=".csv,.txt,text/csv,text/plain" class="hidden" />
          </label>
          <p class="sc-import-hint">Bulk-fills Calls and Talk Time for this week only — every other metric, note and action is left untouched.</p>
        </section>
      </div>

      <div id="sc-view-settings" class="hidden">
        <div class="sec-head">
          <span class="sec-num">01</span>
          <h3 class="action-section-title">Targets</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel">
          <div class="scorecard-table-wrap">
            <table class="scorecard-table">
              <thead>
                <tr><th>Metric</th><th>Weekly target</th></tr>
              </thead>
              <tbody id="sc-target-rows"></tbody>
            </table>
          </div>
        </section>

        <div class="sec-head">
          <span class="sec-num">02</span>
          <h3 class="action-section-title">RAG thresholds &amp; visibility</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel sc-settings-form">
          <label>Green threshold (% of target)
            <input type="number" id="sc-green-input" min="0" max="200" />
          </label>
          <label>Amber threshold (% of target)
            <input type="number" id="sc-amber-input" min="0" max="200" />
          </label>
          <label>Notes &amp; action visibility
            <select id="sc-visibility-input">
              <option value="manager_only">Managers only</option>
              <option value="team">Whole team</option>
            </select>
          </label>
        </section>
        <div class="sc-actions">
          <button type="button" class="btn-primary" id="sc-settings-save-btn">Save settings</button>
        </div>
      </div>
    </main>
  `;

  const weekLabelEl = container.querySelector<HTMLSpanElement>("#sc-week-label")!;
  const rowsEl = container.querySelector<HTMLTableSectionElement>("#sc-entry-rows")!;
  const savedLabelEl = container.querySelector<HTMLSpanElement>("#sc-saved-label")!;
  const saveBtn = container.querySelector<HTMLButtonElement>("#sc-save-btn")!;
  const settingsTab = container.querySelector<HTMLButtonElement>("#sc-tab-settings")!;
  const managerTab = container.querySelector<HTMLButtonElement>("#sc-tab-manager")!;
  const entryView = container.querySelector<HTMLDivElement>("#sc-view-entry")!;
  const dashboardView = container.querySelector<HTMLDivElement>("#sc-view-dashboard")!;
  const managerView = container.querySelector<HTMLDivElement>("#sc-view-manager")!;
  const settingsView = container.querySelector<HTMLDivElement>("#sc-view-settings")!;
  const targetRowsEl = container.querySelector<HTMLTableSectionElement>("#sc-target-rows")!;
  const greenInput = container.querySelector<HTMLInputElement>("#sc-green-input")!;
  const amberInput = container.querySelector<HTMLInputElement>("#sc-amber-input")!;
  const visibilityInput = container.querySelector<HTMLSelectElement>("#sc-visibility-input")!;
  const settingsSaveBtn = container.querySelector<HTMLButtonElement>("#sc-settings-save-btn")!;
  const dashPeriodSelect = container.querySelector<HTMLSelectElement>("#sc-dash-period")!;
  const dashKpisEl = container.querySelector<HTMLDivElement>("#sc-dash-kpis")!;
  const dashLeaderboardEl = container.querySelector<HTMLDivElement>("#sc-dash-leaderboard")!;
  const dashMetricRowsEl = container.querySelector<HTMLTableSectionElement>("#sc-dash-metric-rows")!;
  const mgrPeriodSelect = container.querySelector<HTMLSelectElement>("#sc-mgr-period")!;
  const mgrKpisEl = container.querySelector<HTMLDivElement>("#sc-mgr-kpis")!;
  const mgrAttentionEl = container.querySelector<HTMLDivElement>("#sc-mgr-attention")!;
  const mgrLeaderboardEl = container.querySelector<HTMLDivElement>("#sc-mgr-leaderboard")!;
  const importZoneEl = container.querySelector<HTMLDivElement>("#sc-import-zone")!;
  const importFileInput = container.querySelector<HTMLInputElement>("#sc-import-file-input")!;

  let currentWeek = toIsoDate(mondayOf(new Date()));
  let draft: Draft = emptyDraft();
  let savedAt: string | null = null;
  let settings: ScorecardSettings | null = null;
  let overriddenKeys = new Set<ScorecardMetricKey>();
  let loadToken = 0;
  let people: PersonSeries[] = [];
  let allMembers: UserInfo[] = [];
  let teamLoaded = false;

  function targetsMap(): Record<string, number> {
    const map: Record<string, number> = {};
    for (const t of settings?.targets ?? []) map[t.metric_key] = t.target_value;
    return map;
  }

  function renderRows(): void {
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    rowsEl.innerHTML = METRICS.map((m) => {
      const target = settings?.targets.find((t) => t.metric_key === m.key)?.target_value ?? 0;
      const entry = draft[m.key];
      const pct = computeCellPct(m, entry.actual, target);
      const rag = ragClass(pct, green, amber);
      const isAutoBadge = entry.source === "auto" && !overriddenKeys.has(m.key);
      const actualCell = isAutoBadge
        ? `<span class="sc-auto-value" title="Auto-tracked from the CRM">${entry.actual ?? 0}</span>
           <button type="button" class="btn-ghost sc-override-btn" data-metric="${m.key}">Override</button>`
        : `<input type="number" class="sc-actual-input" data-metric="${m.key}" value="${entry.actual ?? ""}" />`;
      return `
        <tr data-metric="${m.key}">
          <td>${escapeHtml(m.name)}${isAutoBadge ? ` <span class="status-badge rag-none sc-auto-badge">Auto (CRM)</span>` : ""}</td>
          <td class="mono">${target}${m.unit}</td>
          <td class="sc-actual-cell">${actualCell}</td>
          <td class="mono">${pctText(pct)}</td>
          <td><span class="status-badge rag-${rag}">${ragLabel(rag)}</span></td>
          <td><input type="text" class="sc-notes-input" data-metric="${m.key}" value="${escapeHtml(entry.notes)}" /></td>
          <td><input type="text" class="sc-action-input" data-metric="${m.key}" value="${escapeHtml(entry.action)}" /></td>
        </tr>`;
    }).join("");

    rowsEl.querySelectorAll<HTMLInputElement>(".sc-actual-input").forEach((el) => {
      el.addEventListener("input", () => {
        const key = el.dataset.metric as ScorecardMetricKey;
        draft[key].actual = el.value === "" ? null : Number(el.value);
      });
      el.addEventListener("change", renderRows);
    });
    rowsEl.querySelectorAll<HTMLButtonElement>(".sc-override-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        overriddenKeys.add(btn.dataset.metric as ScorecardMetricKey);
        renderRows();
      });
    });
    rowsEl.querySelectorAll<HTMLInputElement>(".sc-notes-input").forEach((el) => {
      el.addEventListener("input", () => {
        draft[el.dataset.metric as ScorecardMetricKey].notes = el.value;
      });
    });
    rowsEl.querySelectorAll<HTMLInputElement>(".sc-action-input").forEach((el) => {
      el.addEventListener("input", () => {
        draft[el.dataset.metric as ScorecardMetricKey].action = el.value;
      });
    });
  }

  function applyWeekToDraft(week: ScorecardWeek | undefined): void {
    draft = emptyDraft();
    overriddenKeys = new Set();
    savedAt = week?.saved_at ?? null;
    if (week) {
      for (const m of METRICS) {
        const e = week.entries[m.key];
        if (e) draft[m.key] = { actual: e.actual, notes: e.notes, action: e.action, source: e.source };
      }
    }
    savedLabelEl.textContent = savedAt ? `Saved ${new Date(savedAt).toLocaleString("en-GB")}` : "Not saved yet";
  }

  async function loadWeek(): Promise<void> {
    const user = getCurrentUser();
    if (!user) return;
    weekLabelEl.textContent = formatWeekLabel(currentWeek);
    const token = ++loadToken;
    try {
      const weeks = await getScorecardWeeks(user.id, currentWeek, currentWeek);
      if (token !== loadToken) return;
      applyWeekToDraft(weeks.find((w) => w.week_commencing === currentWeek));
      renderRows();
    } catch (err) {
      if (token !== loadToken) return;
      showToast(err instanceof Error ? err.message : "Failed to load scorecard week");
    }
  }

  async function loadSettings(): Promise<void> {
    try {
      settings = await getScorecardSettings();
      renderRows();
      renderTargetRows();
      greenInput.value = String(settings.green_threshold);
      amberInput.value = String(settings.amber_threshold);
      visibilityInput.value = settings.notes_visibility;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load scorecard settings");
    }
  }

  function renderTargetRows(): void {
    targetRowsEl.innerHTML = METRICS.map((m) => {
      const target = settings?.targets.find((t) => t.metric_key === m.key)?.target_value ?? 0;
      return `
        <tr>
          <td>${escapeHtml(m.name)}</td>
          <td><input type="number" class="sc-target-input" data-metric="${m.key}" value="${target}" /></td>
        </tr>`;
    }).join("");
  }

  async function loadTeamData(): Promise<void> {
    try {
      const [summary, members] = await Promise.all([getScorecardWeeksAll(), listTeamMembers()]);
      people = buildPersonSeries(summary, members);
      allMembers = members;
      teamLoaded = true;
      renderDashboard();
      renderManager();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load team scorecard data");
    }
  }

  async function handleImportFile(file: File): Promise<void> {
    if (!allMembers.length) {
      showToast("Still loading the team — try again in a moment.");
      return;
    }
    let text: string;
    try {
      text = decodeUploadedText(await file.arrayBuffer());
    } catch {
      showToast("Couldn't read that file.");
      return;
    }
    const parsed = parseCallsCsv(text);
    if (!parsed.length) {
      showToast("No people found in that file. Make sure it's the phone system's extension overview export.");
      return;
    }
    const applied: { member: UserInfo; row: CsvCallRow }[] = [];
    const skipped: string[] = [];
    for (const row of parsed) {
      const member = matchMemberByName(row.name, allMembers);
      if (member) applied.push({ member, row });
      else skipped.push(row.name);
    }
    if (!applied.length) {
      showToast("None of the names in that file matched a team member.");
      return;
    }

    const thisWeek = toIsoDate(mondayOf(new Date()));
    const lines = applied.map(({ member, row }) => {
      const parts: string[] = [];
      if (row.calls !== null) parts.push(`${row.calls} calls`);
      if (row.talkHours !== null) parts.push(`${row.talkHours}h talk time`);
      return `${escapeHtml(member.name)}: ${parts.length ? escapeHtml(parts.join(", ")) : "no values found"}`;
    });
    const skippedHtml = skipped.length ? `<p class="conflict-modal-hint">Not matched to a team member (skipped): ${escapeHtml(skipped.join(", "))}</p>` : "";
    const action = await confirmDialog({
      title: `Fill this week's Calls and Talk Time for ${applied.length} ${applied.length === 1 ? "person" : "people"}?`,
      listItemsHtml: lines.map((l) => `<li>${l}</li>`).join(""),
      hintHtml: `Only Calls and Talk Time for the week of ${formatWeekLabel(thisWeek)} are changed — every other metric, note and action is left as it is. Existing values for this week are overwritten.${skippedHtml}`,
      actions: [
        { id: "cancel", label: "Cancel", variant: "ghost" },
        { id: "import", label: "Import", variant: "primary" },
      ],
    });
    if (action !== "import") return;

    try {
      const existingWeeks = await Promise.all(applied.map(({ member }) => getScorecardWeeks(member.id, thisWeek, thisWeek)));
      await Promise.all(
        applied.map(async ({ member, row }, i) => {
          const existing = existingWeeks[i].find((w) => w.week_commencing === thisWeek);
          const entries: Record<string, ScorecardEntryInput> = {};
          if (row.calls !== null) {
            entries.calls = { actual: row.calls, notes: existing?.entries.calls?.notes ?? "", action: existing?.entries.calls?.action ?? "" };
          }
          if (row.talkHours !== null) {
            entries.talk_time = {
              actual: row.talkHours,
              notes: existing?.entries.talk_time?.notes ?? "",
              action: existing?.entries.talk_time?.action ?? "",
            };
          }
          if (Object.keys(entries).length) await upsertScorecardWeek(member.id, thisWeek, "", entries);
        })
      );
      showToast(`Imported calls for ${applied.length} ${applied.length === 1 ? "person" : "people"}`);
      void loadTeamData();
      if (currentWeek === thisWeek) void loadWeek();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to import calls");
    }
  }

  function leaderboardHtml(period: Period): string {
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    const targets = targetsMap();
    const scored = people
      .map((p) => ({ p, score: periodScore(p, targets, period) }))
      .filter((x): x is { p: PersonSeries; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return `<p class="empty-hint">No saved weeks in this range yet.</p>`;
    return `<div class="sc-leaderboard">${scored
      .map(
        (row, i) => `
        <div class="sc-lb-row" data-user-id="${escapeHtml(row.p.userId)}">
          <span class="sc-lb-rank${i === 0 ? " lead" : ""}">${i + 1}</span>
          <span class="sc-lb-name">${escapeHtml(row.p.name)}</span>
          <span class="status-badge rag-${ragClass(row.score, green, amber)}">${pctText(row.score)}</span>
        </div>`
      )
      .join("")}</div>`;
  }

  function renderDashboard(): void {
    if (!teamLoaded) return;
    const period = dashPeriodSelect.value as Period;
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    const targets = targetsMap();

    const scores = people.map((p) => periodScore(p, targets, period)).filter((v): v is number => v !== null);
    const teamAvg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;

    const metricAverages = METRICS.map((m) => {
      const vals: number[] = [];
      for (const p of people) {
        for (const w of periodScopedWeeks(p, period)) {
          const target = targets[m.key] ?? 0;
          const pct = computeCellPct(m, w.rows[m.key] ?? null, target);
          if (pct !== null) vals.push(pct);
        }
      }
      return { m, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
    });
    const scoredMetrics = metricAverages.filter((x) => x.avg !== null);
    const best = scoredMetrics.length ? scoredMetrics.reduce((a, b) => (b.avg! > a.avg! ? b : a)) : null;
    const worst = scoredMetrics.length ? scoredMetrics.reduce((a, b) => (b.avg! < a.avg! ? b : a)) : null;

    dashKpisEl.innerHTML = `
      <div class="m"><div class="l">Team average</div><div class="v tnum">${pctText(teamAvg)}</div></div>
      <div class="m"><div class="l">Reps with data</div><div class="v tnum">${scores.length} / ${people.length}</div></div>
      <div class="m"><div class="l">Strongest area</div><div class="v">${best ? escapeHtml(best.m.name) : "—"}</div></div>
      <div class="m"><div class="l">Biggest gap</div><div class="v">${worst ? escapeHtml(worst.m.name) : "—"}</div></div>
    `;

    dashLeaderboardEl.innerHTML = leaderboardHtml(period);
    wireLeaderboardClicks(dashLeaderboardEl);

    dashMetricRowsEl.innerHTML = metricAverages
      .map(
        ({ m, avg }) => `
        <tr>
          <td>${escapeHtml(m.name)}</td>
          <td class="mono">${pctText(avg)}</td>
          <td><span class="status-badge rag-${ragClass(avg, green, amber)}">${ragLabel(ragClass(avg, green, amber))}</span></td>
        </tr>`
      )
      .join("");
  }

  function renderManager(): void {
    if (!teamLoaded) return;
    const period = mgrPeriodSelect.value as Period;
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    const targets = targetsMap();

    const stats = people.map((p) => ({
      p,
      latest: latestScore(p, targets),
      trend: trendOf(p, targets),
    }));
    const withData = stats.filter((s) => s.latest !== null);
    const redCount = withData.filter((s) => ragClass(s.latest, green, amber) === "red").length;
    const decliningCount = withData.filter((s) => s.trend.declining >= 2).length;
    const teamAvg = withData.length
      ? withData.reduce((a, b) => a + (b.latest ?? 0), 0) / withData.length
      : null;

    mgrKpisEl.innerHTML = `
      <div class="m"><div class="l">Team average</div><div class="v tnum">${pctText(teamAvg)}</div></div>
      <div class="m"><div class="l">In the red</div><div class="v tnum">${redCount}</div></div>
      <div class="m"><div class="l">Trending down</div><div class="v tnum">${decliningCount}</div></div>
      <div class="m"><div class="l">No data yet</div><div class="v tnum">${people.length - withData.length}</div></div>
    `;

    const attention = stats
      .map((s) => {
        if (s.latest === null) {
          return { s, tag: "Not updated", tagCls: "none", rank: 3, why: "No scorecard data yet." };
        }
        if (ragClass(s.latest, green, amber) === "red") {
          return {
            s,
            tag: "Red",
            tagCls: "red",
            rank: 0,
            why: `Weighted ${pctText(s.latest)}${s.trend.declining >= 2 ? `, down ${s.trend.declining} weeks running.` : "."}`,
          };
        }
        if (s.trend.declining >= 2) {
          return { s, tag: "Trending down", tagCls: "amber", rank: 1, why: `Weighted ${pctText(s.latest)}, down ${s.trend.declining} weeks running.` };
        }
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.rank - b.rank);

    mgrAttentionEl.innerHTML = attention.length
      ? `<div class="sc-attention-list">${attention
          .map(
            (a) => `
            <div class="sc-attention-row" data-user-id="${escapeHtml(a.s.p.userId)}">
              <span class="status-badge rag-${a.tagCls}">${escapeHtml(a.tag)}</span>
              <span class="sc-lb-name">${escapeHtml(a.s.p.name)}</span>
              <span class="sc-attention-why">${escapeHtml(a.why)}</span>
            </div>`
          )
          .join("")}</div>`
      : `<p class="empty-hint">Nobody needs attention right now.</p>`;
    wireLeaderboardClicks(mgrAttentionEl, ".sc-attention-row");

    mgrLeaderboardEl.innerHTML = leaderboardHtml(period);
    wireLeaderboardClicks(mgrLeaderboardEl);
  }

  function wireLeaderboardClicks(root: HTMLElement, rowSelector = ".sc-lb-row"): void {
    root.querySelectorAll<HTMLElement>(rowSelector).forEach((row) => {
      row.addEventListener("click", () => {
        const userId = row.dataset.userId;
        const person = people.find((p) => p.userId === userId);
        if (person) void openPrepSheet(person);
      });
    });
  }

  async function openPrepSheet(person: PersonSeries): Promise<void> {
    if (!hasPermission("view_scorecard_manager")) return;
    const targets = targetsMap();
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    const period = (mgrPeriodSelect.value as Period) ?? "all";
    const series = scoreSeries(person, targets);
    const latest = latestScore(person, targets);
    const trend = trendOf(person, targets);
    const streak = streakOf(person, targets, green);
    const consistency = consistencyOf(person, targets);
    const conversion = conversionOf(person, period);

    let latestNotes: { metric: string; notes: string; action: string }[] = [];
    try {
      const fullWeeks = await getScorecardWeeks(person.userId);
      const lastWeek = fullWeeks[fullWeeks.length - 1];
      if (lastWeek) {
        latestNotes = METRICS.filter((m) => lastWeek.entries[m.key]?.notes || lastWeek.entries[m.key]?.action).map((m) => ({
          metric: m.name,
          notes: lastWeek.entries[m.key]?.notes ?? "",
          action: lastWeek.entries[m.key]?.action ?? "",
        }));
      }
    } catch {
      // Notes are a nice-to-have on the prep sheet — the rest still renders without them.
    }

    const metricRows = METRICS.map((m) => {
      const target = targets[m.key] ?? 0;
      const scoped = periodScopedWeeks(person, period);
      const vals = scoped.map((w) => computeCellPct(m, w.rows[m.key] ?? null, target)).filter((v): v is number => v !== null);
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      return `<tr><td>${escapeHtml(m.name)}</td><td class="mono">${pctText(avg)}</td><td><span class="status-badge rag-${ragClass(avg, green, amber)}">${ragLabel(ragClass(avg, green, amber))}</span></td></tr>`;
    }).join("");

    const { overlay, close } = openOverlay(
      `<div class="conflict-modal sc-prep-sheet">
        <h3 class="conflict-modal-title">${escapeHtml(person.name)} — Prep sheet</h3>
        <section class="metrics sc-prep-kpis">
          <div class="m"><div class="l">Latest week</div><div class="v tnum">${pctText(latest)}</div></div>
          <div class="m"><div class="l">Trend</div><div class="v">${trend.dir === "up" ? "▲" : trend.dir === "down" ? "▼" : "→"}</div></div>
          <div class="m"><div class="l">Green streak</div><div class="v tnum">${streak}wk</div></div>
          <div class="m"><div class="l">Consistency</div><div class="v">${consistency.label}</div></div>
        </section>
        ${sparklineSvg(series) ? `<div class="sc-prep-spark">${sparklineSvg(series)}</div>` : ""}
        <p class="conflict-modal-desc">Calls-per-lead: <strong>${conversion.callsPerLead === null ? "—" : conversion.callsPerLead.toFixed(1)}</strong> · Talk time per call: <strong>${escapeHtml(conversion.talkPerCall)}</strong></p>
        <div class="scorecard-table-wrap">
          <table class="scorecard-table">
            <thead><tr><th>Metric</th><th>Period avg</th><th>Status</th></tr></thead>
            <tbody>${metricRows}</tbody>
          </table>
        </div>
        ${
          latestNotes.length
            ? `<ul class="conflict-modal-list">${latestNotes.map((n) => `<li><strong>${escapeHtml(n.metric)}:</strong> ${escapeHtml(n.notes)}${n.action ? ` — <em>${escapeHtml(n.action)}</em>` : ""}</li>`).join("")}</ul>`
            : ""
        }
        <div class="conflict-modal-actions"><button class="btn btn-secondary btn-sm" data-action-id="close">Close</button></div>
      </div>`,
      { onEscape: () => close() }
    );
    overlay.querySelector<HTMLButtonElement>('[data-action-id="close"]')!.addEventListener("click", close);
  }

  saveBtn.addEventListener("click", async () => {
    const user = getCurrentUser();
    if (!user) return;
    saveBtn.disabled = true;
    try {
      const entries: Record<string, ScorecardEntryInput> = {};
      for (const m of METRICS) {
        const entry = draft[m.key];
        // An auto-tracked metric the rep never overrode is left out of the
        // payload entirely — the backend only persists keys present here,
        // so omitting it keeps it recomputing live forever instead of
        // freezing it at today's snapshot value.
        if (entry.source === "auto" && !overriddenKeys.has(m.key)) continue;
        entries[m.key] = entry;
      }
      await upsertScorecardWeek(user.id, currentWeek, "", entries);
      const saved = await saveScorecardWeek(user.id, currentWeek);
      applyWeekToDraft(saved);
      renderRows();
      showToast("Scorecard saved");
      void loadTeamData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save scorecard");
    } finally {
      saveBtn.disabled = false;
    }
  });

  settingsSaveBtn.addEventListener("click", async () => {
    settingsSaveBtn.disabled = true;
    try {
      const targets: Record<string, number> = {};
      targetRowsEl.querySelectorAll<HTMLInputElement>(".sc-target-input").forEach((el) => {
        targets[el.dataset.metric!] = Number(el.value);
      });
      settings = await updateScorecardSettings({
        greenThreshold: Number(greenInput.value),
        amberThreshold: Number(amberInput.value),
        notesVisibility: visibilityInput.value as ScorecardSettings["notes_visibility"],
        targets,
      });
      renderRows();
      renderTargetRows();
      renderDashboard();
      renderManager();
      showToast("Scorecard settings saved");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to save scorecard settings");
    } finally {
      settingsSaveBtn.disabled = false;
    }
  });

  container.querySelector<HTMLButtonElement>("#sc-week-prev")!.addEventListener("click", () => {
    const d = new Date(`${currentWeek}T00:00:00`);
    d.setDate(d.getDate() - 7);
    currentWeek = toIsoDate(d);
    void loadWeek();
  });
  container.querySelector<HTMLButtonElement>("#sc-week-next")!.addEventListener("click", () => {
    const d = new Date(`${currentWeek}T00:00:00`);
    d.setDate(d.getDate() + 7);
    currentWeek = toIsoDate(d);
    void loadWeek();
  });
  container.querySelector<HTMLButtonElement>("#sc-week-today")!.addEventListener("click", () => {
    currentWeek = toIsoDate(mondayOf(new Date()));
    void loadWeek();
  });

  dashPeriodSelect.addEventListener("change", renderDashboard);
  mgrPeriodSelect.addEventListener("change", renderManager);

  importFileInput.addEventListener("change", () => {
    const file = importFileInput.files?.[0];
    if (file) void handleImportFile(file);
    importFileInput.value = "";
  });
  importZoneEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    importZoneEl.classList.add("sc-import-drag");
  });
  importZoneEl.addEventListener("dragleave", () => importZoneEl.classList.remove("sc-import-drag"));
  importZoneEl.addEventListener("drop", (e) => {
    e.preventDefault();
    importZoneEl.classList.remove("sc-import-drag");
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleImportFile(file);
  });

  type SubView = "entry" | "dashboard" | "manager" | "settings";
  function showSubView(target: SubView): void {
    container.querySelectorAll<HTMLButtonElement>(".sub-view-tab").forEach((b) => b.classList.toggle("active", b.dataset.sub === target));
    entryView.style.display = target === "entry" ? "" : "none";
    dashboardView.classList.toggle("hidden", target !== "dashboard");
    managerView.classList.toggle("hidden", target !== "manager");
    settingsView.classList.toggle("hidden", target !== "settings");
    if ((target === "dashboard" || target === "manager") && teamLoaded) {
      void loadTeamData();
    }
  }
  container.querySelectorAll<HTMLButtonElement>(".sub-view-tab").forEach((btn) => {
    btn.addEventListener("click", () => showSubView(btn.dataset.sub as SubView));
  });

  function applyPermissions(): void {
    const canManage = hasPermission("view_scorecard_manager");
    settingsTab.classList.toggle("hidden", !canManage);
    managerTab.classList.toggle("hidden", !canManage);
    if (!canManage && (settingsView.classList.contains("hidden") === false || managerView.classList.contains("hidden") === false)) {
      showSubView("entry");
    }
  }

  subscribeAuth(() => {
    applyPermissions();
    void loadWeek();
    void loadSettings();
    void loadTeamData();
  });

  applyPermissions();
  void loadWeek();
  void loadSettings();
  void loadTeamData();
}
