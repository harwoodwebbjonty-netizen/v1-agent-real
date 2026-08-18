import {
  type EmailOAuthAccount,
  type EmailProvider,
  type Lead,
  type ListCampaign,
  type ListCampaignDraft,
  createListCampaign,
  getListCampaign,
  getListCampaignDrafts,
  listEmailOAuthAccounts,
  resumeListCampaign,
  scrapeLeadEmail,
  sendAllListCampaign,
} from "../api";
import { renderDraftGrid } from "../components/outreachDraftGrid";
import { getLeads, refreshLeads } from "../state";
import { escapeHtml } from "../utils";

// A rep picks either a whole cold-call list or a hand-picked set of specific
// leads (chosen via the unified Outreach recipient picker in outreach.ts),
// gives one overall idea (deals/offers + a call link), and the backend
// writes a per-lead email for every target lead, grouped by status. Drafts
// are ordinary email_drafts, so editing/sending reuses the shared draft grid
// component. See backend/app/routers/list_campaigns.py.

export type CampaignTarget =
  | { kind: "list"; listId: string; listName: string }
  | { kind: "leads"; leadIds: string[] };

const POLL_MS = 2500;

function leadHasEmail(lead: Lead): boolean {
  return !!(lead.emails && lead.emails.length > 0);
}

function targetLabel(target: CampaignTarget, count: number): string {
  return target.kind === "list"
    ? `${target.listName} (${count} lead${count === 1 ? "" : "s"})`
    : `${count} selected lead${count === 1 ? "" : "s"}`;
}

export interface ListCampaignHandle {
  /** Starts a fresh campaign brief for the given target — called by the
   * unified Outreach picker once "a whole list" or "2+ specific leads" is
   * selected. */
  start: (target: CampaignTarget) => void;
}

export function initListCampaign(): ListCampaignHandle {
  const container = document.querySelector<HTMLDivElement>("#view-list-campaign")!;

  let accounts: EmailOAuthAccount[] = [];
  let provider: EmailProvider = "gmail";
  let target: CampaignTarget | null = null;
  let campaign: ListCampaign | null = null;
  let drafts: ListCampaignDraft[] = [];
  let pollTimer: number | null = null;

  function clearPoll(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function leadsForTarget(t: CampaignTarget): Lead[] {
    return t.kind === "list"
      ? getLeads().filter((l) => l.list_id === t.listId)
      : getLeads().filter((l) => t.leadIds.includes(l.id));
  }

  // ── Idle state (no target chosen yet) ───────────────────────────────────
  function renderIdle(): void {
    clearPoll();
    campaign = null;
    drafts = [];
    container.innerHTML = `<main class="container"><section class="card">
      <p class="empty-state">Select recipients above to start writing.</p>
    </section></main>`;
  }

  // ── Setup screen (brief form) ───────────────────────────────────────────
  function renderSetup(): void {
    if (!target) { renderIdle(); return; }
    clearPoll();
    campaign = null;
    drafts = [];
    const leads = leadsForTarget(target);
    const withEmail = leads.filter(leadHasEmail).length;

    container.innerHTML = `
      <main class="container">
        <section class="card">
          <div class="card-header-row">
            <div>
              <h2 class="card-title">Write &amp; send</h2>
              <p class="card-subtitle">Composing for: ${escapeHtml(targetLabel(target, leads.length))}</p>
            </div>
          </div>

          ${leads.length === 0
            ? `<p class="empty-state">No leads in this selection.</p>`
            : `
          <div class="lc-form">
            <p id="lc-coverage" class="card-subtitle" style="margin:var(--space-2) 0">
              ${withEmail} of ${leads.length} leads have an email address. Leads without one are skipped when sending.
            </p>
            <button id="lc-find-emails-btn" class="btn btn-secondary btn-sm">Find missing emails</button>
            <span id="lc-find-status" class="status-message"></span>

            <label class="form-label" for="lc-idea-input" style="margin-top:var(--space-4)">Your idea for this email</label>
            <textarea id="lc-idea-input" class="search-input wb-brief-textarea" rows="3" placeholder="e.g. Push our new asset finance at 6.9% before Q3 — invite them to a quick call."></textarea>

            <label class="form-label" for="lc-offers-input" style="margin-top:var(--space-3)">Offers / deals (optional)</label>
            <textarea id="lc-offers-input" class="search-input wb-brief-textarea" rows="2" placeholder="e.g. Unsecured lending from 6.9% (subject to status)."></textarea>

            <label class="form-label" for="lc-link-url-input" style="margin-top:var(--space-3)">Call / booking link</label>
            <input id="lc-link-url-input" class="search-input" type="text" placeholder="https://cal.com/your-team/intro" />

            <label class="form-label" for="lc-link-text-input" style="margin-top:var(--space-3)">Button label</label>
            <input id="lc-link-text-input" class="search-input" type="text" value="Book a call" placeholder="Book a call" />

            <label class="form-label" for="lc-signature-input" style="margin-top:var(--space-3)">Signature (optional)</label>
            <textarea id="lc-signature-input" class="search-input wb-brief-textarea" rows="2" placeholder="Best,&#10;Your name&#10;Your company"></textarea>

            <div style="margin-top:var(--space-4)">
              <button id="lc-generate-btn" class="btn btn-primary">Generate emails</button>
              <span id="lc-generate-status" class="status-message"></span>
            </div>
          </div>`}
        </section>
      </main>`;

    if (leads.length === 0) return;
    container.querySelector<HTMLButtonElement>("#lc-find-emails-btn")!.addEventListener("click", () => void findEmails());
    container.querySelector<HTMLButtonElement>("#lc-generate-btn")!.addEventListener("click", () => void generate());
  }

  async function findEmails(): Promise<void> {
    if (!target) return;
    const missing = leadsForTarget(target).filter((l) => !leadHasEmail(l));
    const status = container.querySelector<HTMLSpanElement>("#lc-find-status")!;
    const btn = container.querySelector<HTMLButtonElement>("#lc-find-emails-btn")!;
    if (missing.length === 0) {
      status.textContent = "Every lead already has an email address.";
      return;
    }
    if (!confirm(`Search the web for email addresses for ${missing.length} lead${missing.length === 1 ? "" : "s"} without one?\n\nThis can take a little while.`)) return;
    btn.disabled = true;
    for (let i = 0; i < missing.length; i++) {
      status.textContent = `Finding email for ${missing[i].company} (${i + 1}/${missing.length})…`;
      try { await scrapeLeadEmail(missing[i].id); } catch { /* skip failures, keep going */ }
    }
    await refreshLeads();
    renderSetup();
    status.textContent = "Done.";
  }

  async function generate(): Promise<void> {
    if (!target) return;
    const idea = container.querySelector<HTMLTextAreaElement>("#lc-idea-input")!.value.trim();
    const status = container.querySelector<HTMLSpanElement>("#lc-generate-status")!;
    if (!idea) { status.textContent = "Add an idea first."; return; }
    const btn = container.querySelector<HTMLButtonElement>("#lc-generate-btn")!;
    btn.disabled = true;
    status.textContent = "Starting…";
    try {
      campaign = await createListCampaign(
        target.kind === "list" ? { listId: target.listId } : { leadIds: target.leadIds },
        idea,
        {
          offers: container.querySelector<HTMLTextAreaElement>("#lc-offers-input")!.value.trim(),
          linkUrl: container.querySelector<HTMLInputElement>("#lc-link-url-input")!.value.trim(),
          linkText: container.querySelector<HTMLInputElement>("#lc-link-text-input")!.value.trim(),
          signature: container.querySelector<HTMLTextAreaElement>("#lc-signature-input")!.value.trim(),
        }
      );
      await refreshCampaign();
      startPolling();
    } catch (err) {
      status.textContent = String(err);
      btn.disabled = false;
    }
  }

  // ── Results screen ──────────────────────────────────────────────────────
  async function refreshCampaign(): Promise<void> {
    if (!campaign) return;
    campaign = await getListCampaign(campaign.id);
    drafts = await getListCampaignDrafts(campaign.id);
    renderResults();
  }

  function startPolling(): void {
    clearPoll();
    pollTimer = window.setInterval(() => {
      if (!campaign) { clearPoll(); return; }
      void (async () => {
        campaign = await getListCampaign(campaign!.id);
        drafts = await getListCampaignDrafts(campaign.id);
        if (campaign.status !== "generating") clearPoll();
        renderResults();
      })();
    }, POLL_MS);
  }

  function providerControlsHtml(): string {
    if (accounts.length === 0) {
      return `<span class="status-message">Connect a Gmail or Outlook account in Settings to send.</span>`;
    }
    const options = accounts
      .map((a) => `<option value="${a.provider}">${escapeHtml(a.email_address)} (${a.provider === "gmail" ? "Gmail" : "Outlook"})</option>`)
      .join("");
    return `
      <select id="lc-provider-select" class="ccl-filter-select">${options}</select>
      <button id="lc-send-all-btn" class="btn btn-secondary btn-sm">Send all</button>`;
  }

  function renderResults(): void {
    if (!campaign) return;
    const generating = campaign.status === "generating";
    const pct = campaign.total_target === 0 ? 0 : Math.round((campaign.generated / campaign.total_target) * 100);
    const remaining = campaign.total_target - campaign.generated;

    container.innerHTML = `
      <main class="container">
        <section class="card">
          <div class="card-header-row">
            <div>
              <h2 class="card-title">${escapeHtml(campaign.name)}</h2>
              <p class="card-subtitle">${campaign.generated} of ${campaign.total_target} emails generated${campaign.status === "stopped" ? " · stopped at credit limit" : ""}</p>
            </div>
            <div class="card-header-actions">
              ${!generating && remaining > 0 ? `<button id="lc-resume-btn" class="btn btn-primary btn-sm">Resume (${remaining} left)</button>` : ""}
              <button id="lc-back-btn" class="btn btn-ghost btn-sm">Start over</button>
            </div>
          </div>
          ${generating
            ? `<div class="wb-progress-wrap"><div class="wb-progress-track"><div class="wb-progress-fill" style="width:${pct}%"></div></div>
               <span class="status-message">Generating ${campaign.generated} of ${campaign.total_target}…</span></div>`
            : `<div class="wb-bulk-actions-bar">${providerControlsHtml()}<span id="lc-send-all-status" class="status-message"></span></div>`}
        </section>
        <div id="lc-draft-grid"></div>
      </main>`;

    if (drafts.length === 0) {
      container.querySelector<HTMLDivElement>("#lc-draft-grid")!.innerHTML =
        `<section class="card"><p class="empty-state">${generating ? "Writing emails…" : "No emails generated."}</p></section>`;
    } else {
      renderDraftGrid(
        container.querySelector<HTMLDivElement>("#lc-draft-grid")!,
        drafts,
        provider,
        accounts.length > 0,
        () => renderResults()
      );
    }

    wireResults();
  }

  function wireResults(): void {
    container.querySelector<HTMLButtonElement>("#lc-back-btn")?.addEventListener("click", () => renderSetup());
    container.querySelector<HTMLButtonElement>("#lc-resume-btn")?.addEventListener("click", () => void doResume());

    const provSel = container.querySelector<HTMLSelectElement>("#lc-provider-select");
    provSel?.addEventListener("change", () => { provider = provSel.value as EmailProvider; });
    container.querySelector<HTMLButtonElement>("#lc-send-all-btn")?.addEventListener("click", () => void doSendAll());
  }

  async function doResume(): Promise<void> {
    if (!campaign) return;
    const btn = container.querySelector<HTMLButtonElement>("#lc-resume-btn")!;
    btn.disabled = true;
    btn.textContent = "Resuming…";
    try {
      campaign = await resumeListCampaign(campaign.id);
      drafts = await getListCampaignDrafts(campaign.id);
      startPolling();
      renderResults();
    } catch (err) {
      const status = container.querySelector<HTMLSpanElement>("#lc-send-all-status");
      if (status) status.textContent = String(err);
      btn.disabled = false;
      btn.textContent = "Resume";
    }
  }

  async function doSendAll(): Promise<void> {
    if (!campaign) return;
    const status = container.querySelector<HTMLSpanElement>("#lc-send-all-status")!;
    const unsent = drafts.filter((d) => d.status !== "sent" && d.contact_email).length;
    if (unsent === 0) { status.textContent = "Nothing left to send."; return; }
    if (!confirm(`Send ${unsent} email${unsent === 1 ? "" : "s"} from your ${provider === "gmail" ? "Gmail" : "Outlook"} account now?`)) return;
    const btn = container.querySelector<HTMLButtonElement>("#lc-send-all-btn")!;
    btn.disabled = true;
    status.textContent = "Sending…";
    try {
      const res = await sendAllListCampaign(campaign.id, provider);
      status.textContent = `Sent ${res.sent}. ${res.failed ? `${res.failed} failed. ` : ""}${res.skipped ? `${res.skipped} skipped (no email).` : ""}`;
      drafts = await getListCampaignDrafts(campaign.id);
      renderResults();
    } catch (err) {
      status.textContent = String(err);
      btn.disabled = false;
    }
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function start(newTarget: CampaignTarget): void {
    target = newTarget;
    renderSetup();
  }

  void (async () => {
    try { accounts = await listEmailOAuthAccounts(); provider = accounts[0]?.provider ?? "gmail"; } catch { /* none connected */ }
    renderIdle();
  })();

  return { start };
}
