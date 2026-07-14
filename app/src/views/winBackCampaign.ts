import {
  type WinBackCampaign,
  type WinBackCampaignDetail,
  type WinBackCsvRow,
  type WinBackEmail,
  createWinBackCampaignFromCsv,
  exportWinBackMailchimp,
  getWinBackCampaign,
  getWinBackCampaigns,
  parseWinBackCsv,
  previewWinBackCampaignEmail,
  resumeWinBackCampaign,
  sendAllWinBackEmails,
  sendWinBackEmail,
} from "../api";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentUser, subscribeAuth } from "../auth";
import { escapeHtml } from "../utils";

// Haiku pricing (claude-haiku-4-5): $0.80/MTok input, $4/MTok output
// Average per win-back email: ~1,500 input tokens + ~350 output tokens
const WINBACK_COST_PER_EMAIL = 1500 * (0.80 / 1_000_000) + 350 * (4 / 1_000_000);

// Research depth costs (web searches + Claude synthesis per lead)
const DEPTH_COST: Record<string, number> = {
  quick: 0.04,
  standard: 0.10,
  deep: 0.20,
};

function totalCostPerEmail(depth: string): number {
  return WINBACK_COST_PER_EMAIL + (DEPTH_COST[depth] ?? 0.10);
}

function formatCost(n: number): string {
  if (n < 0.01) return `${(n * 100).toFixed(2)}¢`;
  return `$${n.toFixed(2)}`;
}

function showCostConfirm(count: number, totalCost: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "conflict-modal-overlay";
    overlay.innerHTML = `
      <div class="conflict-modal">
        <div class="conflict-modal-title">Confirm email generation</div>
        <div class="conflict-modal-desc">
          You're about to generate <strong>${count} personalised email${count === 1 ? "" : "s"}</strong>
          using the Anthropic API.
        </div>
        <div class="conflict-modal-question">
          Estimated cost: <strong>${totalCost}</strong>
          <span class="cost-confirm-note">(web research + AI email generation via Haiku)</span>
        </div>
        <div class="conflict-modal-actions">
          <button class="btn btn-primary" id="cost-confirm-yes">Generate</button>
          <button class="btn btn-secondary" id="cost-confirm-no">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
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
      <section class="card">
        <div class="card-header-row">
          <div>
            <h2 class="card-title">Win-back Campaigns</h2>
            <p class="card-subtitle">AI-generated re-engagement emails for dormant or lost leads.</p>
          </div>
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

async function showCsvPreview(container: HTMLElement, csvPath: string): Promise<void> {
  let rows: WinBackCsvRow[] = [];
  let droppedNoEmail = 0;
  try {
    rows = await parseWinBackCsv(csvPath);
    // Email campaigns can only reach leads with an email — drop the rest up
    // front so they don't cost generation money for an unsendable draft.
    const total = rows.length;
    rows = rows.filter((r) => (r.email || "").trim().length > 0);
    droppedNoEmail = total - rows.length;
  } catch (err) {
    container.innerHTML = `<main class="container"><p class="status-error">Could not parse CSV: ${escapeHtml(String(err))}</p><button id="wb-back2-btn" class="btn btn-ghost" style="margin-top:12px">Back</button></main>`;
    container.querySelector<HTMLButtonElement>("#wb-back2-btn")!.addEventListener("click", () => showLeadPicker(container));
    return;
  }

  if (rows.length === 0) {
    container.innerHTML = `<main class="container"><p class="status-error">No rows with an email address found in this CSV — a win-back campaign needs emails to send to.</p><button id="wb-back2-btn" class="btn btn-ghost" style="margin-top:12px">Back</button></main>`;
    container.querySelector<HTMLButtonElement>("#wb-back2-btn")!.addEventListener("click", () => showLeadPicker(container));
    return;
  }

  container.innerHTML = `
    <main class="container">
      <section class="card">
        <div class="card-header-row">
          <div>
            <h2 class="card-title">Review imported leads</h2>
            <p class="card-subtitle">${rows.length} lead${rows.length !== 1 ? "s" : ""} with an email address${droppedNoEmail > 0 ? ` (${droppedNoEmail} without an email skipped)` : ""}. Review before generating.</p>
          </div>
          <div class="card-header-actions">
            <button id="wb-back-btn" class="btn btn-ghost">Back</button>
          </div>
        </div>
        <div class="wb-picker-bar">
          <button id="wb-configure-btn" class="btn btn-primary">Configure generation</button>
          <span class="status-message">Set the email brief, offers and preview a draft before generating.</span>
        </div>
        <table class="data-table">
          <thead><tr>
            <th>Company</th><th>Contact</th><th>Email</th><th>Phone</th><th>Website</th><th>LinkedIn</th>
          </tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr>
                <td>${escapeHtml(r.company)}</td>
                <td>${escapeHtml(r.contact_name || "—")}</td>
                <td>${escapeHtml(r.email || "—")}</td>
                <td>${escapeHtml(r.phone || "—")}</td>
                <td class="wb-subject-cell">${escapeHtml(r.website || "—")}</td>
                <td class="wb-subject-cell">${escapeHtml(r.linkedin || "—")}</td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </section>
    </main>`;

  container.querySelector<HTMLButtonElement>("#wb-back-btn")!.addEventListener("click", () => {
    showLeadPicker(container);
  });

  container.querySelector<HTMLButtonElement>("#wb-configure-btn")!.addEventListener("click", () => {
    showGenerationConfig(container, rows);
  });
}

// --- Campaign configuration sub-view ---

function showGenerationConfig(container: HTMLElement, rows: WinBackCsvRow[]): void {
  const defaultRelationshipContext = "These recipients are previous Winchester Corporate Finance customers. Acknowledge the existing funding relationship naturally, without inventing a specific facility, amount or date.";
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
          <input id="wb-name-input" class="search-input" type="text" placeholder="e.g. Q3 customer re-engagement" />

          <label class="form-label" for="wb-email-instruction-input">Email direction</label>
          <textarea id="wb-email-instruction-input" class="search-input wb-brief-textarea" rows="3">Existing customer re-engagement email. Reconnect warmly and invite a short review of current funding needs.</textarea>

          <label class="form-label" for="wb-offer-context-input">Current offers or deals</label>
          <textarea id="wb-offer-context-input" class="search-input wb-brief-textarea" rows="3" placeholder="e.g. Unsecured business lending from 6.9% (subject to status and underwriting)."></textarea>
          <p class="card-subtitle">Only enter approved, current terms. The email will mention them only where relevant.</p>

          <label class="form-label" for="wb-additional-context-input">Additional campaign context</label>
          <textarea id="wb-additional-context-input" class="search-input wb-brief-textarea" rows="4">${escapeHtml(defaultRelationshipContext)}</textarea>

          <label class="form-label" for="wb-depth-select">Research depth</label>
          <select id="wb-depth-select" class="search-input" title="Research depth controls how many web searches are run per lead">
            <option value="quick">Quick scan (3 searches) ~$0.04/lead</option>
            <option value="standard" selected>Standard (5 searches) ~$0.10/lead</option>
            <option value="deep">Deep research (10 searches) ~$0.20/lead</option>
          </select>

          <div class="wb-picker-bar">
            <select id="wb-preview-lead-select" class="search-input" title="Choose the imported lead used for the preview">
              ${rows.map((row, index) => `<option value="${index}">${escapeHtml(row.company)}${row.contact_name ? ` — ${escapeHtml(row.contact_name)}` : ""}</option>`).join("")}
            </select>
            <button id="wb-preview-btn" class="btn btn-secondary">Preview one email (no credits)</button>
            <button id="wb-generate-btn" class="btn btn-primary">Generate Campaign (${rows.length} emails · ${formatCost(rows.length * totalCostPerEmail("standard"))} est.)</button>
          </div>
          <p class="card-subtitle">Preview uses the selected imported lead and this brief only. It does not save a campaign, run research or deduct a Win-back credit.</p>
          <div id="wb-preview-result" class="wb-preview-result hidden"></div>
        </div>
      </section>
    </main>`;

  container.querySelector<HTMLButtonElement>("#wb-back-review-btn")!.addEventListener("click", () => showLeadPicker(container));

  const depthSelect = container.querySelector<HTMLSelectElement>("#wb-depth-select")!;
  const generateBtn = container.querySelector<HTMLButtonElement>("#wb-generate-btn")!;
  const getBrief = () => ({
    name: container.querySelector<HTMLInputElement>("#wb-name-input")!.value.trim() || `Win-back ${new Date().toLocaleDateString()}`,
    emailInstruction: container.querySelector<HTMLTextAreaElement>("#wb-email-instruction-input")!.value.trim(),
    offerContext: container.querySelector<HTMLTextAreaElement>("#wb-offer-context-input")!.value.trim(),
    additionalContext: container.querySelector<HTMLTextAreaElement>("#wb-additional-context-input")!.value.trim(),
  });
  const updateBtnLabel = () => {
    generateBtn.textContent = `Generate Campaign (${rows.length} emails · ${formatCost(rows.length * totalCostPerEmail(depthSelect.value))} est.)`;
  };
  depthSelect.addEventListener("change", updateBtnLabel);

  container.querySelector<HTMLButtonElement>("#wb-preview-btn")!.addEventListener("click", async () => {
    const previewBtn = container.querySelector<HTMLButtonElement>("#wb-preview-btn")!;
    const result = container.querySelector<HTMLDivElement>("#wb-preview-result")!;
    const index = Number(container.querySelector<HTMLSelectElement>("#wb-preview-lead-select")!.value);
    const brief = getBrief();
    previewBtn.disabled = true;
    previewBtn.textContent = "Creating preview...";
    try {
      const email = await previewWinBackCampaignEmail(rows[index], brief.emailInstruction, brief.offerContext, brief.additionalContext);
      result.innerHTML = `<strong>Preview: ${escapeHtml(email.subject)}</strong><pre class="wb-modal-body">${escapeHtml(email.body)}</pre>`;
      result.classList.remove("hidden");
    } catch (err) {
      result.textContent = `Could not create preview: ${String(err)}`;
      result.classList.remove("hidden");
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = "Preview one email (no credits)";
    }
  });

  generateBtn.addEventListener("click", async () => {
    const brief = getBrief();
    const confirmed = await showCostConfirm(rows.length, formatCost(rows.length * totalCostPerEmail(depthSelect.value)));
    if (!confirmed) return;
    generateBtn.disabled = true;
    generateBtn.textContent = "Creating...";
    try {
      const campaign = await createWinBackCampaignFromCsv(brief.name, rows, depthSelect.value, brief.emailInstruction, brief.offerContext, brief.additionalContext);
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
