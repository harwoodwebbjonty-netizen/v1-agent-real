import { Chart, registerables } from "chart.js";
import type { Lead } from "../api";
import { setIndustryFilter } from "../components/industryFilter";
import { CONTACT_STATUS_ORDER } from "../constants";
import { setPendingDashboardContactStatusFilter } from "../dashboardFilterHandoff";
import { getLeads, subscribe } from "../state";
import { openTab } from "../tabs";

Chart.register(...registerables);

let industryChart: Chart | null = null;
let trendChart: Chart | null = null;

function computeKpis(leads: Lead[]) {
  const total = leads.length;
  const contacted = leads.filter((l) => l.contact_status !== CONTACT_STATUS_ORDER[0]).length;
  const replied = leads.filter((l) => l.contact_status === "Replied" || l.contact_status === "Converted").length;
  const converted = leads.filter((l) => l.contact_status === "Converted").length;
  const replyRate = contacted === 0 ? 0 : replied / contacted;
  const conversionRate = total === 0 ? 0 : converted / total;
  return { total, contacted, replyRate, conversionRate };
}

function computeIndustryCounts(leads: Lead[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const lead of leads) {
    const industry = lead.industry || "Uncategorized";
    counts[industry] = (counts[industry] || 0) + 1;
  }
  return counts;
}

/** Cumulative funnel using CONTACT_STATUS_ORDER rank: a lead counts toward every stage at or before its own. */
function computeFunnel(leads: Lead[]): number[] {
  return CONTACT_STATUS_ORDER.map(
    (_, rank) => leads.filter((l) => CONTACT_STATUS_ORDER.indexOf(l.contact_status) >= rank).length
  );
}

function weekKey(dateStr: string): string {
  const d = new Date(dateStr);
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - oneJan.getTime()) / 86400000 + oneJan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function computeWeeklyTrend(leads: Lead[]): { labels: string[]; counts: number[] } {
  const counts: Record<string, number> = {};
  for (const lead of leads) {
    const key = weekKey(lead.timestamp);
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

function renderIndustryChart(leads: Lead[]): void {
  const counts = computeIndustryCounts(leads);
  const labels = Object.keys(counts).sort();
  const data = labels.map((l) => counts[l]);
  const canvas = document.querySelector<HTMLCanvasElement>("#industry-chart")!;
  industryChart?.destroy();
  industryChart = new Chart(canvas, {
    type: "bar",
    data: { labels, datasets: [{ label: "Leads", data, backgroundColor: "#2563eb" }] },
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
        openTab("dashboard", "Dashboard");
      },
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
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
      openTab("dashboard", "Dashboard");
    });
  });
}

function renderTrendChart(leads: Lead[]): void {
  const { labels, counts } = computeWeeklyTrend(leads);
  const canvas = document.querySelector<HTMLCanvasElement>("#trend-chart")!;
  trendChart?.destroy();
  trendChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "New leads",
          data: counts,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.15)",
          fill: true,
          tension: 0.3,
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
  renderIndustryChart(leads);
  renderFunnel(leads);
  renderTrendChart(leads);
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

        <section class="card">
          <h2 class="card-title">Leads by Industry</h2>
          <div class="chart-wrap"><canvas id="industry-chart"></canvas></div>
        </section>

        <section class="card">
          <h2 class="card-title">Funnel</h2>
          <div id="funnel-container"></div>
        </section>

        <section class="card">
          <h2 class="card-title">Weekly New Leads</h2>
          <div class="chart-wrap"><canvas id="trend-chart"></canvas></div>
        </section>
      </div>
    </main>
  `;

  subscribe(renderAnalytics);
  renderAnalytics();
}
