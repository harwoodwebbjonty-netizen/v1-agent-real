import {
  type Lead,
  type WinBackCampaign,
  type WinBackCampaignDetail,
  type WinBackEmail,
  createWinBackCampaign,
  exportWinBackMailchimp,
  getLogEntries,
  getWinBackCampaign,
  getWinBackCampaigns,
  sendAllWinBackEmails,
  sendWinBackEmail,
} from "../api";
import { getCurrentUser, subscribeAuth } from "../auth";
import { escapeHtml } from "../utils";

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

// --- Lead picker sub-view ---

async function showLeadPicker(container: HTMLElement): Promise<void> {
  let leads: Lead[] = [];
  try {
    leads = await getLogEntries();
  } catch {
    leads = [];
  }

  const selectedIds = new Set<string>();

  container.innerHTML = `
    <main class="container">
      <section class="card">
        <div class="card-header-row">
          <div>
            <h2 class="card-title">New Win-back Campaign</h2>
            <p class="card-subtitle">Select leads to include, then generate personalised emails.</p>
          </div>
          <div class="card-header-actions">
            <button id="wb-back-btn" class="btn btn-ghost">Back</button>
          </div>
        </div>
        <div class="wb-picker-bar">
          <input id="wb-name-input" class="search-input" type="text" placeholder="Campaign name (e.g. Q3 Win-back)" style="width:260px" />
          <input id="wb-search-input" class="search-input" type="text" placeholder="Search leads..." style="width:200px" />
          <select id="wb-stage-filter" class="search-input" style="width:160px">
            <option value="">All stages</option>
            <option value="lost">Lost</option>
            <option value="none">No stage</option>
            <option value="engaged">Engaged</option>
            <option value="opportunity">Opportunity</option>
          </select>
        </div>
        <div id="wb-bulk-bar" class="wb-bulk-bar hidden">
          <span id="wb-bulk-count"></span>
          <button id="wb-generate-btn" class="btn btn-primary btn-sm">Generate Campaign</button>
        </div>
        <table class="data-table wb-picker-table">
          <thead><tr>
            <th><input type="checkbox" id="wb-select-all" /></th>
            <th>Company</th><th>Contact</th><th>Industry</th><th>Stage</th>
          </tr></thead>
          <tbody id="wb-picker-tbody"></tbody>
        </table>
      </section>
    </main>`;

  const tbody = container.querySelector<HTMLTableSectionElement>("#wb-picker-tbody")!;
  const searchInput = container.querySelector<HTMLInputElement>("#wb-search-input")!;
  const stageFilter = container.querySelector<HTMLSelectElement>("#wb-stage-filter")!;
  const bulkBar = container.querySelector<HTMLDivElement>("#wb-bulk-bar")!;
  const bulkCount = container.querySelector<HTMLSpanElement>("#wb-bulk-count")!;
  const selectAll = container.querySelector<HTMLInputElement>("#wb-select-all")!;

  function getVisible(): Lead[] {
    const q = searchInput.value.toLowerCase();
    const stage = stageFilter.value;
    return leads.filter(
      (l) =>
        (!q || l.company.toLowerCase().includes(q) || (l.contact_name || "").toLowerCase().includes(q)) &&
        (!stage || l.opportunity_stage === stage)
    );
  }

  function renderRows(): void {
    const visible = getVisible();
    tbody.innerHTML = visible
      .map(
        (l) => `
      <tr class="${selectedIds.has(l.id) ? "lead-row-selected" : ""}">
        <td><input type="checkbox" class="select-cb" data-id="${escapeHtml(l.id)}" ${selectedIds.has(l.id) ? "checked" : ""} /></td>
        <td>${escapeHtml(l.company)}</td>
        <td>${escapeHtml(l.contact_name || "—")}</td>
        <td>${escapeHtml(l.industry || "—")}</td>
        <td>${escapeHtml(l.opportunity_stage || "none")}</td>
      </tr>`
      )
      .join("");

    tbody.querySelectorAll<HTMLInputElement>(".select-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.id!;
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        const row = cb.closest("tr")!;
        row.classList.toggle("lead-row-selected", cb.checked);
        updateBulk();
      });
    });
  }

  function updateBulk(): void {
    if (selectedIds.size > 0) {
      bulkBar.classList.remove("hidden");
      bulkCount.textContent = `${selectedIds.size} selected`;
    } else {
      bulkBar.classList.add("hidden");
    }
  }

  selectAll.addEventListener("change", () => {
    const visible = getVisible();
    visible.forEach((l) => {
      if (selectAll.checked) selectedIds.add(l.id);
      else selectedIds.delete(l.id);
    });
    renderRows();
    updateBulk();
  });

  searchInput.addEventListener("input", renderRows);
  stageFilter.addEventListener("change", renderRows);

  container.querySelector<HTMLButtonElement>("#wb-back-btn")!.addEventListener("click", async () => {
    await loadCampaignList(container);
  });

  container.querySelector<HTMLButtonElement>("#wb-generate-btn")!.addEventListener("click", async () => {
    const nameInput = container.querySelector<HTMLInputElement>("#wb-name-input")!;
    const name = nameInput.value.trim() || `Win-back ${new Date().toLocaleDateString()}`;
    if (selectedIds.size === 0) return;
    try {
      const campaign = await createWinBackCampaign(name, [...selectedIds]);
      await showCampaignDetail(container, campaign.id);
    } catch (err) {
      alert(`Failed to create campaign: ${err}`);
    }
  });

  renderRows();
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
          </div>
          <div class="card-header-actions">
            <button id="wb-back-btn" class="btn btn-ghost">Back</button>
          </div>
        </div>

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
