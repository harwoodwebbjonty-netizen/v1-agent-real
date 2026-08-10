import {
  type CreditLimits,
  type WinBackCampaign,
  type WinBackCampaignDetail,
  type WinBackCsvRow,
  type WinBackEmail,
  type WinBackRerunDefaults,
  createWinBackCampaignFromCsv,
  exportWinBackMailchimp,
  getCreditUsage,
  getWinBackCampaign,
  getWinBackCampaignRows,
  getWinBackCampaigns,
  parseWinBackCsv,
  previewWinBackCampaignEmail,
  resumeWinBackCampaign,
  saveCreditLimits,
  sendAllWinBackEmails,
  sendWinBackEmail,
} from "../api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentUser, subscribeAuth } from "../auth";
import { escapeHtml } from "../utils";

// Haiku pricing (claude-haiku-4-5): $0.80/MTok input, $4/MTok output.
// The win-back system prompt (workflows/win_back_email_prompt.md) alone
// measures ~2,300 tokens and is sent as the `system` param on every call —
// it was not accounted for at all in the old 1,500-token estimate, which
// undercounted before a single word of lead context was added. Using
// system (2,300) + a realistic populated lead-context message (~800,
// covering CRM notes/offer/campaign link/AI research summary/CH data) for
// input, and the service's actual MAX_TOKENS cap (400, not an average) for
// output, so this is a safe ceiling rather than an optimistic average.
const WINBACK_SYSTEM_PROMPT_TOKENS = 2300;
const WINBACK_LEAD_CONTEXT_TOKENS = 800;
const WINBACK_OUTPUT_TOKENS_MAX = 400; // matches MAX_TOKENS in win_back_email_service.py
const WINBACK_COST_PER_EMAIL =
  (WINBACK_SYSTEM_PROMPT_TOKENS + WINBACK_LEAD_CONTEXT_TOKENS) * (0.80 / 1_000_000) +
  WINBACK_OUTPUT_TOKENS_MAX * (4 / 1_000_000);

// Research depth cost (Sales Intelligence, which runs before every win-back
// email). Real spend was measured at $2 for a single "standard" call.
// backend/app/services/sales_intelligence_service.py now enforces a real
// structural bound, not just a heuristic: web_fetch's max_content_tokens is
// set explicitly (previously unset — per Anthropic's docs, an unbounded
// fetch of a large page/PDF alone can be ~125,000 tokens, ~$0.375, in ONE
// tool call), RESEARCH_MAX_TOKENS is capped, and max_uses is clamped to
// RESEARCH_MAX_USES_CAP (3) for ALL depths regardless of what's requested —
// a genuine dollar guarantee doesn't fit "deep"'s larger tool budget, so
// quick/standard/deep now all get the same real research scope (previously
// "quick"'s). This is the real, honest tradeoff of a hard budget: 1-2
// research rounds, not thorough digging, for every depth setting.
const LINKEDIN_WORST_CASE_USD = 0.02 + 0.04; // scrape (Apify, ~10 posts) + discovery (AI fallback), both can apply
const RESEARCH_EXTRACTION_WORST_CASE_USD = 0.11; // matches sales_intelligence_service.py's computed worst case (~$0.11), with margin
const DEPTH_COST: Record<string, number> = {
  quick: RESEARCH_EXTRACTION_WORST_CASE_USD + LINKEDIN_WORST_CASE_USD,
  standard: RESEARCH_EXTRACTION_WORST_CASE_USD + LINKEDIN_WORST_CASE_USD,
  deep: RESEARCH_EXTRACTION_WORST_CASE_USD + LINKEDIN_WORST_CASE_USD,
};

function totalCostPerEmail(depth: string): number {
  return WINBACK_COST_PER_EMAIL + (DEPTH_COST[depth] ?? 0.10);
}

function formatCost(n: number): string {
  if (n < 0.01) return `${(n * 100).toFixed(2)}¢`;
  return `$${n.toFixed(2)}`;
}

// Apify bills per post actually returned (~£1.60/1,000 posts, matching
// APIFY_COST_PER_1K_POSTS_GBP in backend/app/services/linkedin_activity_service.py),
// not per lead — this is a ceiling, not a real average, only leads with a
// LinkedIn URL already on file or discoverable ever reach Apify. Kept in £
// here specifically because buildRunEstimates below checks it against the
// backend's £-denominated linkedin_scrape credit limit; the main $ headline
// total (DEPTH_COST above) already folds in its own separate USD estimate
// of this same worst case, so this £ figure is not added again anywhere.
const APIFY_MAX_POSTS_PER_LEAD = 10;
const APIFY_COST_PER_1K_POSTS_GBP = 1.60;
const APIFY_MAX_COST_PER_LEAD_GBP = (APIFY_MAX_POSTS_PER_LEAD / 1000) * APIFY_COST_PER_1K_POSTS_GBP;

// Matches backend/app/db.py CREDIT_COST — the £ figures actually enforced by
// db.check_credit_limit() per feature, as opposed to the $ Haiku estimate
// above (which is a separate, rougher pre-flight number). Used here so the
// per-feature "would this run hit the ceiling" check matches what the
// backend will really do partway through the batch.
const WIN_BACK_CREDIT_COST_GBP = 0.03;
const LINKEDIN_DISCOVERY_CREDIT_COST_GBP = 0.03;

interface RunEstimate {
  feature: keyof CreditLimits;
  label: string;
  note: string;
  estimate: number;
}

function buildRunEstimates(count: number): RunEstimate[] {
  return [
    { feature: "limit_win_back", label: "Win-back Emails", note: "generation, £0.03/email", estimate: count * WIN_BACK_CREDIT_COST_GBP },
    { feature: "limit_linkedin_scrape", label: "LinkedIn Activity", note: "Apify post fetch, ceiling", estimate: count * APIFY_MAX_COST_PER_LEAD_GBP },
    { feature: "limit_linkedin_discovery", label: "LinkedIn Discovery", note: "CH + AI search fallback, ceiling", estimate: count * LINKEDIN_DISCOVERY_CREDIT_COST_GBP },
  ];
}

async function showCostConfirm(count: number, totalCost: string): Promise<boolean> {
  const runEstimates = buildRunEstimates(count);

  let usage: { spend: Record<string, number>; limits: CreditLimits } | null = null;
  try {
    usage = await getCreditUsage();
  } catch {
    // Backend offline or usage not available — skip the per-feature limit
    // check below and fall back to the plain cost estimate only.
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "conflict-modal-overlay";

    const limitRowsHtml = usage
      ? runEstimates
          .map(({ feature, label, note, estimate }) => {
            const limit = usage!.limits[feature] || 0; // 0 = no limit
            const spent = usage!.spend[feature.replace("limit_", "")] || 0;
            const remaining = limit === 0 ? Infinity : limit - spent;
            const wouldExceed = estimate > remaining;
            if (!wouldExceed) return "";
            const suggested = Math.ceil(spent + estimate);
            return `
              <div class="conflict-modal-question cost-confirm-warn" data-feature="${feature}">
                <strong>${label}</strong> limit is £${limit.toFixed(2)} (£${spent.toFixed(2)} spent this month) —
                this run could need up to £${estimate.toFixed(2)} more <span class="cost-confirm-note">(${note})</span>.
                <div class="cost-confirm-adjust">
                  <input type="number" min="0" step="1" value="${suggested}" class="search-input cost-confirm-limit-input" style="width:90px" />
                  <button class="btn btn-secondary btn-sm cost-confirm-adjust-btn">Raise limit to this</button>
                  <span class="cost-confirm-adjust-status"></span>
                </div>
              </div>`;
          })
          .join("")
      : "";

    overlay.innerHTML = `
      <div class="conflict-modal">
        <div class="conflict-modal-title">Confirm email generation</div>
        <div class="conflict-modal-desc">
          You're about to generate <strong>${count} personalised email${count === 1 ? "" : "s"}</strong>
          using the Anthropic API.
        </div>
        <div class="conflict-modal-question">
          Estimated cost: <strong>${totalCost}</strong>
          <span class="cost-confirm-note">(all-in ceiling: web research, AI email generation, and LinkedIn lookup — usually less in practice)</span>
        </div>
        ${limitRowsHtml}
        <div class="conflict-modal-actions">
          <button class="btn btn-primary" id="cost-confirm-yes">Generate</button>
          <button class="btn btn-secondary" id="cost-confirm-no">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll<HTMLElement>(".cost-confirm-warn").forEach((row) => {
      const feature = row.dataset.feature as keyof CreditLimits;
      const input = row.querySelector<HTMLInputElement>(".cost-confirm-limit-input")!;
      const btn = row.querySelector<HTMLButtonElement>(".cost-confirm-adjust-btn")!;
      const status = row.querySelector<HTMLSpanElement>(".cost-confirm-adjust-status")!;
      btn.addEventListener("click", async () => {
        if (!usage) return;
        btn.disabled = true;
        status.textContent = "Saving…";
        try {
          const newLimits: CreditLimits = { ...usage.limits, [feature]: Number(input.value) || 0 };
          await saveCreditLimits(newLimits);
          usage.limits = newLimits;
          status.textContent = "Updated";
          row.style.opacity = "0.6";
          input.disabled = true;
          btn.remove();
        } catch (err) {
          status.textContent = `Failed: ${err}`;
          btn.disabled = false;
        }
      });
    });

    overlay.querySelector("#cost-confirm-yes")!.addEventListener("click", () => {
      overlay.remove();
      resolve(true);
    });
    overlay.querySelector("#cost-confirm-no")!.addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });
  });
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

function clearPoll(): void {
  if (pollInterval !== null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// --- Campaign list sub-view ---

function renderCampaignList(container: HTMLElement, campaigns: WinBackCampaign[]): void {
  clearPoll();
  container.innerHTML = `
    <main class="container">
      <header class="page-head">
        <div>
          <h1 class="page-title">Win-back</h1>
          <div class="page-meta"><span>AI-generated re-engagement emails for dormant or lost leads.</span></div>
        </div>
      </header>
      <section class="card">
        <div class="card-header-row">
          <div></div>
          <div class="card-header-actions">
            <button id="wb-new-btn" class="btn btn-primary">New campaign</button>
          </div>
        </div>
        ${
          campaigns.length === 0
            ? `<div class="empty-state"><p>No win-back campaigns yet.</p><p class="card-subtitle">Create one to start re-engaging lost leads.</p></div>`
            : `<table class="data-table">
                <thead><tr>
                  <th>Campaign</th><th>Leads</th><th>Generated</th><th>Status</th><th>Created</th><th></th>
                </tr></thead>
                <tbody>
                  ${campaigns
                    .map(
                      (c) => `
                    <tr>
                      <td>${escapeHtml(c.name)}</td>
                      <td>${c.total}</td>
                      <td>${c.generated}</td>
                      <td><span class="status-badge ${c.status === "ready" ? "status-verified" : c.status === "error" ? "status-not-found" : ""}">${escapeHtml(c.status)}</span></td>
                      <td>${new Date(c.created_at).toLocaleDateString()}</td>
                      <td><button class="btn btn-ghost btn-sm wb-view-btn" data-id="${escapeHtml(c.id)}">View</button></td>
                    </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
        }
      </section>
    </main>`;

  container.querySelector<HTMLButtonElement>("#wb-new-btn")!.addEventListener("click", () => {
    showLeadPicker(container);
  });

  container.querySelectorAll<HTMLButtonElement>(".wb-view-btn").forEach((btn) => {
    btn.addEventListener("click", () => showCampaignDetail(container, btn.dataset.id!));
  });
}

// --- Lead picker sub-view (source selection) ---

function showLeadPicker(container: HTMLElement): void {
  container.innerHTML = `
    <main class="container">
      <section class="card">
        <div class="card-header-row">
          <div>
            <h2 class="card-title">New Win-back Campaign</h2>
            <p class="card-subtitle">Import leads from a CSV file or your CRM to generate personalised re-engagement emails.</p>
          </div>
          <div class="card-header-actions">
            <button id="wb-back-btn" class="btn btn-ghost">Back</button>
          </div>
        </div>
        <div class="wb-source-grid">
          <button id="wb-csv-btn" class="wb-source-card">
            <svg width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            <strong>Upload CSV</strong>
            <span>Import a spreadsheet of leads with names, emails and company info</span>
          </button>
          <button id="wb-zoho-btn" class="wb-source-card wb-source-card--disabled">
            <svg width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
            </svg>
            <strong>Import from Zoho</strong>
            <span>Coming soon — connect your Zoho CRM to pull lost or dormant leads directly</span>
          </button>
        </div>
        <p id="wb-source-msg" class="status-message" style="margin-top:8px"></p>
      </section>
    </main>`;

  container.querySelector<HTMLButtonElement>("#wb-back-btn")!.addEventListener("click", async () => {
    await loadCampaignList(container);
  });

  container.querySelector<HTMLButtonElement>("#wb-zoho-btn")!.addEventListener("click", () => {
    const msg = container.querySelector<HTMLParagraphElement>("#wb-source-msg")!;
    msg.textContent = "Zoho integration coming soon. Use CSV upload for now.";
  });

  container.querySelector<HTMLButtonElement>("#wb-csv-btn")!.addEventListener("click", async () => {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "CSV files", extensions: ["csv"] }],
    });
    if (!path || typeof path !== "string") return;
    await showCsvPreview(container, path);
  });
}

// --- CSV preview sub-view ---

// A deal is "open" (still in the pipeline) when it has a stage that isn't a
// Closed (Won/Lost) stage. Open deals are live opportunities and must never be
// win-backed, so they're removed from the list entirely. A blank stage counts
// as unknown (kept), so a CSV without a Stage column isn't wiped out.
function isOpenStage(stage?: string): boolean {
  const s = (stage || "").trim().toLowerCase();
  return s !== "" && !s.includes("closed");
}

async function showCsvPreview(container: HTMLElement, csvPath: string): Promise<void> {
  let allRows: WinBackCsvRow[] = [];
  try {
    allRows = await parseWinBackCsv(csvPath);
  } catch (err) {
    container.innerHTML = `<main class="container"><p class="status-error">Could not parse CSV: ${escapeHtml(String(err))}</p><button id="wb-back2-btn" class="btn btn-ghost" style="margin-top:12px">Back</button></main>`;
    container.querySelector<HTMLButtonElement>("#wb-back2-btn")!.addEventListener("click", () => showLeadPicker(container));
    return;
  }
  presentLeadReview(container, allRows, { onBack: () => showLeadPicker(container) });
}

// Shared review screen for both a fresh CSV upload and a campaign "Run again".
// `allRows` is the full source list; open-deal and no-email rows are dropped for
// display, but the full list is carried forward as the new campaign's source
// rows so it can be re-run again later.
function presentLeadReview(
  container: HTMLElement,
  allRows: WinBackCsvRow[],
  opts?: { defaults?: WinBackRerunDefaults; onBack?: () => void },
): void {
  const onBack = opts?.onBack ?? (() => showLeadPicker(container));
  const total = allRows.length;
  // Open (in-progress) deals are live opportunities, not lost/dormant leads —
  // never win-back them, so drop them from the review entirely.
  const notOpen = allRows.filter((r) => !isOpenStage(r.stage));
  const droppedOpen = total - notOpen.length;
  // Email campaigns can only reach leads with an email — drop the rest up front
  // so they don't cost generation money for an unsendable draft.
  const rows = notOpen.filter((r) => (r.email || "").trim().length > 0);
  const droppedNoEmail = notOpen.length - rows.length;

  if (rows.length === 0) {
    const reason = droppedOpen > 0
      ? `No sendable leads left — ${droppedOpen} open (in-progress) deal${droppedOpen !== 1 ? "s" : ""} excluded and ${droppedNoEmail} with no email address. A win-back targets lost or dormant leads that have an email.`
      : "No rows with an email address found — a win-back campaign needs emails to send to.";
    container.innerHTML = `<main class="container"><p class="status-error">${escapeHtml(reason)}</p><button id="wb-back2-btn" class="btn btn-ghost" style="margin-top:12px">Back</button></main>`;
    container.querySelector<HTMLButtonElement>("#wb-back2-btn")!.addEventListener("click", onBack);
    return;
  }

  // Distinct values for the filter dropdowns, from the data actually present.
  const stages = Array.from(new Set(rows.map((r) => (r.stage || "").trim()).filter(Boolean))).sort();
  const owners = Array.from(new Set(rows.map((r) => (r.deal_owner || "").trim()).filter(Boolean))).sort();

  // Selection state: every imported (emailable) row starts ticked. Generation
  // runs on the rows that are BOTH ticked AND matching the current filter, so
  // the filter genuinely narrows who gets emailed. Ticks persist across filter
  // changes (untick within a filter to trim that subset further).
  const selected = new Set<number>(rows.map((_, i) => i));

  container.innerHTML = `
    <main class="container">
      <section class="card">
        <div class="card-header-row">
          <div>
            <h2 class="card-title">Review imported leads</h2>
            <p class="card-subtitle">${rows.length} lead${rows.length !== 1 ? "s" : ""} with an email address${droppedNoEmail > 0 ? ` · ${droppedNoEmail} without an email skipped` : ""}${droppedOpen > 0 ? ` · ${droppedOpen} open deal${droppedOpen !== 1 ? "s" : ""} excluded` : ""}. Filter and tick who to email.</p>
          </div>
          <div class="card-header-actions">
            <button id="wb-back-btn" class="btn btn-ghost">Back</button>
          </div>
        </div>

        <div class="wb-filter-bar" style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;margin-bottom:14px">
          <div>
            <label class="form-label">Deal age (months)</label>
            <div style="display:flex;gap:6px;align-items:center">
              <input id="wb-f-agemin" class="search-input" type="number" min="0" placeholder="min" style="width:76px" />
              <span>–</span>
              <input id="wb-f-agemax" class="search-input" type="number" min="0" placeholder="max" style="width:76px" />
            </div>
          </div>
          <div>
            <label class="form-label">Stage</label>
            <select id="wb-f-stage" class="search-input" style="min-width:150px">
              <option value="">Any stage</option>
              ${stages.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="form-label">Deal owner</label>
            <select id="wb-f-owner" class="search-input" style="min-width:150px">
              <option value="">Any owner</option>
              ${owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="form-label">Amount (£)</label>
            <div style="display:flex;gap:6px;align-items:center">
              <input id="wb-f-amtmin" class="search-input" type="number" min="0" placeholder="min" style="width:96px" />
              <span>–</span>
              <input id="wb-f-amtmax" class="search-input" type="number" min="0" placeholder="max" style="width:96px" />
            </div>
          </div>
        </div>

        <div class="wb-picker-bar">
          <button id="wb-configure-btn" class="btn btn-primary">Configure generation</button>
          <span class="status-message"><span id="wb-sel-count"></span> · <span id="wb-vis-count"></span> shown of ${rows.length}. Set the brief and preview a draft next.</span>
        </div>

        <table class="data-table">
          <thead><tr>
            <th style="width:34px"><input type="checkbox" id="wb-select-all" title="Select/clear all shown" /></th>
            <th>Company</th><th>Contact</th><th>Email</th>
            <th>Closing date</th><th>Stage</th><th>Amount</th><th>Deal owner</th>
            <th>Website</th><th>LinkedIn</th>
          </tr></thead>
          <tbody id="wb-preview-tbody"></tbody>
        </table>
      </section>
    </main>`;

  const ageMinEl = container.querySelector<HTMLInputElement>("#wb-f-agemin")!;
  const ageMaxEl = container.querySelector<HTMLInputElement>("#wb-f-agemax")!;
  const stageSel = container.querySelector<HTMLSelectElement>("#wb-f-stage")!;
  const ownerSel = container.querySelector<HTMLSelectElement>("#wb-f-owner")!;
  const amtMinEl = container.querySelector<HTMLInputElement>("#wb-f-amtmin")!;
  const amtMaxEl = container.querySelector<HTMLInputElement>("#wb-f-amtmax")!;
  const tbody = container.querySelector<HTMLTableSectionElement>("#wb-preview-tbody")!;
  const selectAll = container.querySelector<HTMLInputElement>("#wb-select-all")!;
  const selCountEl = container.querySelector<HTMLSpanElement>("#wb-sel-count")!;
  const visCountEl = container.querySelector<HTMLSpanElement>("#wb-vis-count")!;
  const configureBtn = container.querySelector<HTMLButtonElement>("#wb-configure-btn")!;

  // Parses both YYYY-MM-DD (our filterable CSV) and DD/MM/YYYY (raw Zoho export).
  const parseDate = (s: string): Date | null => {
    s = (s || "").trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    let y: number, mo: number, da: number;
    if (m) {
      y = +m[1]; mo = +m[2]; da = +m[3];
    } else {
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (!m) return null;
      da = +m[1]; mo = +m[2]; y = +m[3];
    }
    const d = new Date(y, mo - 1, da);
    return isNaN(d.getTime()) ? null : d;
  };
  const monthsAgo = (s: string): number | null => {
    const d = parseDate(s);
    if (!d) return null;
    const now = new Date();
    return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  };
  const parseAmount = (s: string): number => parseFloat((s || "").replace(/[^0-9.]/g, ""));
  const numOrNull = (el: HTMLInputElement): number | null => (el.value.trim() === "" ? null : Number(el.value));

  const rowMatches = (r: WinBackCsvRow): boolean => {
    const amin = numOrNull(ageMinEl), amax = numOrNull(ageMaxEl);
    if (amin !== null || amax !== null) {
      const m = monthsAgo(r.closing_date || "");
      if (m === null) return false;
      if (amin !== null && m < amin) return false;
      if (amax !== null && m > amax) return false;
    }
    if (stageSel.value && (r.stage || "").trim() !== stageSel.value) return false;
    if (ownerSel.value && (r.deal_owner || "").trim() !== ownerSel.value) return false;
    const lo = numOrNull(amtMinEl), hi = numOrNull(amtMaxEl);
    if (lo !== null || hi !== null) {
      const amt = parseAmount(r.amount || "");
      if (isNaN(amt)) return false;
      if (lo !== null && amt < lo) return false;
      if (hi !== null && amt > hi) return false;
    }
    return true;
  };

  const visibleIndices = (): number[] => rows.map((_, i) => i).filter((i) => rowMatches(rows[i]));

  const updateCounts = (vis: number[]) => {
    // Only rows that are ticked AND currently visible (matching the filter) get
    // emailed, so every count/label reflects that intersection, not all ticks.
    const selVis = vis.filter((i) => selected.has(i)).length;
    selCountEl.textContent = `${selVis} selected`;
    visCountEl.textContent = `${vis.length}`;
    selectAll.checked = vis.length > 0 && selVis === vis.length;
    selectAll.indeterminate = selVis > 0 && selVis < vis.length;
    configureBtn.disabled = selVis === 0;
    configureBtn.textContent = `Configure generation (${selVis})`;
  };

  const renderBody = () => {
    const vis = visibleIndices();
    tbody.innerHTML = vis
      .map((i) => {
        const r = rows[i];
        const m = monthsAgo(r.closing_date || "");
        const ageCell = !r.closing_date
          ? "—"
          : m === null
            ? escapeHtml(r.closing_date)
            : `${escapeHtml(r.closing_date)} · ${m < 0 ? "future" : `${m} mo`}`;
        return `
          <tr>
            <td><input type="checkbox" class="wb-row-check" data-i="${i}" ${selected.has(i) ? "checked" : ""} /></td>
            <td>${escapeHtml(r.company)}</td>
            <td>${escapeHtml(r.contact_name || "—")}</td>
            <td>${escapeHtml(r.email || "—")}</td>
            <td>${ageCell}</td>
            <td>${escapeHtml(r.stage || "—")}</td>
            <td>${escapeHtml(r.amount || "—")}</td>
            <td>${escapeHtml(r.deal_owner || "—")}</td>
            <td class="wb-subject-cell">${escapeHtml(r.website || "—")}</td>
            <td class="wb-subject-cell">${escapeHtml(r.linkedin || "—")}</td>
          </tr>`;
      })
      .join("");
    tbody.querySelectorAll<HTMLInputElement>(".wb-row-check").forEach((cb) => {
      cb.addEventListener("change", () => {
        const i = Number(cb.dataset.i);
        if (cb.checked) selected.add(i);
        else selected.delete(i);
        updateCounts(visibleIndices());
      });
    });
    updateCounts(vis);
  };

  [ageMinEl, ageMaxEl, amtMinEl, amtMaxEl].forEach((el) => el.addEventListener("input", renderBody));
  [stageSel, ownerSel].forEach((el) => el.addEventListener("change", renderBody));

  selectAll.addEventListener("change", () => {
    const vis = visibleIndices();
    if (selectAll.checked) vis.forEach((i) => selected.add(i));
    else vis.forEach((i) => selected.delete(i));
    renderBody();
  });

  container.querySelector<HTMLButtonElement>("#wb-back-btn")!.addEventListener("click", onBack);

  configureBtn.addEventListener("click", () => {
    // Only rows that are ticked AND match the current filter are generated; the
    // FULL list is stored as the new campaign's source rows so it can be re-run
    // again later.
    const vis = new Set(visibleIndices());
    const chosen = rows.filter((_, i) => selected.has(i) && vis.has(i));
    if (chosen.length === 0) return;
    showGenerationConfig(container, chosen, {
      defaults: opts?.defaults,
      sourceRows: allRows,
    });
  });

  renderBody();
}

// --- Campaign configuration sub-view ---

function showGenerationConfig(
  container: HTMLElement,
  rows: WinBackCsvRow[],
  opts?: { defaults?: WinBackRerunDefaults; sourceRows?: WinBackCsvRow[] },
): void {
  const defaultRelationshipContext = "These are past Winchester Corporate Finance contacts being re-engaged about funding. Only treat someone as an existing customer where their record shows a completed (Closed Won) deal — otherwise write as re-opening an earlier funding conversation. Never imply WCF has funded a company unless its data confirms it.";
  // On a re-run, pre-fill from the original campaign's settings; otherwise fresh defaults.
  const d = opts?.defaults;
  const nameValue = d ? `${d.name} (re-run)` : "";
  const briefValue = d ? d.additional_context : `${defaultRelationshipContext}\n\nReconnect warmly and invite a short review of current funding needs.`;
  const offerValue = d ? d.offer_context : "";
  const linksValue = d ? d.campaign_links : "";
  const linkTextValue = d ? d.campaign_link_text : "";
  const depthValue = d?.depth || "standard";
  container.innerHTML = `
    <main class="container">
      <section class="card">
        <div class="card-header-row">
          <div>
            <h2 class="card-title">Configure generation</h2>
            <p class="card-subtitle">These settings apply only to this campaign. They do not change the imported lead or CRM data.</p>
          </div>
          <div class="card-header-actions"><button id="wb-back-review-btn" class="btn btn-ghost">Back</button></div>
        </div>
        <div class="wb-generation-form">
          <label class="form-label" for="wb-name-input">Campaign name</label>
          <input id="wb-name-input" class="search-input" type="text" placeholder="e.g. Q3 customer re-engagement" value="${escapeHtml(nameValue)}" />

          <label class="form-label" for="wb-additional-context-input">Campaign brief</label>
          <textarea id="wb-additional-context-input" class="search-input wb-brief-textarea" rows="4">${escapeHtml(briefValue)}</textarea>

          <label class="form-label" for="wb-offer-context-input">Current offers or deals</label>
          <textarea id="wb-offer-context-input" class="search-input wb-brief-textarea" rows="3" placeholder="e.g. Unsecured business lending from 6.9% (subject to status and underwriting).">${escapeHtml(offerValue)}</textarea>
          <p class="card-subtitle">Only enter approved, current terms. The email will mention them only where relevant.</p>

          <label class="form-label" for="wb-campaign-links-input">Campaign links</label>
          <textarea id="wb-campaign-links-input" class="search-input wb-brief-textarea" rows="2" placeholder="Paste a Calendly booking link or a reapplication link.">${escapeHtml(linksValue)}</textarea>
          <label class="form-label" for="wb-campaign-link-text-input">Link display text (optional)</label>
          <input id="wb-campaign-link-text-input" class="search-input" type="text" placeholder="Book a call here — leave blank to send the link as plain text" value="${escapeHtml(linkTextValue)}" />
          <p class="card-subtitle">If filled in, the link above appears as clickable text with this label instead of a plain web address.</p>

          <label class="form-label" for="wb-depth-select">Research depth</label>
          <select id="wb-depth-select" class="search-input" title="All depths currently use the same research scope (up to 3 searches + 3 fetches) to guarantee a $0.20/lead hard cap">
            <option value="quick">Quick scan — up to 3 searches + 3 fetches, capped at $0.20/lead</option>
            <option value="standard" selected>Standard — up to 3 searches + 3 fetches, capped at $0.20/lead</option>
            <option value="deep">Deep research — up to 3 searches + 3 fetches, capped at $0.20/lead</option>
          </select>
          <p class="card-subtitle">All three currently research the same amount — capped uniformly so the total cost stays guaranteed at $0.20/lead.</p>

          <div class="wb-picker-bar">
            <select id="wb-preview-lead-select" class="search-input" title="Choose the imported lead used for the preview">
              ${rows.map((row, index) => `<option value="${index}">${escapeHtml(row.company)}${row.contact_name ? ` — ${escapeHtml(row.contact_name)}` : ""}</option>`).join("")}
            </select>
            <button id="wb-preview-btn" class="btn btn-secondary">Preview one email</button>
            <button id="wb-generate-btn" class="btn btn-primary">Generate Campaign (${rows.length} emails · up to ${formatCost(rows.length * totalCostPerEmail("standard"))} all-in)</button>
          </div>
          <p class="card-subtitle">Preview runs the same enrichment and email generation as one campaign lead, but does not save or send a campaign. It uses one lead's Win-back credit.</p>
          <div id="wb-preview-result" class="wb-preview-result hidden"></div>
        </div>
      </section>
    </main>`;

  // Back returns to the review screen (rebuilt from the full source list) so
  // filter/selection can be adjusted without losing the imported leads.
  container.querySelector<HTMLButtonElement>("#wb-back-review-btn")!.addEventListener("click", () =>
    presentLeadReview(container, opts?.sourceRows ?? rows, { defaults: opts?.defaults }),
  );

  const depthSelect = container.querySelector<HTMLSelectElement>("#wb-depth-select")!;
  depthSelect.value = depthValue;
  const generateBtn = container.querySelector<HTMLButtonElement>("#wb-generate-btn")!;
  const getBrief = async () => ({
    name: container.querySelector<HTMLInputElement>("#wb-name-input")!.value.trim() || `Win-back ${new Date().toLocaleDateString()}`,
    emailInstruction: "",
    offerContext: container.querySelector<HTMLTextAreaElement>("#wb-offer-context-input")!.value.trim(),
    additionalContext: container.querySelector<HTMLTextAreaElement>("#wb-additional-context-input")!.value.trim(),
    campaignLinks: container.querySelector<HTMLTextAreaElement>("#wb-campaign-links-input")!.value.trim(),
    campaignLinkText: container.querySelector<HTMLInputElement>("#wb-campaign-link-text-input")!.value.trim(),
    // The backend signs each Win-back email using that row's Deal Owner.
    signature: "",
  });

  // Caches a successful preview's exact output alongside a signature of the
  // settings it was generated under (brief + depth). Generate Campaign only
  // reuses a cached result for a row if the signature still matches at the
  // moment of generating — so changing the brief/offer/links/depth after
  // previewing correctly invalidates it instead of silently sending stale,
  // already-paid-for copy under different settings.
  const previewedEmails = new Map<number, { subject: string; body: string; signature: string }>();
  const briefSignature = (brief: Awaited<ReturnType<typeof getBrief>>, depth: string) =>
    JSON.stringify([brief.offerContext, brief.additionalContext, brief.campaignLinks, brief.campaignLinkText, brief.signature, depth]);
  const updateBtnLabel = () => {
    generateBtn.textContent = `Generate Campaign (${rows.length} emails · up to ${formatCost(rows.length * totalCostPerEmail(depthSelect.value))} all-in)`;
  };
  depthSelect.addEventListener("change", updateBtnLabel);

  // Preview intentionally skips the persisted lead cache (so it can never
  // affect what a real campaign generation later sees), which means every
  // click re-runs a fully-charged Apify + AI request. A slow or failed
  // attempt is easy to mistake for "it didn't work" and retry — but the
  // server-side request may still be running and may already have spent
  // real money. This cooldown blocks same-lead retries for a short window
  // after a failure so an impatient retry can't double-charge.
  const PREVIEW_RETRY_COOLDOWN_MS = 90_000;
  const previewCooldownUntil = new Map<number, number>();
  const leadSelect = container.querySelector<HTMLSelectElement>("#wb-preview-lead-select")!;
  const previewBtn = container.querySelector<HTMLButtonElement>("#wb-preview-btn")!;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;

  const refreshPreviewButtonState = () => {
    clearTimeout(cooldownTimer);
    const index = Number(leadSelect.value);
    const until = previewCooldownUntil.get(index);
    const remainingSec = until ? Math.ceil((until - Date.now()) / 1000) : 0;
    if (remainingSec > 0) {
      previewBtn.disabled = true;
      previewBtn.textContent = `Retry in ${remainingSec}s...`;
      cooldownTimer = setTimeout(refreshPreviewButtonState, 1000);
    } else {
      previewCooldownUntil.delete(index);
      previewBtn.disabled = false;
      previewBtn.textContent = "Preview one email";
    }
  };
  leadSelect.addEventListener("change", refreshPreviewButtonState);

  previewBtn.addEventListener("click", async () => {
    const result = container.querySelector<HTMLDivElement>("#wb-preview-result")!;
    const index = Number(leadSelect.value);

    const until = previewCooldownUntil.get(index);
    if (until && Date.now() < until) {
      result.textContent = `Please wait ${Math.ceil((until - Date.now()) / 1000)}s before retrying this lead — the previous attempt may still be processing on the server and could already have used real Apify/AI credits. Retrying now risks paying twice for the same preview.`;
      result.classList.remove("hidden");
      return;
    }

    const brief = await getBrief();
    previewBtn.disabled = true;
    previewBtn.textContent = "Creating preview...";
    try {
      const email = await previewWinBackCampaignEmail(rows[index], brief.emailInstruction, brief.offerContext, brief.additionalContext, brief.campaignLinks, brief.campaignLinkText, brief.signature, depthSelect.value);
      result.innerHTML = `<strong>Preview: ${escapeHtml(email.subject)}</strong><pre class="wb-modal-body">${escapeHtml(email.body)}</pre>`;
      result.classList.remove("hidden");
      previewedEmails.set(index, { subject: email.subject, body: email.body, signature: briefSignature(brief, depthSelect.value) });
      previewCooldownUntil.delete(index);
      previewBtn.disabled = false;
      previewBtn.textContent = "Preview one email";
    } catch (err) {
      result.textContent = `Could not create preview: ${String(err)}`;
      result.classList.remove("hidden");
      previewCooldownUntil.set(index, Date.now() + PREVIEW_RETRY_COOLDOWN_MS);
      refreshPreviewButtonState();
    }
  });

  generateBtn.addEventListener("click", async () => {
    const brief = await getBrief();
    const sig = briefSignature(brief, depthSelect.value);
    // Rows already previewed under these exact settings are reused as-is by
    // the backend instead of being generated (and charged for) again — only
    // the remaining rows count toward the cost estimate and confirmation.
    const rowsWithReuse = rows.map((row, index) => {
      const cached = previewedEmails.get(index);
      return cached && cached.signature === sig
        ? { ...row, preview_subject: cached.subject, preview_body: cached.body }
        : row;
    });
    const toGenerateCount = rowsWithReuse.filter((row) => !row.preview_subject || !row.preview_body).length;
    const confirmed = await showCostConfirm(toGenerateCount, formatCost(toGenerateCount * totalCostPerEmail(depthSelect.value)));
    if (!confirmed) return;
    generateBtn.disabled = true;
    generateBtn.textContent = "Creating...";
    try {
      const campaign = await createWinBackCampaignFromCsv(brief.name, rowsWithReuse, depthSelect.value, brief.emailInstruction, brief.offerContext, brief.additionalContext, brief.campaignLinks, brief.campaignLinkText, brief.signature, opts?.sourceRows ?? rows);
      await showCampaignDetail(container, campaign.id);
    } catch (err) {
      generateBtn.disabled = false;
      updateBtnLabel();
      alert(`Failed to create campaign: ${err}`);
    }
  });
}

// --- Campaign detail sub-view ---

async function showCampaignDetail(container: HTMLElement, campaignId: string): Promise<void> {
  clearPoll();
  let detail: WinBackCampaignDetail;
  try {
    detail = await getWinBackCampaign(campaignId);
  } catch (err) {
    container.innerHTML = `<main class="container"><p class="status-error">Failed to load campaign: ${escapeHtml(String(err))}</p></main>`;
    return;
  }
  renderDetail(container, detail);

  if (detail.campaign.status === "generating") {
    pollInterval = setInterval(async () => {
      try {
        const updated = await getWinBackCampaign(campaignId);
        renderDetail(container, updated);
        if (updated.campaign.status !== "generating") clearPoll();
      } catch {
        // keep polling
      }
    }, 3000);
  }
}

function renderDetail(container: HTMLElement, detail: WinBackCampaignDetail): void {
  const { campaign, emails } = detail;
  const generating = campaign.status === "generating";
  const pct = campaign.total > 0 ? Math.round((campaign.generated / campaign.total) * 100) : 0;

  container.innerHTML = `
    <main class="container">
      <section class="card">
        <div class="card-header-row">
          <div>
            <h2 class="card-title">${escapeHtml(campaign.name)}</h2>
            <p class="card-subtitle">${campaign.generated} of ${campaign.total} emails generated</p>
            ${campaign.email_instruction ? `<p class="card-subtitle">Email instruction: ${escapeHtml(campaign.email_instruction)}</p>` : ""}
            ${campaign.offer_context ? `<p class="card-subtitle">Offers: ${escapeHtml(campaign.offer_context)}</p>` : ""}
          </div>
          <div class="card-header-actions">
            ${
              !generating && campaign.generated < campaign.total
                ? `<button id="wb-resume-btn" class="btn btn-primary btn-sm">Resume (${campaign.total - campaign.generated} remaining)</button>`
                : ""
            }
            ${!generating ? `<button id="wb-run-again-btn" class="btn btn-secondary btn-sm">Run again</button>` : ""}
            <button id="wb-back-btn" class="btn btn-ghost">Back</button>
          </div>
        </div>
        <p id="wb-resume-status" class="status-message" style="margin:0"></p>

        ${
          generating
            ? `<div class="wb-progress-wrap">
                <div class="wb-progress-track"><div class="wb-progress-fill" style="width:${pct}%"></div></div>
                <span class="status-message">Generating email ${campaign.generated} of ${campaign.total}...</span>
               </div>`
            : ""
        }

        ${
          emails.length > 0
            ? `<div class="wb-bulk-actions-bar">
                <button id="wb-send-all-btn" class="btn btn-secondary btn-sm">Send all via Gmail</button>
                <button id="wb-mailchimp-btn" class="btn btn-ghost btn-sm">Export to Mailchimp</button>
                <span id="wb-mailchimp-status" class="status-message"></span>
               </div>
               <table class="data-table">
                <thead><tr>
                  <th>Company</th><th>Contact email</th><th>Subject</th><th>Status</th><th>Actions</th>
                </tr></thead>
                <tbody>
                  ${emails
                    .map(
                      (e) => `
                    <tr>
                      <td>${escapeHtml(e.company)}</td>
                      <td>${escapeHtml(e.contact_email || "—")}</td>
                      <td class="wb-subject-cell">${escapeHtml(e.subject || "Generating...")}</td>
                      <td><span class="status-badge ${e.send_status === "sent" ? "status-verified" : ""}">${escapeHtml(e.send_status)}</span></td>
                      <td class="wb-actions-cell">
                        <button class="btn btn-ghost btn-sm wb-preview-btn" data-id="${escapeHtml(e.id)}">Preview</button>
                        ${
                          e.send_status !== "sent" && e.contact_email
                            ? `<button class="btn btn-ghost btn-sm wb-send-btn" data-id="${escapeHtml(e.id)}">Send</button>`
                            : ""
                        }
                      </td>
                    </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div class="empty-state"><p class="card-subtitle">${generating ? "Generating emails..." : "No emails generated yet."}</p></div>`
        }
      </section>
    </main>

    <div id="wb-preview-modal" class="wb-modal hidden">
      <div class="wb-modal-backdrop"></div>
      <div class="wb-modal-box">
        <div class="wb-modal-header">
          <h3 id="wb-modal-subject"></h3>
          <button id="wb-modal-close" class="btn btn-ghost btn-sm">Close</button>
        </div>
        <pre id="wb-modal-body" class="wb-modal-body"></pre>
      </div>
    </div>`;

  container.querySelector<HTMLButtonElement>("#wb-back-btn")!.addEventListener("click", async () => {
    clearPoll();
    await loadCampaignList(container);
  });

  container.querySelector<HTMLButtonElement>("#wb-resume-btn")?.addEventListener("click", async () => {
    const btn = container.querySelector<HTMLButtonElement>("#wb-resume-btn")!;
    const status = container.querySelector<HTMLParagraphElement>("#wb-resume-status")!;
    btn.disabled = true;
    btn.textContent = "Resuming…";
    try {
      const result = await resumeWinBackCampaign(campaign.id);
      status.textContent = `Resumed — generating ${result.remaining} remaining email(s).`;
      await showCampaignDetail(container, campaign.id);
    } catch (err) {
      status.textContent = String(err);
      btn.disabled = false;
      btn.textContent = `Resume (${campaign.total - campaign.generated} remaining)`;
    }
  });

  // Run again: re-load this campaign's original CSV into the review→configure
  // flow to create a fresh (renamed) campaign, re-filtering who to send to.
  container.querySelector<HTMLButtonElement>("#wb-run-again-btn")?.addEventListener("click", async () => {
    const btn = container.querySelector<HTMLButtonElement>("#wb-run-again-btn")!;
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      const data = await getWinBackCampaignRows(campaign.id);
      // New campaigns store their uploaded CSV — re-run straight from it.
      if (data.available && data.rows.length > 0) {
        clearPoll();
        presentLeadReview(container, data.rows, {
          defaults: data.defaults,
          onBack: () => showCampaignDetail(container, campaign.id),
        });
        return;
      }
      // Older campaigns predate CSV storage — re-import the file, but still carry
      // this campaign's saved settings so Configure comes pre-filled.
      btn.disabled = false;
      btn.textContent = "Run again";
      const path = await openDialog({ multiple: false, filters: [{ name: "CSV files", extensions: ["csv"] }] });
      if (!path || typeof path !== "string") return;
      const allRows = await parseWinBackCsv(path);
      clearPoll();
      presentLeadReview(container, allRows, {
        defaults: data.defaults,
        onBack: () => showCampaignDetail(container, campaign.id),
      });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Run again";
      alert(`Could not re-run the campaign: ${String(err)}`);
    }
  });

  const emailMap = new Map<string, WinBackEmail>(emails.map((e) => [e.id, e]));

  container.querySelectorAll<HTMLButtonElement>(".wb-preview-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const email = emailMap.get(btn.dataset.id!);
      if (!email) return;
      const modal = container.querySelector<HTMLDivElement>("#wb-preview-modal")!;
      container.querySelector<HTMLElement>("#wb-modal-subject")!.textContent = email.subject;
      container.querySelector<HTMLElement>("#wb-modal-body")!.textContent = email.body;
      modal.classList.remove("hidden");
    });
  });

  container.querySelector<HTMLButtonElement>("#wb-modal-close")?.addEventListener("click", () => {
    container.querySelector<HTMLDivElement>("#wb-preview-modal")?.classList.add("hidden");
  });

  container.querySelector<HTMLElement>(".wb-modal-backdrop")?.addEventListener("click", () => {
    container.querySelector<HTMLDivElement>("#wb-preview-modal")?.classList.add("hidden");
  });

  container.querySelectorAll<HTMLButtonElement>(".wb-send-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Sending...";
      try {
        await sendWinBackEmail(campaign.id, btn.dataset.id!);
        btn.textContent = "Sent";
        const row = btn.closest("tr")!;
        row.querySelector<HTMLElement>(".status-badge")!.textContent = "sent";
        row.querySelector<HTMLElement>(".status-badge")!.classList.add("status-verified");
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Send";
        alert(`Failed to send: ${err}`);
      }
    });
  });

  container.querySelector<HTMLButtonElement>("#wb-send-all-btn")?.addEventListener("click", async () => {
    const btn = container.querySelector<HTMLButtonElement>("#wb-send-all-btn")!;
    btn.disabled = true;
    btn.textContent = "Sending...";
    try {
      const result = await sendAllWinBackEmails(campaign.id);
      btn.textContent = `Done (${result.sent} sent, ${result.failed} failed)`;
      await showCampaignDetail(container, campaign.id);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Send all via Gmail";
      alert(`Error: ${err}`);
    }
  });

  container.querySelector<HTMLButtonElement>("#wb-mailchimp-btn")?.addEventListener("click", async () => {
    const btn = container.querySelector<HTMLButtonElement>("#wb-mailchimp-btn")!;
    const statusEl = container.querySelector<HTMLSpanElement>("#wb-mailchimp-status")!;
    btn.disabled = true;
    statusEl.textContent = "Exporting...";
    try {
      const url = await exportWinBackMailchimp(campaign.id);
      statusEl.innerHTML = `<a href="#" id="wb-mc-link" style="color:var(--accent-text)">Campaign created in Mailchimp → Review</a>`;
      container.querySelector<HTMLAnchorElement>("#wb-mc-link")?.addEventListener("click", (e) => {
        e.preventDefault();
        // open external link via Tauri shell if available, otherwise copy URL
        navigator.clipboard.writeText(url).then(() => {
          statusEl.textContent = "URL copied to clipboard!";
        });
      });
    } catch (err) {
      statusEl.textContent = `Error: ${String(err)}`;
      btn.disabled = false;
    }
  });
}

// --- Main init ---

async function loadCampaignList(container: HTMLElement): Promise<void> {
  clearPoll();
  try {
    const campaigns = await getWinBackCampaigns();
    renderCampaignList(container, campaigns);
  } catch {
    renderCampaignList(container, []);
  }
}

export function initWinBackCampaign(): void {
  const container = document.querySelector<HTMLDivElement>("#view-win-back")!;
  if (!container) return;

  subscribeAuth(() => {
    if (!getCurrentUser()) return;
    loadCampaignList(container);
  });
}
