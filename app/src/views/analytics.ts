import { Chart, registerables } from "chart.js";
import type { Lead, LeadList } from "../api";
import { setIndustryFilter } from "../components/industryFilter";
import { CONTACT_STATUS_ORDER } from "../constants";
import { setPendingDashboardContactStatusFilter } from "../dashboardFilterHandoff";
import { getLeadLists, refreshLeadLists, subscribeLeadLists } from "../leadLists";
import { normalizeSicIndustry } from "../sic";
import { getLeads, subscribe } from "../state";
import { openTab } from "../tabs";
import { escapeHtml } from "../utils";

Chart.register(...registerables);

let industryChart: Chart | null = null;
let trendChart: Chart | null = null;
let statusChart: Chart | null = null;
let chargeLendersChart: Chart | null = null;
let callingByListChart: Chart | null = null;

interface Charge {
  status: string;
  created_on: string;
  holders: string[];
  classification: string;
  description: string;
}

function parseCharges(leads: Lead[]): Charge[] {
  const all: Charge[] = [];
  for (const lead of leads) {
    if (!lead.ch_data) continue;
    try {
      const d = JSON.parse(lead.ch_data);
      if (Array.isArray(d.charges)) all.push(...(d.charges as Charge[]));
    } catch { /* skip */ }
  }
  return all;
}

function computeChargeStats(leads: Lead[]) {
  const charges = parseCharges(leads);
  const outstanding = charges.filter((c) => c.status === "outstanding");
  const leadsWithOutstanding = leads.filter((l) => {
    if (!l.ch_data) return false;
    try {
      const d = JSON.parse(l.ch_data);
      return Array.isArray(d.charges) && (d.charges as Charge[]).some((c) => c.status === "outstanding");
    } catch { return false; }
  });

  const lenderCounts: Record<string, number> = {};
  for (const c of outstanding) {
    for (const h of c.holders) {
      if (h) lenderCounts[h] = (lenderCounts[h] || 0) + 1;
    }
  }
  const typeCounts: Record<string, number> = {};
  for (const c of charges) {
    const type = c.classification || "Unknown";
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  return { outstanding: outstanding.length, leadsWithCharges: leadsWithOutstanding.length, lenderCounts, typeCounts };
}

function computeKpis(leads: Lead[]) {
  const total = leads.length;
  const contacted = leads.filter((l) => l.contact_status !== CONTACT_STATUS_ORDER[0]).length;
  const replied = leads.filter((l) => l.contact_status === "Replied" || l.contact_status === "Converted").length;
  const converted = leads.filter((l) => l.contact_status === "Converted").length;
  const replyRate = contacted === 0 ? 0 : replied / contacted;
  const conversionRate = total === 0 ? 0 : converted / total;
  return { total, contacted, replyRate, conversionRate };
}

function computeCoverage(leads: Lead[]) {
  if (!leads.length) return { phone: 0, companyNumber: 0, enriched: 0 };
  const n = leads.length;
  return {
    phone: leads.filter((l) => l.phone_number).length / n,
    companyNumber: leads.filter((l) => l.company_number).length / n,
    enriched: leads.filter((l) => l.ch_data).length / n,
  };
}

function computeIndustryCounts(leads: Lead[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const lead of leads) {
    const industry = normalizeSicIndustry(lead.industry) || "Uncategorized";
    counts[industry] = (counts[industry] || 0) + 1;
  }
  return counts;
}

function computeStatusDistribution(leads: Lead[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of CONTACT_STATUS_ORDER) counts[s] = 0;
  for (const lead of leads) {
    const s = lead.contact_status || CONTACT_STATUS_ORDER[0];
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

/** Cumulative funnel using CONTACT_STATUS_ORDER rank: a lead counts toward every stage at or before its own. */
function computeFunnel(leads: Lead[]): number[] {
  return CONTACT_STATUS_ORDER.map(
    (_, rank) => leads.filter((l) => CONTACT_STATUS_ORDER.indexOf(l.contact_status) >= rank).length
  );
}

function monthKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function computeMonthlyTrend(leads: Lead[]): { labels: string[]; counts: number[] } {
  const counts: Record<string, number> = {};
  for (const lead of leads) {
    const key = monthKey(lead.timestamp);
    counts[key] = (counts[key] || 0) + 1;
  }
  const labels = Object.keys(counts).sort();
  return { labels, counts: labels.map((k) => counts[k]) };
}

function leadHasPhone(lead: Lead): boolean {
  return !!(lead.phone_number && lead.phone_number !== "not_found");
}

interface ListCallStats {
  listId: string | null;
  name: string;
  owner: string;
  total: number;
  hasPhone: number;
  called: number;
  replied: number;
  converted: number;
}

const UNASSIGNED_KEY = "__unassigned__";

/** Per-list ("call sheet") calling breakdown. Seeded from the known lists so
 * empty sheets still appear, plus an "Unassigned" bucket for any lead that is
 * not on a list. A lead's called_at is the same flag the call sheet toggles. */
function computeCallingByList(leads: Lead[], lists: LeadList[]): ListCallStats[] {
  const buckets = new Map<string, ListCallStats>();
  const ensure = (key: string, listId: string | null, name: string, owner: string): ListCallStats => {
    let b = buckets.get(key);
    if (!b) {
      b = { listId, name, owner, total: 0, hasPhone: 0, called: 0, replied: 0, converted: 0 };
      buckets.set(key, b);
    }
    return b;
  };

  for (const list of lists) ensure(list.id, list.id, list.name, list.owner_name || "—");

  for (const lead of leads) {
    const b =
      lead.list_id && buckets.has(lead.list_id)
        ? buckets.get(lead.list_id)!
        : ensure(UNASSIGNED_KEY, null, "No list (unassigned)", "—");
    b.total += 1;
    if (leadHasPhone(lead)) b.hasPhone += 1;
    if (lead.called_at) b.called += 1;
    if (lead.contact_status === "Replied" || lead.contact_status === "Converted") b.replied += 1;
    if (lead.contact_status === "Converted") b.converted += 1;
  }

  // Busiest sheets first; the unassigned bucket always sinks to the bottom.
  return [...buckets.values()].sort((a, b) => {
    if (a.listId === null) return 1;
    if (b.listId === null) return -1;
    return b.total - a.total;
  });
}

function renderCallingByList(leads: Lead[], lists: LeadList[]): void {
  const stats = computeCallingByList(leads, lists);
  const withLeads = stats.filter((s) => s.total > 0);

  const totalLeads = leads.length;
  const totalCalled = leads.filter((l) => l.called_at).length;
  const pctCalled = totalLeads === 0 ? 0 : Math.round((totalCalled / totalLeads) * 100);
  document.querySelector("#call-kpi-called")!.textContent = String(totalCalled);
  document.querySelector("#call-kpi-not-called")!.textContent = String(totalLeads - totalCalled);
  document.querySelector("#call-kpi-pct")!.textContent = `${pctCalled}%`;
  document.querySelector("#call-kpi-sheets")!.textContent = String(lists.length);

  const tableEl = document.querySelector<HTMLElement>("#call-list-table")!;

  if (withLeads.length === 0) {
    tableEl.innerHTML =
      '<p class="empty-hint">No call sheets with leads yet — build one on the Cold Call Lists page.</p>';
    callingByListChart?.destroy();
    callingByListChart = null;
    return;
  }

  const rows = withLeads
    .map((s) => {
      const pct = s.total === 0 ? 0 : Math.round((s.called / s.total) * 100);
      const owner = s.listId === null ? '<span class="empty-hint">—</span>' : escapeHtml(s.owner);
      return `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${owner}</td>
          <td class="num">${s.total}</td>
          <td class="num">${s.hasPhone}</td>
          <td class="num">${s.called}</td>
          <td class="num">${s.total - s.called}</td>
          <td>
            <div class="call-pct-wrap">
              <div class="funnel-bar-track call-pct-track"><div class="funnel-bar-fill" style="width:${pct}%"></div></div>
              <span class="num">${pct}%</span>
            </div>
          </td>
          <td class="num">${s.replied}</td>
          <td class="num">${s.converted}</td>
        </tr>`;
    })
    .join("");

  const totals = withLeads.reduce(
    (acc, s) => ({
      total: acc.total + s.total,
      hasPhone: acc.hasPhone + s.hasPhone,
      called: acc.called + s.called,
      replied: acc.replied + s.replied,
      converted: acc.converted + s.converted,
    }),
    { total: 0, hasPhone: 0, called: 0, replied: 0, converted: 0 }
  );
  const totalsPct = totals.total === 0 ? 0 : Math.round((totals.called / totals.total) * 100);

  tableEl.innerHTML = `
    <table class="charge-type-tbl call-list-tbl">
      <thead>
        <tr>
          <th>Call sheet</th><th>Owner</th>
          <th class="num">Leads</th><th class="num">Has phone</th>
          <th class="num">Called</th><th class="num">Not called</th>
          <th>% Called</th>
          <th class="num">Replied</th><th class="num">Converted</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="call-list-total">
          <td>All sheets</td><td></td>
          <td class="num">${totals.total}</td><td class="num">${totals.hasPhone}</td>
          <td class="num">${totals.called}</td><td class="num">${totals.total - totals.called}</td>
          <td class="num">${totalsPct}%</td>
          <td class="num">${totals.replied}</td><td class="num">${totals.converted}</td>
        </tr>
      </tfoot>
    </table>`;

  const canvas = document.querySelector<HTMLCanvasElement>("#call-list-chart");
  if (canvas) {
    const top = withLeads.slice(0, 12);
    callingByListChart?.destroy();
    callingByListChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: top.map((s) => s.name),
        datasets: [
          { label: "Called", data: top.map((s) => s.called), backgroundColor: "#E31346" },
          { label: "Not called", data: top.map((s) => s.total - s.called), backgroundColor: "#e2e8f0" },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          x: { stacked: true, beginAtZero: true, ticks: { precision: 0 } },
          y: { stacked: true },
        },
      },
    });
  }
}

function renderKpis(leads: Lead[]): void {
  const { total, contacted, replyRate, conversionRate } = computeKpis(leads);
  document.querySelector("#kpi-total")!.textContent = String(total);
  document.querySelector("#kpi-contacted")!.textContent = String(contacted);
  document.querySelector("#kpi-reply-rate")!.textContent = `${Math.round(replyRate * 100)}%`;
  document.querySelector("#kpi-conversion-rate")!.textContent = `${Math.round(conversionRate * 100)}%`;
}

function renderCoverageStats(leads: Lead[]): void {
  const { phone, companyNumber, enriched } = computeCoverage(leads);
  const n = leads.length;
  const setRow = (key: string, ratio: number, count: number): void => {
    const pct = `${Math.round(ratio * 100)}%`;
    const pcEl = document.querySelector<HTMLElement>(`#cov-${key}`);
    const barEl = document.querySelector<HTMLElement>(`#cov-${key}-bar`);
    const emEl = document.querySelector<HTMLElement>(`#cov-${key}-em`);
    if (pcEl) pcEl.textContent = pct;
    if (barEl) barEl.style.width = pct;
    if (emEl) emEl.textContent = n ? `${count.toLocaleString()} / ${n.toLocaleString()}` : "";
  };
  setRow("phone", phone, leads.filter((l) => l.phone_number).length);
  setRow("company-number", companyNumber, leads.filter((l) => l.company_number).length);
  setRow("enriched", enriched, leads.filter((l) => l.ch_data).length);
}

function renderIndustryChart(leads: Lead[]): void {
  const counts = computeIndustryCounts(leads);
  const labels = Object.keys(counts).sort();
  const data = labels.map((l) => counts[l]);
  const canvas = document.querySelector<HTMLCanvasElement>("#industry-chart")!;
  industryChart?.destroy();
  industryChart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ label: "Leads", data, backgroundColor: "#E31346" }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onHover: (event, elements) => {
        (event.native?.target as HTMLElement).style.cursor = elements.length ? "pointer" : "default";
      },
      onClick: (_event, elements) => {
        if (!elements.length) return;
        const industry = labels[elements[0].index];
        setIndustryFilter([industry]);
        openTab("dashboard", "Leads");
      },
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function renderStatusChart(leads: Lead[]): void {
  const counts = computeStatusDistribution(leads);
  const labels = Object.keys(counts);
  const data = labels.map((l) => counts[l]);
  const colors = ["#94a3b8", "#E31346", "#E69D26", "#25A976"];
  const canvas = document.querySelector<HTMLCanvasElement>("#status-chart")!;
  statusChart?.destroy();
  statusChart = new Chart(canvas, {
    type: "doughnut",
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onHover: (event, elements) => {
        (event.native?.target as HTMLElement).style.cursor = elements.length ? "pointer" : "default";
      },
      onClick: (_event, elements) => {
        if (!elements.length) return;
        const rank = CONTACT_STATUS_ORDER.indexOf(labels[elements[0].index]);
        if (rank >= 0) {
          setPendingDashboardContactStatusFilter(rank);
          openTab("dashboard", "Leads");
        }
      },
      plugins: { legend: { position: "bottom" } },
    },
  });
}

function renderFunnel(leads: Lead[]): void {
  const counts = computeFunnel(leads);
  const max = counts[0] || 1;
  const container = document.querySelector<HTMLDivElement>("#funnel-container")!;
  container.innerHTML = CONTACT_STATUS_ORDER.map((stage, i) => {
    const pct = max === 0 ? 0 : Math.round((counts[i] / max) * 100);
    return `
      <div class="funnel-row" data-rank="${i}" title="Show leads at or beyond ${stage}">
        <span class="funnel-label">${stage}</span>
        <div class="funnel-bar-track"><div class="funnel-bar-fill" style="width: ${pct}%"></div></div>
        <span class="funnel-count">${counts[i]}</span>
      </div>
    `;
  }).join("");

  container.querySelectorAll<HTMLDivElement>(".funnel-row").forEach((row) => {
    row.addEventListener("click", () => {
      setPendingDashboardContactStatusFilter(Number(row.dataset.rank));
      openTab("dashboard", "Leads");
    });
  });
}

function renderTrendChart(leads: Lead[]): void {
  const { labels, counts } = computeMonthlyTrend(leads);
  const canvas = document.querySelector<HTMLCanvasElement>("#trend-chart")!;
  trendChart?.destroy();
  trendChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "New leads",
          data: counts,
          backgroundColor: "rgba(227, 19, 70, 0.7)",
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

function renderChargesAnalytics(leads: Lead[]): void {
  const stats = computeChargeStats(leads);

  document.querySelector("#charge-kpi-outstanding")!.textContent = String(stats.outstanding);
  document.querySelector("#charge-kpi-leads")!.textContent = String(stats.leadsWithCharges);

  // Top lenders bar chart
  const lenders = Object.entries(stats.lenderCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const canvas = document.querySelector<HTMLCanvasElement>("#charge-lenders-chart");
  if (canvas) {
    chargeLendersChart?.destroy();
    chargeLendersChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels: lenders.map(([name]) => name),
        datasets: [{ label: "Outstanding charges", data: lenders.map(([, n]) => n), backgroundColor: "#f59e0b" }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  // Charge type table
  const tableEl = document.querySelector<HTMLElement>("#charge-type-table");
  if (tableEl) {
    const types = Object.entries(stats.typeCounts).sort((a, b) => b[1] - a[1]);
    tableEl.innerHTML = types.length === 0
      ? '<p class="empty-hint">No charges data yet — enrich leads from Companies House first.</p>'
      : `<table class="charge-type-tbl">
          <thead><tr><th>Charge type</th><th>Count</th></tr></thead>
          <tbody>
            ${types.map(([type, n]) => `<tr><td>${escapeHtml(type)}</td><td>${n}</td></tr>`).join("")}
          </tbody>
        </table>`;
  }
}

function renderAnalytics(): void {
  const leads = getLeads();
  const emptyEl = document.querySelector("#analytics-empty")!;
  const contentEl = document.querySelector("#analytics-content")!;

  if (leads.length === 0) {
    emptyEl.classList.remove("hidden");
    contentEl.classList.add("hidden");
    return;
  }
  emptyEl.classList.add("hidden");
  contentEl.classList.remove("hidden");

  renderKpis(leads);
  renderCoverageStats(leads);
  renderIndustryChart(leads);
  renderStatusChart(leads);
  renderFunnel(leads);
  renderTrendChart(leads);
  renderCallingByList(leads, getLeadLists());
  renderChargesAnalytics(leads);
}

export function initAnalytics(): void {
  const container = document.querySelector<HTMLDivElement>("#view-analytics")!;
  container.innerHTML = `
    <main class="container">
      <div id="analytics-empty" class="card hidden">
        <p class="empty-state">No leads yet — run some lookups on the Dashboard to see analytics here.</p>
      </div>
      <div id="analytics-content">
        <header class="page-head">
          <div>
            <h1 class="page-title">Analytics</h1>
            <div class="page-meta">
              <span>Performance across the whole lead pool</span>
              <span class="pm-sep">·</span>
              <span class="mono pm-sync">LIVE</span>
            </div>
          </div>
        </header>

        <div class="sec-head"><span class="sec-num">A</span><h3 class="action-section-title">Performance summary</h3><span class="sec-rule"></span><span class="sec-count">all-time</span></div>
        <section class="metrics">
          <div class="m"><div class="l">Total leads</div><div class="v tnum" id="kpi-total">0</div></div>
          <div class="m"><div class="l">Contacted</div><div class="v tnum" id="kpi-contacted">0</div></div>
          <div class="m"><div class="l">Reply rate</div><div class="v tnum" id="kpi-reply-rate">0%</div></div>
          <div class="m"><div class="l">Conversion</div><div class="v tnum" id="kpi-conversion-rate">0%</div></div>
        </section>

        <div class="sec-head"><span class="sec-num">B</span><h3 class="action-section-title">Data coverage</h3><span class="sec-rule"></span><span class="sec-count">count &amp; %</span></div>
        <section class="panel">
          <div class="cov">
            <div class="row"><span class="cl">Has phone number <em id="cov-phone-em"></em></span><span class="bar"><i id="cov-phone-bar" style="width:0%"></i></span><span class="pc" id="cov-phone">0%</span></div>
            <div class="row"><span class="cl">Companies House number <em id="cov-company-number-em"></em></span><span class="bar b2"><i id="cov-company-number-bar" style="width:0%"></i></span><span class="pc" id="cov-company-number">0%</span></div>
            <div class="row"><span class="cl">Fully enriched <em id="cov-enriched-em"></em></span><span class="bar b3"><i id="cov-enriched-bar" style="width:0%"></i></span><span class="pc" id="cov-enriched">0%</span></div>
          </div>
        </section>

        <section class="card">
          <h2 class="card-title">Leads by Industry</h2>
          <div class="chart-wrap"><canvas id="industry-chart"></canvas></div>
        </section>

        <div class="charts-row">
          <section class="card">
            <h2 class="card-title">Contact Status</h2>
            <div class="chart-wrap chart-wrap-sm"><canvas id="status-chart"></canvas></div>
          </section>

          <section class="card">
            <h2 class="card-title">Funnel</h2>
            <div id="funnel-container"></div>
          </section>
        </div>

        <section class="card">
          <h2 class="card-title">Monthly New Leads</h2>
          <div class="chart-wrap"><canvas id="trend-chart"></canvas></div>
        </section>

        <section class="card">
          <h2 class="card-title">Sales Calling by List</h2>
          <p class="card-subtitle">How many leads on each call sheet have been called, and the outcomes. From the Cold Call Lists.</p>
          <div class="stats-grid" style="margin-bottom: var(--space-4)">
            <div class="stat-card">
              <span class="stat-label">Total Called</span>
              <span id="call-kpi-called" class="stat-value">0</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Not Called</span>
              <span id="call-kpi-not-called" class="stat-value">0</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">% Called</span>
              <span id="call-kpi-pct" class="stat-value">0%</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Call Sheets</span>
              <span id="call-kpi-sheets" class="stat-value">0</span>
            </div>
          </div>
          <div id="call-list-table"></div>
          <h3 class="card-subtitle" style="font-weight:600;margin:var(--space-4) 0 var(--space-2)">Called vs. not called by sheet</h3>
          <div class="chart-wrap" style="min-height:240px"><canvas id="call-list-chart"></canvas></div>
        </section>

        <section class="card">
          <h2 class="card-title">Companies House — Charges</h2>
          <p class="card-subtitle">From enriched leads only. Enrich from the Leads page to populate.</p>
          <div class="stats-grid" style="margin-bottom: var(--space-4)">
            <div class="stat-card">
              <span class="stat-label">Outstanding charges total</span>
              <span id="charge-kpi-outstanding" class="stat-value">0</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Leads with outstanding charges</span>
              <span id="charge-kpi-leads" class="stat-value">0</span>
            </div>
          </div>
          <h3 class="card-subtitle" style="font-weight:600;margin-bottom:var(--space-2)">Top charge holders (lenders)</h3>
          <div class="chart-wrap" style="min-height:200px"><canvas id="charge-lenders-chart"></canvas></div>
          <h3 class="card-subtitle" style="font-weight:600;margin:var(--space-4) 0 var(--space-2)">Charge types</h3>
          <div id="charge-type-table"></div>
        </section>
      </div>
    </main>
  `;

  subscribe(renderAnalytics);
  subscribeLeadLists(renderAnalytics);
  void refreshLeadLists();
  renderAnalytics();
}
