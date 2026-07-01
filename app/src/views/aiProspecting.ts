import {
  type ProspectingCriteria,
  type ProspectingRun,
  getProspectingRun,
  getProspectingStatus,
  listProspectingRuns,
  startProspectingRun,
} from "../api";
import { escapeHtml } from "../utils";

// UK SIC code quick-picks most relevant to corporate finance brokerage
const SIC_PRESETS: { label: string; codes: string[] }[] = [
  { label: "Construction", codes: ["41100", "41201", "41202", "42110", "43290", "43999"] },
  { label: "Manufacturing", codes: ["25110", "25120", "25990", "28110", "28290"] },
  { label: "Transport & Logistics", codes: ["49100", "49200", "49310", "49390", "52100"] },
  { label: "Property / Real Estate", codes: ["68100", "68201", "68209", "68310"] },
  { label: "Professional Services", codes: ["69109", "70100", "71111", "71112", "71200"] },
];

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function formatRunTime(run: ProspectingRun): string {
  const started = new Date(run.started_at);
  if (run.completed_at) {
    const completed = new Date(run.completed_at);
    const secs = Math.round((completed.getTime() - started.getTime()) / 1000);
    return `${secs}s`;
  }
  return "running…";
}

function fillFormFromCriteria(container: HTMLDivElement, criteria: ProspectingCriteria): void {
  const nameEl = container.querySelector<HTMLInputElement>("#run-name-input");
  const sicEl = container.querySelector<HTMLInputElement>("#sic-input");
  const locationEl = container.querySelector<HTMLInputElement>("#location-input");
  const incFromEl = container.querySelector<HTMLInputElement>("#inc-from-input");
  const incToEl = container.querySelector<HTMLInputElement>("#inc-to-input");
  const maxResultsEl = container.querySelector<HTMLInputElement>("#max-results-input");
  const minScoreEl = container.querySelector<HTMLInputElement>("#min-score-input");
  const aiToggleEl = container.querySelector<HTMLInputElement>("#ai-enrichment-toggle");

  if (nameEl) nameEl.value = criteria.name || "";
  if (sicEl) sicEl.value = (criteria.sic_codes || []).join(",");
  if (locationEl) locationEl.value = criteria.location || "";
  if (incFromEl) incFromEl.value = criteria.incorporated_from || "";
  if (incToEl) incToEl.value = criteria.incorporated_to || "";
  if (maxResultsEl) maxResultsEl.value = String(criteria.max_results || 50);
  if (minScoreEl) minScoreEl.value = String(criteria.min_ch_score || 0);
  if (aiToggleEl) aiToggleEl.checked = criteria.run_ai_enrichment || false;

  container.querySelector("#run-name-input")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function initAiProspecting(): void {
  const container = document.querySelector<HTMLDivElement>("#view-ai-prospecting")!;

  async function render(): Promise<void> {
    let configured = false;
    let runs: ProspectingRun[] = [];
    try {
      const [status, runList] = await Promise.all([getProspectingStatus(), listProspectingRuns()]);
      configured = status.configured;
      runs = runList;
    } catch {
      // backend offline — show graceful state
    }

    container.innerHTML = `
      <main class="container">
        <section class="card-title-row">
          <span class="card-icon-badge" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6M8 11h6"/></svg>
          </span>
          <h2 class="card-title">AI Prospecting</h2>
        </section>
        <p class="card-subtitle">Automatically discover new UK businesses from Companies House, enrich their profile, and score them — so your BDEs call better-qualified leads, not cold names from a spreadsheet.</p>

        ${
          !configured
            ? `<section class="card">
                <div class="card-title-row">
                  <h3 class="card-title">⚙ Setup required</h3>
                </div>
                <p style="margin:var(--space-2) 0 var(--space-3)">Add your free Companies House API key to start. It takes about 2 minutes:</p>
                <ol style="font-size:var(--text-sm);line-height:2;padding-left:var(--space-5)">
                  <li>Register at <strong>developer.company-information.service.gov.uk</strong> (free, government site)</li>
                  <li>Create an application and copy your API key</li>
                  <li>Add <code>COMPANIES_HOUSE_API_KEY=your_key_here</code> to the backend's <code>.env</code> file on your server</li>
                  <li>Restart the backend: <code>systemctl restart phone-lookup-backend</code></li>
                </ol>
              </section>`
            : `<section class="card prospecting-run-panel">
                <h3 class="action-section-title">Run AI Prospecting</h3>
                <p class="card-subtitle">Give this run a name, set your criteria, then click Run. Discovered leads are added to Cold Call Lists under that name so you can find them instantly.</p>

                <div class="prospecting-form">
                  <div class="prospecting-field">
                    <label class="stat-label">Run name <span style="color:var(--danger)">*</span></label>
                    <input type="text" id="run-name-input" class="search-input" placeholder="e.g. Manchester Construction Q3 2026" style="width:100%;max-width:480px" />
                  </div>

                  <div class="prospecting-field">
                    <label class="stat-label">Sector / SIC codes</label>
                    <div class="prospecting-sic-presets">
                      ${SIC_PRESETS.map(
                        (p) =>
                          `<button type="button" class="btn btn-ghost btn-sm sic-preset-btn" data-codes="${escapeHtml(p.codes.join(","))}">${escapeHtml(p.label)}</button>`
                      ).join("")}
                      <button type="button" class="btn btn-ghost btn-sm" id="clear-sic-btn">Clear</button>
                    </div>
                    <input type="text" id="sic-input" class="search-input" placeholder="e.g. 41100,42110 (or click a preset above)" style="width:100%;max-width:480px;margin-top:var(--space-2)" />
                  </div>

                  <div class="prospecting-fields-row">
                    <div class="prospecting-field">
                      <label class="stat-label">County / Region</label>
                      <input type="text" id="location-input" class="search-input" placeholder="e.g. Greater Manchester" />
                    </div>
                    <div class="prospecting-field">
                      <label class="stat-label">Incorporated from</label>
                      <input type="date" id="inc-from-input" class="search-input" />
                    </div>
                    <div class="prospecting-field">
                      <label class="stat-label">Incorporated to</label>
                      <input type="date" id="inc-to-input" class="search-input" />
                    </div>
                    <div class="prospecting-field">
                      <label class="stat-label">Max results</label>
                      <input type="number" id="max-results-input" class="search-input" value="50" min="1" max="100" style="width:100px" />
                    </div>
                  </div>

                  <div class="prospecting-fields-row">
                    <div class="prospecting-field">
                      <label class="stat-label">Min free CH score (0 = include all)</label>
                      <input type="number" id="min-score-input" class="search-input" value="0" min="0" max="100" style="width:100px" />
                      <span class="empty-hint" style="display:block;margin-top:4px">Score is based on new charges, sector, company age — no AI cost.</span>
                    </div>
                    <div class="prospecting-field" style="align-self:flex-end">
                      <label class="checkbox-row">
                        <input type="checkbox" id="ai-enrichment-toggle" />
                        Run full AI Sales Intelligence on new leads
                        <span class="empty-hint" style="margin-left:6px">(uses Anthropic credits per lead)</span>
                      </label>
                    </div>
                  </div>

                  <div class="card-actions" style="margin-top:var(--space-4)">
                    <button type="button" id="run-prospecting-btn" class="btn btn-primary">
                      Run AI Prospecting
                    </button>
                    <span id="run-status-msg" class="status-message"></span>
                  </div>
                </div>
              </section>`
        }

        <section class="card">
          <h3 class="action-section-title">Recent runs</h3>
          ${
            runs.length === 0
              ? `<p class="empty-hint">No runs yet — fill in the criteria above and click Run.</p>`
              : `<div class="action-section-body">
                  ${runs
                    .map(
                      (run) => {
                        const parsedCriteria = (() => { try { return JSON.parse(run.criteria); } catch { return null; } })();
                        return `
                  <div class="action-row prospecting-run-row" data-run-id="${escapeHtml(run.id)}">
                    <span class="status-badge ${run.status === "complete" ? "verified" : run.status === "error" ? "not_found" : "unverified"}">${escapeHtml(run.status)}</span>
                    <span class="action-row-title">${run.name ? `<strong>${escapeHtml(run.name)}</strong> · ` : ""}Found <strong>${run.found}</strong> · Added <strong>${run.created}</strong> · Skipped <strong>${run.skipped}</strong></span>
                    <span class="empty-hint">${formatRunTime(run)}</span>
                    ${run.error ? `<span class="empty-hint" style="color:var(--danger);max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(run.error)}">${escapeHtml(run.error)}</span>` : ""}
                    ${parsedCriteria ? `<button type="button" class="btn btn-ghost btn-sm rerun-btn" data-criteria="${escapeHtml(JSON.stringify(parsedCriteria))}">Re-run</button>` : ""}
                  </div>`;
                      }
                    )
                    .join("")}
                </div>`
          }
        </section>
      </main>
    `;

    if (!configured) return;

    // SIC preset buttons
    container.querySelectorAll<HTMLButtonElement>(".sic-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = container.querySelector<HTMLInputElement>("#sic-input")!;
        const existing = input.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const newCodes = (btn.dataset.codes ?? "").split(",").filter(Boolean);
        const merged = Array.from(new Set([...existing, ...newCodes]));
        input.value = merged.join(",");
      });
    });

    container.querySelector("#clear-sic-btn")?.addEventListener("click", () => {
      const input = container.querySelector<HTMLInputElement>("#sic-input")!;
      input.value = "";
    });

    // Re-run buttons on past runs
    container.querySelectorAll<HTMLButtonElement>(".rerun-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        try {
          const criteria: ProspectingCriteria = JSON.parse(btn.dataset.criteria ?? "{}");
          fillFormFromCriteria(container, criteria);
        } catch { /* ignore */ }
      });
    });

    container.querySelector<HTMLButtonElement>("#run-prospecting-btn")?.addEventListener("click", async () => {
      const btn = container.querySelector<HTMLButtonElement>("#run-prospecting-btn")!;
      const statusMsg = container.querySelector<HTMLSpanElement>("#run-status-msg")!;

      const name = container.querySelector<HTMLInputElement>("#run-name-input")?.value.trim() ?? "";
      if (!name) {
        statusMsg.textContent = "Please enter a name for this run.";
        statusMsg.style.color = "var(--danger)";
        container.querySelector<HTMLInputElement>("#run-name-input")?.focus();
        return;
      }
      statusMsg.style.color = "";

      const sicRaw = (container.querySelector<HTMLInputElement>("#sic-input")?.value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const criteria: ProspectingCriteria = {
        name,
        sic_codes: sicRaw,
        location: container.querySelector<HTMLInputElement>("#location-input")?.value.trim() ?? "",
        company_type: "ltd",
        incorporated_from: container.querySelector<HTMLInputElement>("#inc-from-input")?.value ?? "",
        incorporated_to: container.querySelector<HTMLInputElement>("#inc-to-input")?.value ?? "",
        max_results: Number(container.querySelector<HTMLInputElement>("#max-results-input")?.value ?? 50),
        min_ch_score: Number(container.querySelector<HTMLInputElement>("#min-score-input")?.value ?? 0),
        run_ai_enrichment: container.querySelector<HTMLInputElement>("#ai-enrichment-toggle")?.checked ?? false,
      };

      btn.disabled = true;
      statusMsg.textContent = "Starting…";

      try {
        const { run_id } = await startProspectingRun(criteria);
        statusMsg.textContent = "Running — checking Companies House…";
        pollRun(run_id);
      } catch (err) {
        statusMsg.textContent = `Error: ${err}`;
        btn.disabled = false;
      }
    });
  }

  function pollRun(runId: string): void {
    if (pollTimer) clearTimeout(pollTimer);
    const statusMsg = container.querySelector<HTMLSpanElement>("#run-status-msg");
    const btn = container.querySelector<HTMLButtonElement>("#run-prospecting-btn");

    async function check() {
      try {
        const run = await getProspectingRun(runId);
        if (statusMsg) {
          statusMsg.textContent = `Running — found ${run.found} · added ${run.created} · skipped ${run.skipped}`;
        }
        if (run.status === "running") {
          pollTimer = setTimeout(check, 3000);
        } else {
          if (btn) btn.disabled = false;
          await render();
        }
      } catch {
        pollTimer = setTimeout(check, 5000);
      }
    }

    pollTimer = setTimeout(check, 2000);
  }

  void render();
}
