import { Chart, registerables } from "chart.js";
import type { Lead } from "../api";
import { setIndustryFilter } from "../components/industryFilter";
import { CONTACT_STATUS_ORDER } from "../constants";
import { setPendingDashboardContactStatusFilter } from "../dashboardFilterHandoff";
import { normalizeSicIndustry } from "../sic";
import { getLeads, subscribe } from "../state";
import { openTab } from "../tabs";
import { escapeHtml } from "../utils";

Chart.register(...registerables);

let industryChart: Chart | null = null;
let trendChart: Chart | null = null;
let statusChart: Chart | null = null;
let chargeLendersChart: Chart | null = null;

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

function renderKpis(leads: Lead[]): void {
  const { total, contacted, replyRate, conversionRate } = computeKpis(leads);
  document.querySelector("#kpi-total")!.textContent = String(total);
  document.querySelector("#kpi-contacted")!.textContent = String(contacted);
  document.querySelector("#kpi-reply-rate")!.textContent = `${Math.round(replyRate * 100)}%`;
  document.querySelector("#kpi-conversion-rate")!.textContent = `${Math.round(conversionRate * 100)}%`;
}

function renderCoverageStats(leads: Lead[]): void {
  const { phone, companyNumber, enriched } = computeCoverage(leads);
  document.querySelector("#cov-phone")!.textContent = `${Math.round(phone * 100)}%`;
  document.querySelector("#cov-company-number")!.textContent = `${Math.round(companyNumber * 100)}%`;
  document.querySelector("#cov-enriched")!.textContent = `${Math.round(enriched * 100)}%`;
}

function renderIndustryChart(leads: Lead[]): void {
  const counts = computeIndustryCounts(leads);
  const labels = Object.keys(counts).sort();
  const data = labels.map((l) => counts[l]);
  const canvas = document.querySelector<HTMLCanvasElement>("#industry-chart")!;
  industryChart?.destroy();
  industryChart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ label: "Leads", data, backgroundColor: "#4F6BFF" }] },
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
  const colors = ["#94a3b8", "#8B5CF6", "#f59e0b", "#10b981"];
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
          backgroundColor: "rgba(79, 107, 255, 0.7)",
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
        <section class="stats-grid">
          <div class="stat-card">
            <span class="stat-label">Total Leads</span>
            <span id="kpi-total" class="stat-value">0</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Contacted</span>
            <span id="kpi-contacted" class="stat-value">0</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Reply Rate</span>
            <span id="kpi-reply-rate" class="stat-value">0%</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Conversion Rate</span>
            <span id="kpi-conversion-rate" class="stat-value">0%</span>
          </div>
        </section>

        <section class="stats-grid">
          <div class="stat-card">
            <span class="stat-label">Has Phone</span>
            <span id="cov-phone" class="stat-value">0%</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">Has CH Number</span>
            <span id="cov-company-number" class="stat-value">0%</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">CH Enriched</span>
            <span id="cov-enriched" class="stat-value">0%</span>
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
  renderAnalytics();
}
