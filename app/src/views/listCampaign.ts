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
  sendEmailDraft,
  updateEmailDraft,
} from "../api";
import { CONTACT_STATUS_ORDER } from "../constants";
import { getLeadLists, refreshLeadLists, subscribeLeadLists } from "../leadLists";
import { getLeads, refreshLeads } from "../state";
import { escapeHtml } from "../utils";

// A rep picks a cold-call list, gives one overall idea (deals/offers + a call
// link) and the backend writes a per-lead email for every lead on the list,
// grouped by status. Drafts are ordinary email_drafts, so editing/sending reuses
// the existing draft endpoints. See backend/app/routers/list_campaigns.py.

const POLL_MS = 2500;

/** Render a stored draft body (which may contain a baked-in CTA <a> button,
 * **bold** markers and newlines) to safe HTML — mirrors the backend's HTML
 * alternative: keep the anchor tags, escape everything else. */
const ANCHOR_RE = /<a\s+href="[^"]*"[^>]*>.*?<\/a>/gi;
function renderBodyHtml(body: string): string {
  const anchors = body.match(ANCHOR_RE) || [];
  const parts = body.split(ANCHOR_RE);
  let html = "";
  parts.forEach((part, i) => {
    html += escapeHtml(part).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
    if (i < anchors.length) html += anchors[i];
  });
  return html;
}

function leadHasEmail(lead: Lead): boolean {
  return !!(lead.emails && lead.emails.length > 0);
}

export function initListCampaign(): void {
  const container = document.querySelector<HTMLDivElement>("#view-list-campaign")!;

  let accounts: EmailOAuthAccount[] = [];
  let provider: EmailProvider = "gmail";
  let campaign: ListCampaign | null = null;
  let drafts: ListCampaignDraft[] = [];
  let pollTimer: number | null = null;

  function clearPoll(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function selectedListId(): string {
    return container.querySelector<HTMLSelectElement>("#lc-list-select")?.value ?? "";
  }

  function leadsForList(listId: string): Lead[] {
    return listId ? getLeads().filter((l) => l.list_id === listId) : [];
  }

  // ── Setup screen ────────────────────────────────────────────────────────
  function renderSetup(): void {
    clearPoll();
    campaign = null;
    drafts = [];
    const lists = getLeadLists();

    container.innerHTML = `
      <main class="container">
        <section class="card">
          <div class="card-header-row">
            <div>
              <h2 class="card-title">List Campaign</h2>
              <p class="card-subtitle">Email a whole cold-call list. One idea in — a personalised email per lead out, grouped by status, sent from your own inbox.</p>
            </div>
          </div>

          ${lists.length === 0
            ? `<p class="empty-state">No call lists yet — build one on the Cold Call Lists page first.</p>`
            : `
          <div class="lc-form">
            <label class="form-label" for="lc-list-select">Call list</label>
            <select id="lc-list-select" class="ccl-filter-select">
              ${lists.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)} (${l.lead_count} lead${l.lead_count === 1 ? "" : "s"})</option>`).join("")}
            </select>
            <p id="lc-coverage" class="card-subtitle" style="margin:var(--space-2) 0"></p>
            <button id="lc-find-emails-btn" class="btn btn-secondary btn-sm">Find missing emails</button>
            <span id="lc-find-status" class="status-message"></span>

            <label class="form-label" for="lc-idea-input" style="margin-top:var(--space-4)">Your idea for this campaign</label>
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

    if (lists.length === 0) return;

    const listSelect = container.querySelector<HTMLSelectElement>("#lc-list-select")!;
    listSelect.addEventListener("change", updateCoverage);
    updateCoverage();

    container.querySelector<HTMLButtonElement>("#lc-find-emails-btn")!.addEventListener("click", () => void findEmails());
    container.querySelector<HTMLButtonElement>("#lc-generate-btn")!.addEventListener("click", () => void generate());
  }

  function updateCoverage(): void {
    const el = container.querySelector<HTMLParagraphElement>("#lc-coverage");
    if (!el) return;
    const leads = leadsForList(selectedListId());
    const withEmail = leads.filter(leadHasEmail).length;
    el.textContent = leads.length === 0
      ? "This list has no leads yet."
      : `${withEmail} of ${leads.length} leads have an email address. Leads without one are skipped when sending.`;
  }

  async function findEmails(): Promise<void> {
    const listId = selectedListId();
    const missing = leadsForList(listId).filter((l) => !leadHasEmail(l));
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
    updateCoverage();
    status.textContent = "Done.";
    btn.disabled = false;
  }

  async function generate(): Promise<void> {
    const listId = selectedListId();
    const idea = container.querySelector<HTMLTextAreaElement>("#lc-idea-input")!.value.trim();
    const status = container.querySelector<HTMLSpanElement>("#lc-generate-status")!;
    if (!idea) { status.textContent = "Add an idea first."; return; }
    const btn = container.querySelector<HTMLButtonElement>("#lc-generate-btn")!;
    btn.disabled = true;
    status.textContent = "Starting…";
    try {
      campaign = await createListCampaign(listId, idea, {
        offers: container.querySelector<HTMLTextAreaElement>("#lc-offers-input")!.value.trim(),
        linkUrl: container.querySelector<HTMLInputElement>("#lc-link-url-input")!.value.trim(),
        linkText: container.querySelector<HTMLInputElement>("#lc-link-text-input")!.value.trim(),
        signature: container.querySelector<HTMLTextAreaElement>("#lc-signature-input")!.value.trim(),
      });
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

  function draftCardHtml(d: ListCampaignDraft): string {
    const sent = d.status === "sent";
    const noEmail = !d.contact_email;
    return `
      <div class="lc-draft-card" data-id="${escapeHtml(d.id)}">
        <div class="lc-draft-head">
          <div>
            <span class="lc-draft-company">${escapeHtml(d.company)}</span>
            ${d.contact_name ? `<span class="empty-hint"> · ${escapeHtml(d.contact_name)}</span>` : ""}
          </div>
          <div class="lc-draft-meta">
            ${noEmail
              ? `<span class="status-badge status-not-found">No email</span>`
              : `<span class="empty-hint">${escapeHtml(d.contact_email)}</span>`}
            ${sent ? `<span class="status-badge status-verified">Sent</span>` : ""}
          </div>
        </div>
        <input class="search-input lc-subject" value="${escapeHtml(d.subject)}" ${sent ? "disabled" : ""} />
        <div class="lc-body-preview">${renderBodyHtml(d.body)}</div>
        <textarea class="search-input lc-body-edit hidden" rows="8">${escapeHtml(d.body)}</textarea>
        <div class="lc-draft-actions">
          ${sent ? "" : `<button class="btn btn-ghost btn-sm lc-edit-btn">Edit</button>`}
          ${sent ? "" : `<button class="btn btn-ghost btn-sm lc-save-btn hidden">Save</button>`}
          ${sent || noEmail || accounts.length === 0 ? "" : `<button class="btn btn-ghost btn-sm lc-send-btn">Send</button>`}
          <span class="status-message lc-draft-status"></span>
        </div>
      </div>`;
  }

  function renderResults(): void {
    if (!campaign) return;
    const generating = campaign.status === "generating";
    const pct = campaign.total_target === 0 ? 0 : Math.round((campaign.generated / campaign.total_target) * 100);
    const remaining = campaign.total_target - campaign.generated;

    const sections = CONTACT_STATUS_ORDER.map((st) => {
      const group = drafts.filter((d) => (d.contact_status || "New") === st);
      if (group.length === 0) return "";
      return `
        <section class="card">
          <h3 class="card-title">${escapeHtml(st)} <span class="empty-hint">· ${group.length}</span></h3>
          <div class="lc-draft-list">${group.map(draftCardHtml).join("")}</div>
        </section>`;
    }).join("");

    const ungrouped = drafts.filter((d) => !CONTACT_STATUS_ORDER.includes(d.contact_status || "New"));
    const otherSection = ungrouped.length > 0
      ? `<section class="card"><h3 class="card-title">Other <span class="empty-hint">· ${ungrouped.length}</span></h3>
         <div class="lc-draft-list">${ungrouped.map(draftCardHtml).join("")}</div></section>`
      : "";

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
              <button id="lc-back-btn" class="btn btn-ghost btn-sm">New campaign</button>
            </div>
          </div>
          ${generating
            ? `<div class="wb-progress-wrap"><div class="wb-progress-track"><div class="wb-progress-fill" style="width:${pct}%"></div></div>
               <span class="status-message">Generating ${campaign.generated} of ${campaign.total_target}…</span></div>`
            : `<div class="wb-bulk-actions-bar">${providerControlsHtml()}<span id="lc-send-all-status" class="status-message"></span></div>`}
        </section>
        ${drafts.length === 0 ? `<section class="card"><p class="empty-state">${generating ? "Writing emails…" : "No emails generated."}</p></section>` : sections + otherSection}
      </main>`;

    wireResults();
  }

  function wireResults(): void {
    container.querySelector<HTMLButtonElement>("#lc-back-btn")?.addEventListener("click", () => { clearPoll(); renderSetup(); });
    container.querySelector<HTMLButtonElement>("#lc-resume-btn")?.addEventListener("click", () => void doResume());

    const provSel = container.querySelector<HTMLSelectElement>("#lc-provider-select");
    provSel?.addEventListener("change", () => { provider = provSel.value as EmailProvider; });
    container.querySelector<HTMLButtonElement>("#lc-send-all-btn")?.addEventListener("click", () => void doSendAll());

    container.querySelectorAll<HTMLDivElement>(".lc-draft-card").forEach((card) => {
      const id = card.dataset.id!;
      const preview = card.querySelector<HTMLDivElement>(".lc-body-preview")!;
      const edit = card.querySelector<HTMLTextAreaElement>(".lc-body-edit")!;
      const editBtn = card.querySelector<HTMLButtonElement>(".lc-edit-btn");
      const saveBtn = card.querySelector<HTMLButtonElement>(".lc-save-btn");
      const cardStatus = card.querySelector<HTMLSpanElement>(".lc-draft-status")!;

      editBtn?.addEventListener("click", () => {
        preview.classList.add("hidden");
        edit.classList.remove("hidden");
        editBtn.classList.add("hidden");
        saveBtn?.classList.remove("hidden");
      });

      saveBtn?.addEventListener("click", () => void (async () => {
        const subject = card.querySelector<HTMLInputElement>(".lc-subject")!.value;
        const body = edit.value;
        saveBtn.disabled = true;
        cardStatus.textContent = "Saving…";
        try {
          await updateEmailDraft(id, { subject, body });
          const d = drafts.find((x) => x.id === id);
          if (d) { d.subject = subject; d.body = body; }
          preview.innerHTML = renderBodyHtml(body);
          preview.classList.remove("hidden");
          edit.classList.add("hidden");
          saveBtn.classList.add("hidden");
          editBtn?.classList.remove("hidden");
          cardStatus.textContent = "Saved.";
        } catch (err) {
          cardStatus.textContent = String(err);
        }
        saveBtn.disabled = false;
      })());

      card.querySelector<HTMLButtonElement>(".lc-send-btn")?.addEventListener("click", () => void (async () => {
        const sendBtn = card.querySelector<HTMLButtonElement>(".lc-send-btn")!;
        sendBtn.disabled = true;
        cardStatus.textContent = "Sending…";
        try {
          // Persist any inline subject edit before sending.
          const subject = card.querySelector<HTMLInputElement>(".lc-subject")!.value;
          const d = drafts.find((x) => x.id === id);
          if (d && subject !== d.subject) { await updateEmailDraft(id, { subject }); d.subject = subject; }
          await sendEmailDraft(id, provider);
          if (d) d.status = "sent";
          renderResults();
        } catch (err) {
          cardStatus.textContent = String(err);
          sendBtn.disabled = false;
        }
      })());
    });
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
  void (async () => {
    try { accounts = await listEmailOAuthAccounts(); provider = accounts[0]?.provider ?? "gmail"; } catch { /* none connected */ }
    await Promise.all([refreshLeadLists(), refreshLeads()]);
    if (!campaign) renderSetup();
  })();

  // Keep the list dropdown fresh when lists change elsewhere (only on setup screen).
  subscribeLeadLists(() => { if (!campaign) { renderSetup(); } });
}
