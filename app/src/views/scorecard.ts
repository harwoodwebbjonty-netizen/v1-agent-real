import { Chart, registerables } from "chart.js";
import {
  deleteScorecardWeek,
  getScorecardSettings,
  getScorecardWeeks,
  getScorecardWeeksAll,
  listTeamMembers,
  saveScorecardWeek,
  scorecardMigrateCommit,
  scorecardMigratePreview,
  updateScorecardSettings,
  upsertScorecardWeek,
  type ScorecardEntryInput,
  type ScorecardMetricKey,
  type ScorecardMigratePreviewResult,
  type ScorecardSettings,
  type ScorecardSummaryEntry,
  type ScorecardWeek,
  type UserInfo,
} from "../api";
import { getCurrentUser, hasPermission, isAdmin, subscribeAuth } from "../auth";
import { confirmDialog, openOverlay } from "../components/modal";
import { showToast } from "../toast";
import { escapeHtml } from "../utils";

Chart.register(...registerables);

// Merged in from the standalone wcf-scorecard.web.app Firebase app (see
// PROJECT_CONTEXT.md) — every visible statistic/table/chart from that app
// is reproduced here, restyled to the CRM's design system. Metric
// names/units/weights stay hardcoded, matching the source app — only the
// numeric target and RAG thresholds were ever actually editable in its own
// Settings tab, and that's all the backend's scorecard_metric_targets/
// scorecard_settings store. Weights mirror the source app's METRICS array
// exactly (CRM Compliance is a gate, not a scored metric — weight 0 keeps
// it out of the weighted score).
const METRICS: { key: ScorecardMetricKey; name: string; unit: string; isPercent?: boolean; weight: number }[] = [
  { key: "calls", name: "Calls", unit: "", weight: 0.15 },
  { key: "talk_time", name: "Talk Time", unit: "h", weight: 0.25 },
  { key: "leads", name: "Qualified Leads Passed", unit: "", weight: 0.3 },
  { key: "campaigns", name: "Mass Email Campaigns", unit: "", weight: 0.05 },
  { key: "follow_up", name: "Follow-up Emails", unit: "%", isPercent: true, weight: 0.05 },
  { key: "crm", name: "CRM Compliance", unit: "%", isPercent: true, weight: 0 },
];
type Metric = (typeof METRICS)[number];

const SHOW_WEIGHT_KEY = "sc-show-weight";

type Draft = Record<ScorecardMetricKey, { actual: number | null; notes: string; action: string; source: "manual" | "auto" }>;
type Period = "week" | "month" | "quarter";
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

function monthLabel(monthKey: string): string {
  const d = new Date(`${monthKey}-01T00:00:00`);
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
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

// --- Team-wide math, ported from the source app's mgr*/weightedPctForRows/
// avgPctForRows/computeCellForEntry functions
// (WCF_BDE_Weekly_Scorecard_copy.html:983-2376) — same formulas,
// percentage-point units throughout instead of 0-1 fractions (matching this
// file's entry-form convention, and the backend's green_threshold/
// amber_threshold which are already stored as percentages). ---

interface PersonWeek {
  week_commencing: string;
  rows: Partial<Record<ScorecardMetricKey, number | null>>;
}

interface PersonSeries {
  userId: string;
  name: string;
  weeks: PersonWeek[]; // sorted ascending by week_commencing
}

/** A single week, or a month with several weeks summed/averaged into it
 * (weekCount tracks how many, needed to un-scale non-percent metric
 * targets — see computeCellPctForEntry). weekKey is only set for a real,
 * single, deletable week. */
interface FilterEntry {
  label: string;
  rows: PersonWeek["rows"];
  weekCount: number;
  weekKey?: string;
}

function computeCellPct(m: Metric, actual: number | null, target: number): number | null {
  if (actual === null) return null;
  if (m.isPercent) return actual;
  return target > 0 ? (actual / target) * 100 : null;
}

/** Like computeCellPct, but for a FilterEntry that may span several weeks
 * (grouped-by-month) — a non-percent metric's target scales by weekCount,
 * a percent metric's value is already an average so weekCount doesn't
 * apply, matching the source app's computeCellForEntry exactly. */
function computeCellPctForEntry(m: Metric, actual: number | null | undefined, weekCount: number, target: number): number | null {
  if (actual === null || actual === undefined) return null;
  if (m.isPercent || weekCount <= 1) return computeCellPct(m, actual, target);
  return target > 0 ? (actual / (target * weekCount)) * 100 : null;
}

function weightedPctForEntry(rows: PersonWeek["rows"], weekCount: number, targets: Record<string, number>): number | null {
  let acc = 0;
  let wsum = 0;
  for (const m of METRICS) {
    if (m.weight <= 0) continue;
    const pct = computeCellPctForEntry(m, rows[m.key] ?? null, weekCount, targets[m.key] ?? 0);
    if (pct === null) continue;
    acc += pct * m.weight;
    wsum += m.weight;
  }
  return wsum > 0 ? acc / wsum : null;
}

function avgPctForEntry(rows: PersonWeek["rows"], weekCount: number, metrics: Metric[], targets: Record<string, number>): number | null {
  const vals: number[] = [];
  for (const m of metrics) {
    const pct = computeCellPctForEntry(m, rows[m.key] ?? null, weekCount, targets[m.key] ?? 0);
    if (pct !== null) vals.push(pct);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function weightedPctForWeek(rows: PersonWeek["rows"], targets: Record<string, number>): number | null {
  return weightedPctForEntry(rows, 1, targets);
}

function scoreSeries(person: PersonSeries, targets: Record<string, number>): number[] {
  return person.weeks.map((w) => weightedPctForWeek(w.rows, targets)).filter((v): v is number => v !== null);
}

function periodScopedWeeks(person: PersonSeries, period: Period): PersonWeek[] {
  const n = period === "week" ? 1 : period === "month" ? 4 : 13;
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

function conversionOf(person: PersonSeries, period: Period): { calls: number; leads: number; hasCalls: boolean; hasLeads: boolean; callsPerLead: number | null; talkPerCall: string } {
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
  return { calls, leads, hasCalls, hasLeads, callsPerLead, talkPerCall: fmtSecs(talkPerCallSecs) };
}

function fmtSecs(s: number | null): string {
  if (s === null || isNaN(s)) return "–";
  const rounded = Math.round(s);
  if (rounded < 60) return `${rounded}s`;
  const m = Math.floor(rounded / 60);
  const r = rounded % 60;
  return `${m}m ${r < 10 ? "0" : ""}${r}s`;
}

function sparklineSvg(series: number[], color = "var(--accent, #E31346)"): string {
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
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" aria-hidden="true"><polyline points="${pts}" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// --- Date-range / group-by-month filtering, ported from
// getFilteredWeeks/getMonthlyAggregated/getFilteredEntries. ---

function inDateRange(weekCommencing: string, from: string, to: string): boolean {
  if (!weekCommencing) return false;
  if (from && weekCommencing < from) return false;
  if (to && weekCommencing > to) return false;
  return true;
}

function monthKeyOf(weekCommencing: string): string {
  return weekCommencing.slice(0, 7);
}

function weeksInRange(person: PersonSeries, from: string, to: string): PersonWeek[] {
  return person.weeks.filter((w) => inDateRange(w.week_commencing, from, to));
}

function monthlyAggregated(person: PersonSeries, from: string, to: string): FilterEntry[] {
  const byMonth = new Map<string, { rows: Partial<Record<ScorecardMetricKey, { sum: number; count: number }>>; weekCount: number }>();
  for (const w of weeksInRange(person, from, to)) {
    const mk = monthKeyOf(w.week_commencing);
    if (!byMonth.has(mk)) byMonth.set(mk, { rows: {}, weekCount: 0 });
    const bucket = byMonth.get(mk)!;
    bucket.weekCount++;
    for (const m of METRICS) {
      const v = w.rows[m.key];
      if (v === null || v === undefined) continue;
      if (!bucket.rows[m.key]) bucket.rows[m.key] = { sum: 0, count: 0 };
      bucket.rows[m.key]!.sum += v;
      bucket.rows[m.key]!.count += 1;
    }
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([mk, data]) => {
      const rows: PersonWeek["rows"] = {};
      for (const m of METRICS) {
        const cell = data.rows[m.key];
        if (!cell) continue;
        rows[m.key] = m.isPercent ? cell.sum / cell.count : cell.sum;
      }
      return { label: monthLabel(mk), rows, weekCount: data.weekCount };
    });
}

function filteredEntries(person: PersonSeries, from: string, to: string, groupByMonth: boolean): FilterEntry[] {
  if (groupByMonth) return monthlyAggregated(person, from, to);
  return weeksInRange(person, from, to).map((w) => ({ label: formatWeekLabel(w.week_commencing), rows: w.rows, weekCount: 1, weekKey: w.week_commencing }));
}

function avgWeightedScoreInRange(person: PersonSeries, from: string, to: string, groupByMonth: boolean, targets: Record<string, number>): number | null {
  const scores = filteredEntries(person, from, to, groupByMonth)
    .map((e) => weightedPctForEntry(e.rows, e.weekCount, targets))
    .filter((v): v is number => v !== null);
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

function summaryMetricStats(
  profiles: PersonSeries[],
  from: string,
  to: string,
  groupByMonth: boolean,
  targets: Record<string, number>
): { name: string; avg: number }[] {
  const acc = METRICS.map((m) => ({ name: m.name, vals: [] as number[] }));
  for (const p of profiles) {
    for (const e of filteredEntries(p, from, to, groupByMonth)) {
      METRICS.forEach((m, i) => {
        const pct = computeCellPctForEntry(m, e.rows[m.key] ?? null, e.weekCount, targets[m.key] ?? 0);
        if (pct !== null) acc[i].vals.push(pct);
      });
    }
  }
  return acc.filter((x) => x.vals.length).map((x) => ({ name: x.name, avg: x.vals.reduce((a, b) => a + b, 0) / x.vals.length }));
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

/** Every team member appears here, even with zero scorecard data (weeks:
 * []) — the scorecard is available to the whole team by default, unlike
 * the source app where a "profile" only existed once someone was manually
 * added, so Manager/Dashboard need to show "awaiting first entry" for
 * anyone who hasn't started yet rather than omitting them entirely. */
function buildPersonSeries(summary: ScorecardSummaryEntry[], members: UserInfo[]): PersonSeries[] {
  const byUser = new Map<string, Map<string, PersonWeek>>();
  for (const m of members) byUser.set(m.id, new Map());
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
        <div class="sc-entry-toolbar">
          <label class="sc-review-date">Review date
            <input type="date" id="sc-review-date-input" />
          </label>
          <label class="sc-weight-toggle">
            <input type="checkbox" id="sc-weight-toggle-input" /> Show weight
          </label>
          <button type="button" class="btn-ghost" id="sc-print-btn">Print / Save as PDF</button>
        </div>
        <section class="panel">
          <div class="scorecard-table-wrap">
            <table class="scorecard-table" id="sc-entry-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Target</th>
                  <th>Actual</th>
                  <th class="sc-weight-col">Weight</th>
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
          <h3 class="action-section-title">Filters</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel sc-dash-filters">
          <label>Person
            <select id="sc-dash-person"><option value="all">All people</option></select>
          </label>
          <label>Metric
            <select id="sc-dash-metric"><option value="all">All metrics</option></select>
          </label>
          <label>From
            <input type="date" id="sc-dash-from" />
          </label>
          <label>To
            <input type="date" id="sc-dash-to" />
          </label>
          <button type="button" class="btn-ghost" id="sc-dash-alltime">All time</button>
          <button type="button" class="btn-ghost" id="sc-dash-groupmonth">Group by month</button>
        </section>

        <section class="panel sc-summary-card" id="sc-dash-summary"></section>

        <div class="sec-head">
          <span class="sec-num">02</span>
          <h3 class="action-section-title" id="sc-dash-charts-title">Charts</h3>
          <span class="sec-rule"></span>
        </div>
        <div class="sc-chart-grid">
          <section class="panel sc-chart-card"><h4>RAG distribution</h4><div class="sc-chart-wrap"><canvas id="sc-rag-chart"></canvas></div></section>
          <section class="panel sc-chart-card"><h4 id="sc-bar-chart-title">Average % of target by person</h4><div class="sc-chart-wrap"><canvas id="sc-bar-chart"></canvas></div></section>
        </div>
        <section class="panel sc-chart-card sc-chart-card-wide"><h4 id="sc-trend-chart-title">Trend over time</h4><div class="sc-chart-wrap"><canvas id="sc-trend-chart"></canvas></div></section>

        <div class="sec-head">
          <span class="sec-num">03</span>
          <h3 class="action-section-title" id="sc-dash-snapshot-title">Team snapshot</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="metrics" id="sc-dash-stat-cards"></section>
        <section class="panel">
          <div class="scorecard-table-wrap">
            <table class="scorecard-table" id="sc-dash-snapshot-table">
              <thead><tr id="sc-dash-snapshot-head"></tr></thead>
              <tbody id="sc-dash-snapshot-rows"></tbody>
            </table>
          </div>
        </section>

        <div class="sec-head">
          <span class="sec-num">04</span>
          <h3 class="action-section-title">Leaderboard</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel" id="sc-dash-leaderboard"></section>

        <div class="sec-head">
          <span class="sec-num">05</span>
          <h3 class="action-section-title" id="sc-dash-history-title">Per-person history</h3>
          <span class="sec-rule"></span>
        </div>
        <div id="sc-dash-history"></div>
      </div>

      <div id="sc-view-manager" class="hidden">
        <div class="sec-head">
          <span class="sec-num">01</span>
          <h3 class="action-section-title">Team snapshot</h3>
          <span class="sec-rule"></span>
          <span class="sc-period-segment" id="sc-mgr-period">
            <button type="button" data-period="week" class="active">This week</button>
            <button type="button" data-period="month">Last 4 weeks</button>
            <button type="button" data-period="quarter">Last 13 weeks</button>
          </span>
        </div>
        <p class="sc-mgr-sub" id="sc-mgr-sub"></p>
        <section class="metrics" id="sc-mgr-kpis"></section>

        <div class="sec-head">
          <span class="sec-num">02</span>
          <h3 class="action-section-title">Needs attention</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel" id="sc-mgr-attention"></section>

        <div class="sec-head">
          <span class="sec-num">03</span>
          <h3 class="action-section-title">Team leaderboard</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel" id="sc-mgr-leaderboard"></section>

        <div class="sec-head">
          <span class="sec-num">04</span>
          <h3 class="action-section-title">Where the team is strong &amp; weak</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel" id="sc-mgr-rollup"></section>
        <div id="sc-mgr-rollup-callout"></div>

        <div class="sec-head">
          <span class="sec-num">05</span>
          <h3 class="action-section-title">Effort vs. result</h3>
          <span class="sec-rule"></span>
        </div>
        <section id="sc-mgr-conversion"></section>
        <div id="sc-mgr-conversion-callout"></div>

        <div class="sec-head">
          <span class="sec-num">06</span>
          <h3 class="action-section-title">1-on-1 prep sheet</h3>
          <span class="sec-rule"></span>
        </div>
        <div class="sc-people-pills" id="sc-mgr-people-pills"></div>
        <div id="sc-mgr-prep"></div>

        <div class="sec-head">
          <span class="sec-num">07</span>
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
          <button type="button" class="btn-ghost" id="sc-reset-defaults-btn">Reset to defaults</button>
          <button type="button" class="btn-primary" id="sc-settings-save-btn">Save settings</button>
        </div>

        <div class="sec-head">
          <span class="sec-num">03</span>
          <h3 class="action-section-title">Backup</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel sc-settings-form">
          <p>Download every rep's full scorecard history as a JSON file.</p>
          <button type="button" class="btn-ghost" id="sc-backup-export-btn">Download backup (.json)</button>
        </section>

        <div class="sec-head hidden" id="sc-migrate-section">
          <span class="sec-num">04</span>
          <h3 class="action-section-title">Import from legacy scorecard</h3>
          <span class="sec-rule"></span>
        </div>
        <section class="panel sc-migrate-panel hidden" id="sc-migrate-panel">
          <p>Admin-only, one-off tool: upload a backup JSON exported from the old wcf-scorecard.web.app site (Settings → Download backup) to import its history here.</p>
          <label class="btn-ghost sc-import-browse">
            Choose backup file
            <input type="file" id="sc-migrate-file-input" accept=".json,application/json" class="hidden" />
          </label>
          <div id="sc-migrate-preview"></div>
        </section>
      </div>
    </main>
  `;

  // --- element refs ---
  const weekLabelEl = container.querySelector<HTMLSpanElement>("#sc-week-label")!;
  const rowsEl = container.querySelector<HTMLTableSectionElement>("#sc-entry-rows")!;
  const entryTableEl = container.querySelector<HTMLTableElement>("#sc-entry-table")!;
  const savedLabelEl = container.querySelector<HTMLSpanElement>("#sc-saved-label")!;
  const saveBtn = container.querySelector<HTMLButtonElement>("#sc-save-btn")!;
  const reviewDateInput = container.querySelector<HTMLInputElement>("#sc-review-date-input")!;
  const weightToggleInput = container.querySelector<HTMLInputElement>("#sc-weight-toggle-input")!;
  const printBtn = container.querySelector<HTMLButtonElement>("#sc-print-btn")!;
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
  const resetDefaultsBtn = container.querySelector<HTMLButtonElement>("#sc-reset-defaults-btn")!;
  const backupExportBtn = container.querySelector<HTMLButtonElement>("#sc-backup-export-btn")!;

  const dashPersonSelect = container.querySelector<HTMLSelectElement>("#sc-dash-person")!;
  const dashMetricSelect = container.querySelector<HTMLSelectElement>("#sc-dash-metric")!;
  const dashFromInput = container.querySelector<HTMLInputElement>("#sc-dash-from")!;
  const dashToInput = container.querySelector<HTMLInputElement>("#sc-dash-to")!;
  const dashAllTimeBtn = container.querySelector<HTMLButtonElement>("#sc-dash-alltime")!;
  const dashGroupMonthBtn = container.querySelector<HTMLButtonElement>("#sc-dash-groupmonth")!;
  const dashSummaryEl = container.querySelector<HTMLDivElement>("#sc-dash-summary")!;
  const dashChartsTitleEl = container.querySelector<HTMLHeadingElement>("#sc-dash-charts-title")!;
  const dashBarChartTitleEl = container.querySelector<HTMLHeadingElement>("#sc-bar-chart-title")!;
  const dashTrendChartTitleEl = container.querySelector<HTMLHeadingElement>("#sc-trend-chart-title")!;
  const dashSnapshotTitleEl = container.querySelector<HTMLHeadingElement>("#sc-dash-snapshot-title")!;
  const dashStatCardsEl = container.querySelector<HTMLDivElement>("#sc-dash-stat-cards")!;
  const dashSnapshotHeadEl = container.querySelector<HTMLTableRowElement>("#sc-dash-snapshot-head")!;
  const dashSnapshotRowsEl = container.querySelector<HTMLTableSectionElement>("#sc-dash-snapshot-rows")!;
  const dashLeaderboardEl = container.querySelector<HTMLDivElement>("#sc-dash-leaderboard")!;
  const dashHistoryTitleEl = container.querySelector<HTMLHeadingElement>("#sc-dash-history-title")!;
  const dashHistoryEl = container.querySelector<HTMLDivElement>("#sc-dash-history")!;
  const ragChartCanvas = container.querySelector<HTMLCanvasElement>("#sc-rag-chart")!;
  const barChartCanvas = container.querySelector<HTMLCanvasElement>("#sc-bar-chart")!;
  const trendChartCanvas = container.querySelector<HTMLCanvasElement>("#sc-trend-chart")!;

  const mgrPeriodEl = container.querySelector<HTMLDivElement>("#sc-mgr-period")!;
  const mgrSubEl = container.querySelector<HTMLParagraphElement>("#sc-mgr-sub")!;
  const mgrKpisEl = container.querySelector<HTMLDivElement>("#sc-mgr-kpis")!;
  const mgrAttentionEl = container.querySelector<HTMLDivElement>("#sc-mgr-attention")!;
  const mgrLeaderboardEl = container.querySelector<HTMLDivElement>("#sc-mgr-leaderboard")!;
  const mgrRollupEl = container.querySelector<HTMLDivElement>("#sc-mgr-rollup")!;
  const mgrRollupCalloutEl = container.querySelector<HTMLDivElement>("#sc-mgr-rollup-callout")!;
  const mgrConversionEl = container.querySelector<HTMLDivElement>("#sc-mgr-conversion")!;
  const mgrConversionCalloutEl = container.querySelector<HTMLDivElement>("#sc-mgr-conversion-callout")!;
  const mgrPeoplePillsEl = container.querySelector<HTMLDivElement>("#sc-mgr-people-pills")!;
  const mgrPrepEl = container.querySelector<HTMLDivElement>("#sc-mgr-prep")!;

  const importZoneEl = container.querySelector<HTMLDivElement>("#sc-import-zone")!;
  const importFileInput = container.querySelector<HTMLInputElement>("#sc-import-file-input")!;
  const migrateSectionEl = container.querySelector<HTMLDivElement>("#sc-migrate-section")!;
  const migratePanelEl = container.querySelector<HTMLDivElement>("#sc-migrate-panel")!;
  const migrateFileInput = container.querySelector<HTMLInputElement>("#sc-migrate-file-input")!;
  const migratePreviewEl = container.querySelector<HTMLDivElement>("#sc-migrate-preview")!;

  // --- state ---
  let currentWeek = toIsoDate(mondayOf(new Date()));
  let draft: Draft = emptyDraft();
  let draftReviewDate = "";
  let savedAt: string | null = null;
  let settings: ScorecardSettings | null = null;
  let overriddenKeys = new Set<ScorecardMetricKey>();
  let loadToken = 0;
  let people: PersonSeries[] = [];
  let allMembers: UserInfo[] = [];
  let teamLoaded = false;
  let mgrPeriod: Period = "week";
  let mgrPrepPersonId: string | null = null;
  let dashPersonFilter = "all";
  let dashMetricFilter = "all";
  let dashDateFrom = "";
  let dashDateTo = "";
  let dashGroupByMonth = false;
  let ragChart: Chart | null = null;
  let barChart: Chart | null = null;
  let trendChart: Chart | null = null;

  function targetsMap(): Record<string, number> {
    const map: Record<string, number> = {};
    for (const t of settings?.targets ?? []) map[t.metric_key] = t.target_value;
    return map;
  }

  // =========================================================================
  // My Scorecard (entry form)
  // =========================================================================

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
          <td class="mono sc-weight-col">${Math.round(m.weight * 100)}%</td>
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
    draftReviewDate = week?.review_date ?? "";
    reviewDateInput.value = draftReviewDate;
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

  const showWeight = localStorage.getItem(SHOW_WEIGHT_KEY) === "true";
  weightToggleInput.checked = showWeight;
  entryTableEl.classList.toggle("sc-show-weight", showWeight);
  weightToggleInput.addEventListener("change", () => {
    entryTableEl.classList.toggle("sc-show-weight", weightToggleInput.checked);
    localStorage.setItem(SHOW_WEIGHT_KEY, String(weightToggleInput.checked));
  });
  printBtn.addEventListener("click", () => window.print());
  reviewDateInput.addEventListener("change", () => {
    draftReviewDate = reviewDateInput.value;
  });

  // =========================================================================
  // Team data loading
  // =========================================================================

  async function loadTeamData(): Promise<void> {
    try {
      const [summary, members] = await Promise.all([getScorecardWeeksAll(), listTeamMembers()]);
      people = buildPersonSeries(summary, members);
      allMembers = members;
      teamLoaded = true;
      renderDashboardPersonOptions();
      renderDashboard();
      renderManager();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load team scorecard data");
    }
  }

  // =========================================================================
  // Dashboard
  // =========================================================================

  function renderDashboardPersonOptions(): void {
    const prev = dashPersonSelect.value || "all";
    dashPersonSelect.innerHTML =
      `<option value="all">All people</option>` + people.map((p) => `<option value="${escapeHtml(p.userId)}">${escapeHtml(p.name)}</option>`).join("");
    dashPersonSelect.value = [...dashPersonSelect.options].some((o) => o.value === prev) ? prev : "all";
    dashPersonFilter = dashPersonSelect.value;
  }

  if (!dashMetricSelect.dataset.built) {
    dashMetricSelect.innerHTML = `<option value="all">All metrics</option>` + METRICS.map((m) => `<option value="${m.key}">${escapeHtml(m.name)}</option>`).join("");
    dashMetricSelect.dataset.built = "1";
  }

  function metricsToConsider(): Metric[] {
    return dashMetricFilter === "all" ? METRICS : METRICS.filter((m) => m.key === dashMetricFilter);
  }

  function summaryRangeText(): string {
    return dashDateFrom || dashDateTo ? ` between ${dashDateFrom || "the start"} and ${dashDateTo || "now"}` : "";
  }

  function renderDashboard(): void {
    if (!teamLoaded) return;
    const targets = targetsMap();
    const selectedPerson = dashPersonFilter === "all" ? null : people.find((p) => p.userId === dashPersonFilter) ?? null;
    const profiles = selectedPerson ? [selectedPerson] : people;
    const personLabel = selectedPerson ? selectedPerson.name : null;
    const metrics = metricsToConsider();

    if (!people.length) {
      dashSummaryEl.innerHTML = `<p class="empty-hint">No team members yet.</p>`;
      return;
    }

    // ---- weekly summary card ----
    const scored = profiles.map((p) => ({ name: p.name, score: avgWeightedScoreInRange(p, dashDateFrom, dashDateTo, dashGroupByMonth, targets) })).filter(
      (x): x is { name: string; score: number } => x.score !== null
    );
    const metricStats = summaryMetricStats(profiles, dashDateFrom, dashDateTo, dashGroupByMonth, targets);
    let summaryText: string;
    if (!scored.length || !metricStats.length) {
      summaryText = "No saved data in the selected range yet. Add or save some weeks to see a written summary here.";
    } else {
      const overall = scored.reduce((a, b) => a + b.score, 0) / scored.length;
      const best = metricStats.reduce((a, b) => (b.avg > a.avg ? b : a));
      const worst = metricStats.reduce((a, b) => (b.avg < a.avg ? b : a));
      const who = personLabel || "The team";
      const parts = [`${who} is averaging ${pctText(overall)} of target (weighted)${summaryRangeText()}.`];
      if (best.name !== worst.name) {
        parts.push(`${best.name} is the strongest area at ${pctText(best.avg)}, while ${worst.name} is the biggest gap at ${pctText(worst.avg)}.`);
      } else {
        parts.push(`Strongest area: ${best.name} at ${pctText(best.avg)}.`);
      }
      if (!personLabel && scored.length > 1) {
        const ranked = [...scored].sort((a, b) => b.score - a.score);
        parts.push(`${ranked[0].name} is top at ${pctText(ranked[0].score)}; ${ranked[ranked.length - 1].name} needs the most support at ${pctText(ranked[ranked.length - 1].score)}.`);
      }
      summaryText = parts.join(" ");
    }
    dashSummaryEl.innerHTML = `
      <h4>${personLabel ? `${escapeHtml(personLabel)} — Summary` : "Weekly Summary"}</h4>
      <p>${escapeHtml(summaryText)}</p>
      <button type="button" class="btn-ghost sc-copy-summary-btn">Copy summary</button>
    `;
    dashSummaryEl.querySelector<HTMLButtonElement>(".sc-copy-summary-btn")!.addEventListener("click", (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      navigator.clipboard?.writeText(summaryText).then(() => {
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy summary"), 1500);
      });
    });

    // ---- charts ----
    dashChartsTitleEl.textContent = personLabel ? `Charts — ${personLabel}` : "Charts";
    dashBarChartTitleEl.textContent = `Average % of target by ${personLabel ? "metric" : "person"}`;
    dashTrendChartTitleEl.textContent = `Trend over time (${personLabel ?? "Team average"})`;
    renderCharts(profiles, metrics, targets);

    // ---- team/person snapshot ----
    dashSnapshotTitleEl.textContent = personLabel ? `${personLabel}'s snapshot` : "Team snapshot";
    renderSnapshot(profiles, targets);

    // ---- leaderboard ----
    dashLeaderboardEl.innerHTML = leaderboardHtml(profiles, targets, "all");
    wireLeaderboardClicks(dashLeaderboardEl);

    // ---- per-person history ----
    dashHistoryTitleEl.textContent = personLabel ? "History" : "Per-person history";
    renderHistory(profiles, targets);
  }

  function renderCharts(profiles: PersonSeries[], metrics: Metric[], targets: Record<string, number>): void {
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;

    // RAG distribution
    const tallies = { green: 0, amber: 0, red: 0 };
    for (const p of profiles) {
      for (const e of filteredEntries(p, dashDateFrom, dashDateTo, dashGroupByMonth)) {
        for (const m of metrics) {
          const pct = computeCellPctForEntry(m, e.rows[m.key] ?? null, e.weekCount, targets[m.key] ?? 0);
          const rag = ragClass(pct, green, amber);
          if (rag === "green") tallies.green++;
          else if (rag === "amber") tallies.amber++;
          else if (rag === "red") tallies.red++;
        }
      }
    }
    ragChart?.destroy();
    ragChart = new Chart(ragChartCanvas, {
      type: "doughnut",
      data: { labels: ["Green", "Amber", "Red"], datasets: [{ data: [tallies.green, tallies.amber, tallies.red], backgroundColor: ["#25A976", "#E69D26", "#E31346"], borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } } },
    });

    // Average % of target — by metric (single person) or by person (team)
    let barData: { label: string; avg: number }[];
    if (profiles.length === 1) {
      barData = metrics
        .map((m) => {
          const entries = filteredEntries(profiles[0], dashDateFrom, dashDateTo, dashGroupByMonth);
          const vals = entries.map((e) => computeCellPctForEntry(m, e.rows[m.key] ?? null, e.weekCount, targets[m.key] ?? 0)).filter((v): v is number => v !== null);
          return { label: m.name, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
        })
        .filter((d): d is { label: string; avg: number } => d.avg !== null);
    } else {
      barData = profiles
        .map((p) => {
          const entries = filteredEntries(p, dashDateFrom, dashDateTo, dashGroupByMonth);
          const avgs = entries.map((e) => avgPctForEntry(e.rows, e.weekCount, metrics, targets)).filter((v): v is number => v !== null);
          return { label: p.name, avg: avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null };
        })
        .filter((d): d is { label: string; avg: number } => d.avg !== null);
    }
    barChart?.destroy();
    barChart = new Chart(barChartCanvas, {
      type: "bar",
      data: {
        labels: barData.map((d) => d.label),
        datasets: [{ label: "Avg % of target", data: barData.map((d) => Math.round(d.avg)), backgroundColor: barData.map((d) => (d.avg >= green ? "#25A976" : d.avg >= amber ? "#E69D26" : "#E31346")), borderRadius: 6, maxBarThickness: 48 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.parsed.y}% of target` } } },
        scales: { y: { beginAtZero: true, suggestedMax: 120, ticks: { callback: (v) => `${v}%` } } },
      },
    });

    // Trend over time
    const trendMap = new Map<string, number[]>();
    for (const p of profiles) {
      for (const e of filteredEntries(p, dashDateFrom, dashDateTo, dashGroupByMonth)) {
        const avg = avgPctForEntry(e.rows, e.weekCount, metrics, targets);
        if (avg === null) continue;
        if (!trendMap.has(e.label)) trendMap.set(e.label, []);
        trendMap.get(e.label)!.push(avg);
      }
    }
    const trendKeys = [...trendMap.keys()].sort();
    trendChart?.destroy();
    trendChart = new Chart(trendChartCanvas, {
      type: "line",
      data: {
        labels: trendKeys,
        datasets: [
          {
            label: profiles.length === 1 ? `${profiles[0].name}'s average % of target` : "Team average % of target",
            data: trendKeys.map((k) => {
              const vals = trendMap.get(k)!;
              return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
            }),
            borderColor: "#E31346",
            backgroundColor: "rgba(227,19,70,0.12)",
            fill: true,
            tension: 0.3,
            borderWidth: 2.5,
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${c.parsed.y}% of target` } } },
        scales: { y: { beginAtZero: true, suggestedMax: 120, ticks: { callback: (v) => `${v}%` } } },
      },
    });
  }

  function renderSnapshot(profiles: PersonSeries[], targets: Record<string, number>): void {
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    const tallies = { green: 0, amber: 0, red: 0 };
    const snapshots = profiles.map((p) => ({ p, snap: p.weeks.length ? p.weeks[p.weeks.length - 1] : null }));
    for (const { snap } of snapshots) {
      for (const m of METRICS) {
        const pct = computeCellPct(m, snap?.rows[m.key] ?? null, targets[m.key] ?? 0);
        const rag = ragClass(pct, green, amber);
        if (rag === "green") tallies.green++;
        else if (rag === "amber") tallies.amber++;
        else if (rag === "red") tallies.red++;
      }
    }
    dashStatCardsEl.innerHTML = `
      <div class="m"><div class="l">Green</div><div class="v tnum">${tallies.green}</div></div>
      <div class="m"><div class="l">Amber</div><div class="v tnum">${tallies.amber}</div></div>
      <div class="m"><div class="l">Red</div><div class="v tnum">${tallies.red}</div></div>
      <div class="m"><div class="l">People</div><div class="v tnum">${profiles.length}</div></div>
    `;

    dashSnapshotHeadEl.innerHTML = `<th>Person</th>${METRICS.map((m) => `<th>${escapeHtml(m.name)}</th>`).join("")}<th>Weighted</th><th>As of week</th>`;
    dashSnapshotRowsEl.innerHTML = snapshots
      .map(({ p, snap }) => {
        const cells = METRICS.map((m) => {
          const raw = snap?.rows[m.key] ?? null;
          const pct = computeCellPct(m, raw, targets[m.key] ?? 0);
          const rag = ragClass(pct, green, amber);
          return `<td><span class="status-badge rag-${rag}">${pctText(pct)}</span>${raw !== null && raw !== undefined ? `<div class="sc-cell-actual">${m.isPercent ? raw + "%" : raw}</div>` : ""}</td>`;
        }).join("");
        const wScore = snap ? weightedPctForWeek(snap.rows, targets) : null;
        const weekLabel = snap ? formatWeekLabel(snap.week_commencing) : "–";
        return `<tr><td>${escapeHtml(p.name)}</td>${cells}<td><span class="status-badge rag-${ragClass(wScore, green, amber)}">${pctText(wScore)}</span></td><td class="mono">${weekLabel}</td></tr>`;
      })
      .join("");
  }

  function leaderboardHtml(profiles: PersonSeries[], targets: Record<string, number>, scope: "period" | "all", period?: Period): string {
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    const scored = profiles
      .map((p) => ({
        p,
        score: scope === "period" && period ? periodScore(p, targets, period) : avgWeightedScoreInRange(p, dashDateFrom, dashDateTo, dashGroupByMonth, targets),
      }))
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

  function renderHistory(profiles: PersonSeries[], targets: Record<string, number>): void {
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    const histPeriod = dashGroupByMonth ? "months" : "weeks";
    dashHistoryEl.innerHTML = profiles
      .map((p) => {
        const entries = filteredEntries(p, dashDateFrom, dashDateTo, dashGroupByMonth);
        if (!entries.length) {
          return `<div class="sc-history-block"><h4>${escapeHtml(p.name)}</h4><p class="empty-hint">${dashDateFrom || dashDateTo ? `No saved ${histPeriod} in this range.` : `No saved ${histPeriod} yet.`}</p></div>`;
        }
        const rows = entries
          .map((e) => {
            const cells = METRICS.map((m) => {
              const raw = e.rows[m.key] ?? null;
              const pct = computeCellPctForEntry(m, raw, e.weekCount, targets[m.key] ?? 0);
              const rag = ragClass(pct, green, amber);
              return `<td><span class="status-badge rag-${rag}">${pctText(pct)}</span>${raw !== null && raw !== undefined ? `<div class="sc-cell-actual">${m.isPercent ? raw + "%" : raw}</div>` : ""}</td>`;
            }).join("");
            const wScore = weightedPctForEntry(e.rows, e.weekCount, targets);
            const delCell = e.weekKey
              ? `<td><button type="button" class="link-danger sc-delete-week-btn" data-user-id="${escapeHtml(p.userId)}" data-week="${escapeHtml(e.weekKey)}">Delete</button></td>`
              : "";
            return `<tr><td>${escapeHtml(e.label)}</td>${cells}<td><span class="status-badge rag-${ragClass(wScore, green, amber)}">${pctText(wScore)}</span></td>${delCell}</tr>`;
          })
          .join("");
        return `
          <div class="sc-history-block">
            <h4>${escapeHtml(p.name)}</h4>
            <div class="scorecard-table-wrap">
              <table class="scorecard-table">
                <thead><tr><th>${dashGroupByMonth ? "Month" : "Week"}</th>${METRICS.map((m) => `<th>${escapeHtml(m.name)}</th>`).join("")}<th>Weighted</th>${dashGroupByMonth ? "" : "<th></th>"}</tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>`;
      })
      .join("");

    dashHistoryEl.querySelectorAll<HTMLButtonElement>(".sc-delete-week-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const userId = btn.dataset.userId!;
        const week = btn.dataset.week!;
        const action = await confirmDialog({
          title: `Delete the week of ${formatWeekLabel(week)}?`,
          descriptionHtml: "This removes every metric, note and action recorded for that week. This can't be undone.",
          actions: [
            { id: "cancel", label: "Cancel", variant: "ghost" },
            { id: "delete", label: "Delete", variant: "primary" },
          ],
        });
        if (action !== "delete") return;
        try {
          await deleteScorecardWeek(userId, week);
          showToast("Week deleted");
          void loadTeamData();
          if (userId === getCurrentUser()?.id && week === currentWeek) void loadWeek();
        } catch (err) {
          showToast(err instanceof Error ? err.message : "Failed to delete week");
        }
      });
    });
  }

  function wireLeaderboardClicks(root: HTMLElement, rowSelector = ".sc-lb-row"): void {
    root.querySelectorAll<HTMLElement>(rowSelector).forEach((row) => {
      row.addEventListener("click", () => {
        const userId = row.dataset.userId;
        if (!userId || !hasPermission("view_scorecard_manager")) return;
        mgrPrepPersonId = userId;
        showSubView("manager");
        void renderManager();
        requestAnimationFrame(() => mgrPrepEl.scrollIntoView({ behavior: "smooth", block: "start" }));
      });
    });
  }

  dashPersonSelect.addEventListener("change", () => {
    dashPersonFilter = dashPersonSelect.value;
    renderDashboard();
  });
  dashMetricSelect.addEventListener("change", () => {
    dashMetricFilter = dashMetricSelect.value;
    renderDashboard();
  });
  dashFromInput.addEventListener("change", () => {
    dashDateFrom = dashFromInput.value;
    renderDashboard();
  });
  dashToInput.addEventListener("change", () => {
    dashDateTo = dashToInput.value;
    renderDashboard();
  });
  dashAllTimeBtn.addEventListener("click", () => {
    dashDateFrom = "";
    dashDateTo = "";
    dashFromInput.value = "";
    dashToInput.value = "";
    renderDashboard();
  });
  dashGroupMonthBtn.addEventListener("click", () => {
    dashGroupByMonth = !dashGroupByMonth;
    dashGroupMonthBtn.classList.toggle("active", dashGroupByMonth);
    renderDashboard();
  });

  // =========================================================================
  // Manager
  // =========================================================================

  function periodLabel(period: Period): string {
    return period === "week" ? "the latest week" : period === "month" ? "the last 4 weeks" : "the last 13 weeks";
  }

  function mgrPeople(targets: Record<string, number>) {
    const green = settings?.green_threshold ?? 100;
    return people.map((p) => {
      const latest = latestScore(p, targets);
      return {
        p,
        latest,
        trend: trendOf(p, targets),
        rag: ragClass(latest, green, settings?.amber_threshold ?? 85),
        streak: streakOf(p, targets, green),
        consistency: consistencyOf(p, targets),
        score: periodScore(p, targets, mgrPeriod),
      };
    });
  }

  function attentionList(peopleStats: ReturnType<typeof mgrPeople>) {
    const out: { x: (typeof peopleStats)[number]; cls: string; tag: string; tagCls: string; rank: number; why: string }[] = [];
    for (const x of peopleStats) {
      if (x.latest === null) {
        out.push({ x, cls: "none", tag: "Not updated", tagCls: "none", rank: 3, why: "No scorecard data yet — nothing to review until a week is filled in." });
      } else if (x.rag === "red") {
        out.push({
          x,
          cls: "red",
          tag: "Red",
          tagCls: "red",
          rank: 0,
          why: `Weighted ${pctText(x.latest)} — in the red band${x.trend.declining >= 2 ? `, and down ${x.trend.declining} weeks running.` : "."}`,
        });
      } else if (x.trend.declining >= 2) {
        out.push({ x, cls: "amber", tag: "Trending down", tagCls: "amber", rank: 1, why: `Weighted ${pctText(x.latest)} but down ${x.trend.declining} weeks running — slipping before it turns red.` });
      }
    }
    return out.sort((a, b) => a.rank - b.rank);
  }

  function renderManager(): void {
    if (!teamLoaded) return;
    const targets = targetsMap();
    const green = settings?.green_threshold ?? 100;

    mgrSubEl.textContent = `Averaging over ${periodLabel(mgrPeriod)} · ${people.length} ${people.length === 1 ? "person" : "people"}`;
    mgrPeriodEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("active", b.dataset.period === mgrPeriod));

    if (!people.length) {
      mgrKpisEl.innerHTML = "";
      mgrAttentionEl.innerHTML = `<p class="empty-hint">No team members yet.</p>`;
      return;
    }

    const peopleStats = mgrPeople(targets);
    const scored = peopleStats.filter((x) => x.score !== null) as (ReturnType<typeof mgrPeople>[number] & { score: number })[];
    const attention = attentionList(peopleStats);
    const leadsTarget = targets.leads ?? 0;

    // ---- KPI strip ----
    const teamScore = scored.length ? scored.reduce((a, b) => a + b.score, 0) / scored.length : null;
    const onTrack = peopleStats.filter((x) => x.latest !== null && x.latest >= green).length;
    let leadSum = 0;
    let leadWeeks = 0;
    for (const p of people) {
      for (const w of periodScopedWeeks(p, mgrPeriod)) {
        const l = w.rows.leads;
        if (l !== null && l !== undefined) {
          leadSum += l;
          leadWeeks++;
        }
      }
    }
    const avgLeads = leadWeeks ? leadSum / leadWeeks : null;
    mgrKpisEl.innerHTML = `
      <div class="m"><div class="l">Team weighted score</div><div class="v tnum">${pctText(teamScore)}</div><div class="sc-kpi-note">over ${periodLabel(mgrPeriod)}</div></div>
      <div class="m"><div class="l">Avg qualified leads</div><div class="v tnum">${avgLeads === null ? "–" : avgLeads.toFixed(1)}</div><div class="sc-kpi-note">of ${leadsTarget} target per week</div></div>
      <div class="m"><div class="l">On track (green)</div><div class="v tnum">${onTrack} / ${people.length}</div></div>
      <div class="m"><div class="l">Need attention</div><div class="v tnum">${attention.length}</div></div>
    `;

    // ---- needs attention ----
    mgrAttentionEl.innerHTML = attention.length
      ? `<div class="sc-attention-list">${attention
          .map(
            (a) => `
            <div class="sc-attention-row">
              <span class="status-badge rag-${a.tagCls}">${escapeHtml(a.tag)}</span>
              <span class="sc-lb-name">${escapeHtml(a.x.p.name)}</span>
              <span class="sc-attention-why">${a.why}</span>
              <button type="button" class="btn-ghost sc-open-prep-btn" data-user-id="${escapeHtml(a.x.p.userId)}">Open 1-on-1 sheet</button>
            </div>`
          )
          .join("")}</div>`
      : `<p class="sc-mgr-ok">Everyone with data is on track — no red flags for ${periodLabel(mgrPeriod)}.</p>`;
    mgrAttentionEl.querySelectorAll<HTMLButtonElement>(".sc-open-prep-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        mgrPrepPersonId = btn.dataset.userId!;
        renderManager();
        mgrPrepEl.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    // ---- leaderboard (full detail) ----
    const ranked = [...scored].sort((a, b) => b.score - a.score);
    const mostImproved = scored.filter((x) => x.trend.delta !== null && x.trend.delta > 0.0001).sort((a, b) => (b.trend.delta as number) - (a.trend.delta as number))[0];
    if (!ranked.length) {
      mgrLeaderboardEl.innerHTML = `<p class="empty-hint">No scored weeks in ${periodLabel(mgrPeriod)} yet.</p>`;
    } else {
      const rows = ranked
        .map((x, i) => {
          const ribbons = [i === 0 ? `<span class="sc-ribbon">★ Top</span>` : "", mostImproved && mostImproved.p.userId === x.p.userId ? `<span class="sc-ribbon">Most improved</span>` : ""].join("");
          const streakText = x.streak >= 1 ? `🔥 ${x.streak} week${x.streak === 1 ? "" : "s"} green` : "No green streak";
          const consistencyBadge = x.consistency.label !== "New" ? `<span class="sc-consistency ${x.consistency.label.toLowerCase()}">${x.consistency.label}</span>` : "";
          const spark = sparklineSvg(scoreSeries(x.p, targets), x.trend.dir === "up" ? "#25A976" : x.trend.dir === "down" ? "#E31346" : "#8a8f9e");
          const trendPts = x.trend.delta === null ? "" : Math.round(Math.abs(x.trend.delta));
          const trendText = x.trend.delta === null ? "—" : x.trend.dir === "up" ? `▲ +${trendPts}pt` : x.trend.dir === "down" ? `▼ -${trendPts}pt` : `→ ${trendPts}pt`;
          return `
            <div class="sc-mgr-lb-row" data-user-id="${escapeHtml(x.p.userId)}">
              <span class="sc-lb-rank${i === 0 ? " lead" : ""}">${i + 1}</span>
              <span class="sc-mgr-lb-id">
                <span class="sc-lb-name">${escapeHtml(x.p.name)}${ribbons}</span>
                <span class="sc-mgr-lb-meta">${streakText}${consistencyBadge}</span>
              </span>
              ${spark ? `<span class="sc-mgr-lb-spark">${spark}</span>` : ""}
              <span class="sc-mgr-trend sc-trend-${x.trend.dir}">${trendText}</span>
              <span class="status-badge rag-${ragClass(x.score, green, settings?.amber_threshold ?? 85)} sc-mgr-lb-score">${pctText(x.score)}</span>
            </div>`;
        })
        .join("");
      const noData = peopleStats
        .filter((x) => x.latest === null)
        .map(
          (x) => `
          <div class="sc-mgr-lb-row sc-mgr-lb-nodata" data-user-id="${escapeHtml(x.p.userId)}">
            <span class="sc-lb-rank">—</span>
            <span class="sc-mgr-lb-id"><span class="sc-lb-name">${escapeHtml(x.p.name)}</span><span class="sc-mgr-lb-meta">Awaiting first entry</span></span>
            <span class="status-badge rag-none">No data</span>
          </div>`
        )
        .join("");
      mgrLeaderboardEl.innerHTML = `<div class="sc-leaderboard">${rows}${noData}</div>`;
    }
    wireLeaderboardClicks(mgrLeaderboardEl, ".sc-mgr-lb-row");

    // ---- team-metric rollup ----
    const metricAvgs = METRICS.map((m) => {
      const vals: number[] = [];
      for (const p of people) {
        const scoped = periodScopedWeeks(p, mgrPeriod);
        const pcts = scoped.map((w) => computeCellPct(m, w.rows[m.key] ?? null, targets[m.key] ?? 0)).filter((v): v is number => v !== null);
        if (pcts.length) vals.push(pcts.reduce((a, b) => a + b, 0) / pcts.length);
      }
      return { m, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, vals };
    });
    const perPersonHead = people.map((p) => `<th>${escapeHtml(p.name)}</th>`).join("");
    const rollupRows = METRICS.map((m) => {
      const perPerson = people
        .map((p) => {
          const scoped = periodScopedWeeks(p, mgrPeriod);
          const pcts = scoped.map((w) => computeCellPct(m, w.rows[m.key] ?? null, targets[m.key] ?? 0)).filter((v): v is number => v !== null);
          const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
          return `<td><span class="status-badge rag-${ragClass(avg, green, settings?.amber_threshold ?? 85)}">${pctText(avg)}</span></td>`;
        })
        .join("");
      const teamAvg = metricAvgs.find((x) => x.m.key === m.key)!.avg;
      const barPct = teamAvg === null ? 0 : Math.min(100, Math.round(teamAvg));
      const target = targets[m.key] ?? 0;
      return `<tr><td>${escapeHtml(m.name)}<div class="sc-cellsub">target ${target}${m.unit}</div></td>${perPerson}<td><span class="status-badge rag-${ragClass(teamAvg, green, settings?.amber_threshold ?? 85)}">${pctText(teamAvg)}</span><div class="sc-mini-bar"><span class="rag-${ragClass(teamAvg, green, settings?.amber_threshold ?? 85)}" style="width:${barPct}%"></span></div></td></tr>`;
    }).join("");
    const weightedRow = `<tr class="sc-mgr-team-row"><td>Weighted score</td>${people.map((p) => `<td>${pctText(periodScore(p, targets, mgrPeriod))}</td>`).join("")}<td>${pctText(teamScore)}</td></tr>`;
    mgrRollupEl.innerHTML = `
      <div class="scorecard-table-wrap">
        <table class="scorecard-table"><thead><tr><th>Metric</th>${perPersonHead}<th>Team avg</th></tr></thead><tbody>${rollupRows}${weightedRow}</tbody></table>
      </div>`;
    const scoredMetricAvgs = metricAvgs.filter((x): x is { m: Metric; avg: number; vals: number[] } => x.avg !== null);
    if (scoredMetricAvgs.length >= 2) {
      const best = scoredMetricAvgs.reduce((a, b) => (b.avg > a.avg ? b : a));
      const worst = scoredMetricAvgs.reduce((a, b) => (b.avg < a.avg ? b : a));
      mgrRollupCalloutEl.innerHTML = `<p class="sc-callout">⚠ Biggest team gap: <strong>${escapeHtml(worst.m.name)} (${pctText(worst.avg)})</strong>. Strongest area: <strong>${escapeHtml(best.m.name)} (${pctText(best.avg)})</strong>. Fixing the shared gap once lifts everyone.</p>`;
    } else {
      mgrRollupCalloutEl.innerHTML = "";
    }

    // ---- effort vs result ----
    const convData = people.map((p) => ({ p, c: conversionOf(p, mgrPeriod) })).filter((x) => x.c.hasCalls);
    if (!convData.length) {
      mgrConversionEl.innerHTML = `<p class="empty-hint">No call data in ${periodLabel(mgrPeriod)} yet.</p>`;
      mgrConversionCalloutEl.innerHTML = "";
    } else {
      const withCpl = convData.filter((x) => x.c.callsPerLead !== null).map((x) => x.c.callsPerLead as number);
      const bestCpl = withCpl.length ? Math.min(...withCpl) : null;
      mgrConversionEl.innerHTML = `<div class="sc-conv-grid">${convData
        .map(({ p, c }) => {
          const flagged = c.callsPerLead === null || (bestCpl !== null && c.callsPerLead > bestCpl * 2);
          const tag = c.callsPerLead === null ? `<span class="status-badge rag-amber">No leads</span>` : flagged ? `<span class="status-badge rag-amber">Quality gap</span>` : `<span class="status-badge rag-green">Efficient</span>`;
          return `
          <div class="sc-conv-card${flagged ? " flagged" : ""}">
            <div class="sc-conv-name">${escapeHtml(p.name)} ${tag}</div>
            <div class="sc-conv-metrics">
              <div><div class="v">${c.callsPerLead === null ? (c.calls ? `${Math.round(c.calls)} / 0` : "–") : Math.round(c.callsPerLead)}</div><div class="k">Calls / lead</div></div>
              <div><div class="v">${escapeHtml(c.talkPerCall)}</div><div class="k">Talk / call</div></div>
            </div>
          </div>`;
        })
        .join("")}</div>`;
      const worstConv = [...convData].sort((a, b) => (b.c.callsPerLead ?? Infinity) - (a.c.callsPerLead ?? Infinity))[0];
      const bestConv = convData.filter((x) => x.c.callsPerLead !== null).sort((a, b) => (a.c.callsPerLead as number) - (b.c.callsPerLead as number))[0];
      if (worstConv && bestConv && worstConv.p.userId !== bestConv.p.userId) {
        const worstDesc = worstConv.c.callsPerLead === null ? `${Math.round(worstConv.c.calls)} calls and no leads yet` : `${Math.round(worstConv.c.callsPerLead)} calls per lead`;
        mgrConversionCalloutEl.innerHTML = `<p class="sc-callout">💡 ${escapeHtml(worstConv.p.name)} is working hardest for the fewest results — <strong>${escapeHtml(worstDesc)}</strong> vs ${escapeHtml(bestConv.p.name)}'s ${Math.round(bestConv.c.callsPerLead as number)}. Sit in on a couple of calls before pushing the numbers higher.</p>`;
      } else {
        mgrConversionCalloutEl.innerHTML = "";
      }
    }

    // ---- 1-on-1 prep sheet ----
    if (!mgrPrepPersonId || !people.some((p) => p.userId === mgrPrepPersonId)) {
      mgrPrepPersonId = attention[0]?.x.p.userId ?? ranked[0]?.p.userId ?? people[0]?.userId ?? null;
    }
    mgrPeoplePillsEl.innerHTML = people
      .map((p) => `<button type="button" class="sc-person-pill${p.userId === mgrPrepPersonId ? " active" : ""}" data-user-id="${escapeHtml(p.userId)}">${escapeHtml(p.name)}</button>`)
      .join("");
    mgrPeoplePillsEl.querySelectorAll<HTMLButtonElement>(".sc-person-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        mgrPrepPersonId = btn.dataset.userId!;
        renderManager();
      });
    });
    if (mgrPrepPersonId) {
      const person = people.find((p) => p.userId === mgrPrepPersonId)!;
      void renderPrepSheet(person, targets);
    }
  }

  mgrPeriodEl.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      mgrPeriod = btn.dataset.period as Period;
      renderManager();
    });
  });

  // --- 1-on-1 prep sheet: talking points, headline, and the inline/present card ---

  function moveBadge(prevPct: number | null, latPct: number | null): { cls: string; text: string } {
    if (prevPct === null || latPct === null) return { cls: "flat", text: "–" };
    const d = latPct - prevPct;
    if (d > 0.5) return { cls: "up", text: `▲ ${Math.round(d)}pt` };
    if (d < -0.5) return { cls: "down", text: `▼ ${Math.round(-d)}pt` };
    return { cls: "flat", text: "no change" };
  }

  function talkingPoints(latestRows: PersonWeek["rows"], trend: { declining: number; delta: number | null }, targets: Record<string, number>): string[] {
    const pts: string[] = [];
    let worst: { m: Metric; pct: number } | null = null;
    for (const m of METRICS) {
      const pct = computeCellPct(m, latestRows[m.key] ?? null, targets[m.key] ?? 0);
      if (pct !== null && (worst === null || pct < worst.pct)) worst = { m, pct };
    }
    if (worst) pts.push(`Biggest gap this week: ${worst.m.name} at ${pctText(worst.pct)} of target.`);
    const c = latestRows.calls;
    const l = latestRows.leads;
    if (c !== null && c !== undefined && l !== null && l !== undefined) {
      const callsPct = (targets.calls ?? 0) > 0 ? c / (targets.calls ?? 1) : 0;
      const leadsPct = (targets.leads ?? 0) > 0 ? l / (targets.leads ?? 1) : 0;
      if (callsPct >= 0.9 && leadsPct < (settings?.amber_threshold ?? 85) / 100) {
        pts.push(`High activity (${c} calls) but only ${l} lead${l === 1 ? "" : "s"} — looks like a conversion issue, not effort. Review call quality together.`);
      }
    }
    if (trend.declining >= 2) pts.push(`Weighted score is down ${trend.declining} weeks running — worth asking what's changed recently.`);
    if (trend.delta !== null && trend.delta > 8) pts.push(`Big jump this week (up ${Math.round(trend.delta)} points) — reinforce what's working.`);
    const fu = latestRows.follow_up;
    if (fu !== null && fu !== undefined && fu < 100) pts.push(`Follow-up emails at ${fu}% — still short of 100%. What's the blocker?`);
    if (!pts.length) pts.push("On track across the board — keep the momentum and set the next stretch target.");
    return pts;
  }

  function prepHeadline(series: number[], trend: { dir: "up" | "down" | "flat"; delta: number | null; declining: number }, streak: number, consistency: { label: string }): string {
    if (!series.length) return "No weeks recorded yet — start a scorecard to build this review.";
    const parts: string[] = [];
    if (trend.delta !== null) {
      if (trend.dir === "up") parts.push(`Up ${Math.round(trend.delta)} points on last week`);
      else if (trend.dir === "down") parts.push(`Down ${Math.round(-trend.delta)} points on last week${trend.declining >= 2 ? `, ${trend.declining} weeks running` : ""}`);
      else parts.push("Holding level with last week");
    } else {
      parts.push("First week on record");
    }
    if (streak >= 2) parts.push(`${streak} weeks green in a row`);
    else if (streak === 1) parts.push("green this week");
    if (consistency.label === "Swingy") parts.push("swings week to week");
    else if (consistency.label === "Steady") parts.push("steady week to week");
    return `${parts.join(" · ")}.`;
  }

  function prepSheetHtml(
    person: PersonSeries,
    targets: Record<string, number>,
    latest: ScorecardWeek | undefined,
    prev: ScorecardWeek | undefined,
    forPresent: boolean
  ): string {
    const green = settings?.green_threshold ?? 100;
    const amber = settings?.amber_threshold ?? 85;
    const series = scoreSeries(person, targets);
    const lscore = latestScore(person, targets);
    const trend = trendOf(person, targets);
    const streak = streakOf(person, targets, green);
    const consistency = consistencyOf(person, targets);
    const conv = conversionOf(person, mgrPeriod);
    const latestWeek = person.weeks.length ? person.weeks[person.weeks.length - 1] : null;

    const badges = [
      streak >= 1 ? `<span class="sc-prep-chip streak">${streak} ${streak === 1 ? "wk" : "wks"} green</span>` : "",
      consistency.label !== "New" ? `<span class="sc-prep-chip ${consistency.label.toLowerCase()}">${consistency.label}</span>` : "",
      trend.delta !== null && trend.dir !== "flat" ? `<span class="sc-prep-chip trend-${trend.dir}">${trend.dir === "up" ? "▲ up" : "▼ down"}${trend.dir === "down" && trend.declining >= 1 ? ` ${trend.declining} wks` : " vs last week"}</span>` : "",
      `<span class="status-badge rag-${lscore === null ? "none" : ragClass(lscore, green, amber)}">${lscore === null ? "No data" : `Weighted ${pctText(lscore)}`}</span>`,
    ].join("");

    const metricRows = METRICS.map((m) => {
      const raw = latest ? latest.entries[m.key]?.actual ?? null : null;
      const pct = computeCellPct(m, raw, targets[m.key] ?? 0);
      const prevPct = prev ? computeCellPct(m, prev.entries[m.key]?.actual ?? null, targets[m.key] ?? 0) : null;
      const badge = moveBadge(prevPct, pct);
      const valText = raw === null || raw === undefined ? "–" : m.isPercent ? `${raw}%` : String(raw);
      return `<tr><td>${escapeHtml(m.name.replace(" (hours)", ""))}</td><td class="mono">${valText}</td><td class="mono">${targets[m.key] ?? 0}${m.unit}</td><td><span class="status-badge rag-${ragClass(pct, green, amber)}">${pctText(pct)}</span></td><td><span class="sc-move ${badge.cls}">${badge.text}</span></td></tr>`;
    }).join("");

    const prevActionsRows: string[] = [];
    if (prev) {
      for (const m of METRICS) {
        const act = (prev.entries[m.key]?.action ?? "").trim();
        if (!act) continue;
        const prevPct = computeCellPct(m, prev.entries[m.key]?.actual ?? null, targets[m.key] ?? 0);
        const latPct = latest ? computeCellPct(m, latest.entries[m.key]?.actual ?? null, targets[m.key] ?? 0) : null;
        const badge = moveBadge(prevPct, latPct);
        prevActionsRows.push(`<li><span class="sc-move ${badge.cls}">${badge.text}</span><span class="sc-action-text">${escapeHtml(act)}<small>${escapeHtml(m.name)}: ${pctText(prevPct)} → ${pctText(latPct)}</small></span></li>`);
      }
    }
    const focusRows: string[] = [];
    if (latest) {
      for (const m of METRICS) {
        const act = (latest.entries[m.key]?.action ?? "").trim();
        if (!act) continue;
        const pct = computeCellPct(m, latest.entries[m.key]?.actual ?? null, targets[m.key] ?? 0);
        focusRows.push(`<li><span class="sc-metric-tag">${escapeHtml(m.name.replace(" (hours)", ""))}</span><span class="sc-action-text">${escapeHtml(act)}<small>Now at ${pctText(pct)} of target</small></span></li>`);
      }
    }
    const points = latestWeek ? talkingPoints(latestWeek.rows, trend, targets) : ["No data yet — fill in a week to generate talking points."];

    return `
      <div class="sc-prep-card${forPresent ? " sc-prep-present" : ""}">
        <div class="sc-prep-top">
          <div class="sc-prep-who">${escapeHtml(person.name)}<small>BDE · ${latest ? `week commencing ${latest.week_commencing}` : "no weeks recorded"}</small></div>
          <div class="sc-prep-badges">
            ${badges}
            ${!forPresent ? `<button type="button" class="btn-ghost sc-present-btn" data-user-id="${escapeHtml(person.userId)}">Present to BDE</button>` : ""}
          </div>
        </div>
        <div class="sc-prep-score">
          <div class="sc-prep-bigscore">
            <div class="big ${lscore === null ? "" : ragClass(lscore, green, amber)}">${pctText(lscore)}</div>
            <div class="lbl">Weighted score</div>
          </div>
          ${series.length >= 2 ? `<div class="sc-prep-spark">${sparklineSvg(series)}<span>${series.length} weeks</span></div>` : ""}
          <div class="sc-prep-say">${escapeHtml(prepHeadline(series, trend, streak, consistency))}</div>
        </div>
        <div class="scorecard-table-wrap">
          <table class="scorecard-table"><thead><tr><th>Metric</th><th>This week</th><th>Target</th><th>% of target</th><th>vs last week</th></tr></thead><tbody>${metricRows}</tbody></table>
        </div>
        <div class="sc-prep-effort">
          <div><div class="v">${conv.hasCalls ? conv.calls : "–"}</div><div class="k">Calls · ${escapeHtml(periodLabel(mgrPeriod))}</div></div>
          <div><div class="v">${conv.hasLeads ? conv.leads : "–"}</div><div class="k">Qualified leads</div></div>
          <div><div class="v">${conv.callsPerLead === null ? "–" : `${Math.round(conv.callsPerLead)} : 1`}</div><div class="k">Calls per lead</div></div>
          <div><div class="v">${escapeHtml(conv.talkPerCall)}</div><div class="k">Talk time per call</div></div>
        </div>
        <div class="sc-prep-body">
          <div>
            <h5>Since last week's actions</h5>
            ${prevActionsRows.length ? `<ul class="sc-prep-actions">${prevActionsRows.join("")}</ul>` : `<p class="sc-prep-empty">No actions were recorded on the previous week's scorecard.</p>`}
            <h5 class="sc-prep-h5-gap">Agreed focus for the week ahead</h5>
            ${focusRows.length ? `<ul class="sc-prep-actions">${focusRows.join("")}</ul>` : `<p class="sc-prep-empty">No actions set for the current week yet.</p>`}
          </div>
          <div>
            <h5>Talking points</h5>
            <ul class="sc-prep-points">${points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
          </div>
        </div>
      </div>`;
  }

  async function fetchPrepWeeks(person: PersonSeries): Promise<{ latest: ScorecardWeek | undefined; prev: ScorecardWeek | undefined }> {
    try {
      const fullWeeks = await getScorecardWeeks(person.userId);
      const sorted = [...fullWeeks].sort((a, b) => (a.week_commencing < b.week_commencing ? -1 : 1));
      return { latest: sorted[sorted.length - 1], prev: sorted[sorted.length - 2] };
    } catch {
      return { latest: undefined, prev: undefined };
    }
  }

  async function renderPrepSheet(person: PersonSeries, targets: Record<string, number>): Promise<void> {
    const { latest, prev } = await fetchPrepWeeks(person);
    mgrPrepEl.innerHTML = prepSheetHtml(person, targets, latest, prev, false);
    mgrPrepEl.querySelector<HTMLButtonElement>(".sc-present-btn")?.addEventListener("click", () => void openPresentMode(person, targets, latest, prev));
  }

  async function openPresentMode(person: PersonSeries, targets: Record<string, number>, latest: ScorecardWeek | undefined, prev: ScorecardWeek | undefined): Promise<void> {
    const { overlay, close } = openOverlay(
      `<div class="sc-present-shell">
        <div class="sc-present-bar">
          <div class="sc-present-title">1-on-1 review<small>${escapeHtml(person.name)}</small></div>
          <button type="button" class="btn-ghost sc-present-close">Close</button>
        </div>
        <div class="sc-present-body">${prepSheetHtml(person, targets, latest, prev, true)}</div>
      </div>`,
      { overlayClassName: "sc-present-overlay", onEscape: () => close() }
    );
    overlay.querySelector<HTMLButtonElement>(".sc-present-close")!.addEventListener("click", close);
  }

  // =========================================================================
  // Settings: targets/thresholds, backup export, reset to defaults
  // =========================================================================

  const DEFAULT_TARGETS: Record<string, number> = { calls: 675, talk_time: 10, leads: 3, campaigns: 3, follow_up: 100, crm: 100 };

  resetDefaultsBtn.addEventListener("click", async () => {
    const action = await confirmDialog({
      title: "Reset all weekly targets and thresholds back to the defaults?",
      actions: [
        { id: "cancel", label: "Cancel", variant: "ghost" },
        { id: "reset", label: "Reset", variant: "primary" },
      ],
    });
    if (action !== "reset") return;
    try {
      settings = await updateScorecardSettings({ greenThreshold: 100, amberThreshold: 85, notesVisibility: visibilityInput.value as ScorecardSettings["notes_visibility"], targets: DEFAULT_TARGETS });
      greenInput.value = "100";
      amberInput.value = "85";
      renderTargetRows();
      renderRows();
      renderDashboard();
      renderManager();
      showToast("Scorecard defaults restored");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to reset defaults");
    }
  });

  backupExportBtn.addEventListener("click", async () => {
    backupExportBtn.disabled = true;
    try {
      const [currentSettings, weeksByMember] = await Promise.all([
        getScorecardSettings(),
        Promise.all(allMembers.map(async (m) => ({ member: m, weeks: await getScorecardWeeks(m.id) }))),
      ]);
      const payload = {
        app: "CoPilotIQ Scorecard",
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: currentSettings,
        people: weeksByMember.map(({ member, weeks }) => ({ user_id: member.id, name: member.name, weeks })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `scorecard-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast("Backup downloaded");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to build backup");
    } finally {
      backupExportBtn.disabled = false;
    }
  });

  // =========================================================================
  // Save / entry actions
  // =========================================================================

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
      await upsertScorecardWeek(user.id, currentWeek, draftReviewDate, entries);
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

  // =========================================================================
  // CSV "Import calls"
  // =========================================================================

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

  // =========================================================================
  // Legacy Firestore migration (admin-only)
  // =========================================================================

  migrateFileInput.addEventListener("change", () => {
    const file = migrateFileInput.files?.[0];
    if (file) void handleMigrateFile(file);
    migrateFileInput.value = "";
  });

  async function handleMigrateFile(file: File): Promise<void> {
    let backupJson: unknown;
    try {
      backupJson = JSON.parse(await file.text());
    } catch {
      showToast("Couldn't parse that file as JSON.");
      return;
    }
    let preview: ScorecardMigratePreviewResult;
    try {
      preview = await scorecardMigratePreview(backupJson);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to read that backup");
      return;
    }
    if (!preview.profiles.length) {
      migratePreviewEl.innerHTML = `<p class="empty-hint">No profiles found in that file.</p>`;
      return;
    }

    const memberOptionsHtml = (selected: string | null) =>
      `<option value="">— skip —</option>` +
      allMembers.map((u) => `<option value="${escapeHtml(u.id)}" ${u.id === selected ? "selected" : ""}>${escapeHtml(u.name)}</option>`).join("");

    migratePreviewEl.innerHTML = `
      <p class="conflict-modal-hint">${preview.profiles.length} profile${preview.profiles.length === 1 ? "" : "s"} found, ${preview.total_weeks} week${preview.total_weeks === 1 ? "" : "s"} total. Review the suggested match for each, then Import.</p>
      <div class="scorecard-table-wrap">
        <table class="scorecard-table">
          <thead><tr><th>Legacy profile</th><th>Weeks</th><th>Import as</th></tr></thead>
          <tbody>
            ${preview.profiles
              .map(
                (p) => `
              <tr data-profile-id="${escapeHtml(p.profile_id)}">
                <td>${escapeHtml(p.profile_name)}</td>
                <td class="mono">${p.week_count}</td>
                <td><select class="sc-migrate-map-select">${memberOptionsHtml(p.suggested_user_id)}</select></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
      <div class="sc-actions"><button type="button" class="btn-primary" id="sc-migrate-commit-btn">Import</button></div>
    `;

    migratePreviewEl.querySelector<HTMLButtonElement>("#sc-migrate-commit-btn")!.addEventListener("click", async () => {
      const mapping: Record<string, string | null> = {};
      migratePreviewEl.querySelectorAll<HTMLTableRowElement>("tr[data-profile-id]").forEach((row) => {
        const select = row.querySelector<HTMLSelectElement>(".sc-migrate-map-select")!;
        mapping[row.dataset.profileId!] = select.value || null;
      });
      try {
        const result = await scorecardMigrateCommit(backupJson, mapping);
        showToast(`Imported ${result.profiles_imported} profile${result.profiles_imported === 1 ? "" : "s"}, ${result.weeks_imported} week${result.weeks_imported === 1 ? "" : "s"}`);
        migratePreviewEl.innerHTML = "";
        void loadTeamData();
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Failed to import");
      }
    });
  }

  // =========================================================================
  // Tabs + permissions
  // =========================================================================

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
    const admin = isAdmin();
    migrateSectionEl.classList.toggle("hidden", !admin);
    migratePanelEl.classList.toggle("hidden", !admin);
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
