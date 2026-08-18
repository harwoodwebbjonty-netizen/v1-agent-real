import {
  type BrandVoice,
  type ChatTurn,
  type EmailDraft,
  type EmailLength,
  type EmailPreset,
  type EmailTemplate,
  type Lead,
  type PersonalisationOption,
  type TimelineEntry,
  EMAIL_LENGTHS,
  EMAIL_PRESETS,
  applyEmailTemplate,
  createEmailTemplate,
  createManualEmailDraft,
  generateEmailDraft,
  generateEmailPersonalisation,
  getBrandVoice,
  getEmailCtaSuggestions,
  getLeadTimeline,
  listEmailOAuthAccounts,
  listEmailTemplates,
  refineEmailDraft,
  sendEmailDraft,
  updateEmailDraft,
} from "../api";
import { getLeads, subscribe } from "../state";
import { escapeHtml, sanitizeHtmlFragment } from "../utils";

const VARIABLES: { key: string; label: string }[] = [
  { key: "first_name", label: "First Name" },
  { key: "company", label: "Company" },
  { key: "job_title", label: "Job Title" },
  { key: "industry", label: "Industry" },
  { key: "website", label: "Website" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "lead_notes", label: "Lead Notes" },
  { key: "ai_summary", label: "AI Summary" },
  { key: "recent_activity", label: "Recent Activity" },
  { key: "sender_name", label: "Sender Name" },
  { key: "sender_company", label: "Sender Company" },
  { key: "booking_link", label: "Booking Link" },
  { key: "current_date", label: "Current Date" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
  { key: "custom_field", label: "Custom Field" },
];

interface DraftSession {
  key: string;
  leadId: string;
  draftId: string | null;
  subject: string;
  bodyHtml: string;
  preset: EmailPreset;
  length: EmailLength;
  estimatedOpenRate: number | null;
  estimatedReplyRate: number | null;
  estimatedReadability: number | null;
  dirty: boolean;
  chatHistory: ChatTurn[];
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function newSession(leadId: string): DraftSession {
  return {
    key: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    leadId,
    draftId: null,
    subject: "",
    bodyHtml: "",
    preset: "Custom",
    length: "Medium",
    estimatedOpenRate: null,
    estimatedReplyRate: null,
    estimatedReadability: null,
    dirty: false,
    chatHistory: [],
  };
}

export interface EmailWriterHandle {
  /** Pre-loads (or switches the active draft to) the given lead — called by
   * the unified Outreach picker once exactly one lead is selected. */
  focusLead: (leadId: string) => void;
}

export function initEmailWriter(): EmailWriterHandle {
  const container = document.querySelector<HTMLDivElement>("#view-email-writer")!;
  container.innerHTML = `
    <main class="container email-writer-container">
      <div class="email-writer-layout">
        <section class="card ew-editor-pane">
          <div id="ew-lead-details" class="ew-lead-summary"></div>
          <div id="ew-draft-tabs" class="ew-draft-tabs"></div>
          <div id="ew-editor"></div>
        </section>

        <section class="card ew-assistant-pane">
          <div class="ew-assistant-tabs">
            <button class="btn btn-ghost btn-sm ew-assistant-tab active" type="button" data-tab="chat">Chat</button>
            <button class="btn btn-ghost btn-sm ew-assistant-tab" type="button" data-tab="personalisation">Personalise</button>
            <button class="btn btn-ghost btn-sm ew-assistant-tab" type="button" data-tab="cta">CTA</button>
          </div>
          <div id="ew-assistant-content"></div>
        </section>

        <section class="card ew-timeline-pane">
          <h2 class="card-title">Activity Timeline</h2>
          <ul id="ew-timeline-list" class="history-list"></ul>
          <p id="ew-timeline-empty" class="empty-hint hidden">No activity yet for this lead.</p>
        </section>
      </div>
    </main>

    <div id="ew-preview-overlay" class="ew-preview-overlay hidden">
      <div class="ew-preview-card">
        <div class="card-header-row">
          <h2 class="card-title">Preview</h2>
          <button id="ew-preview-close-btn" class="btn btn-ghost" type="button">✕</button>
        </div>
        <div id="ew-preview-body"></div>
        <div class="card-actions">
          <button id="ew-preview-send-btn" class="btn btn-primary" type="button">Send</button>
          <button id="ew-preview-edit-btn" class="btn btn-secondary" type="button">Edit</button>
          <button id="ew-preview-back-btn" class="btn btn-ghost" type="button">Return to Draft</button>
          <button id="ew-preview-done-btn" class="btn btn-primary hidden" type="button">Done</button>
        </div>
      </div>
    </div>
  `;

  const leadDetailsEl = document.querySelector<HTMLDivElement>("#ew-lead-details")!;
  const draftTabsEl = document.querySelector<HTMLDivElement>("#ew-draft-tabs")!;
  const editorEl = document.querySelector<HTMLDivElement>("#ew-editor")!;
  const assistantContentEl = document.querySelector<HTMLDivElement>("#ew-assistant-content")!;
  const timelineListEl = document.querySelector<HTMLUListElement>("#ew-timeline-list")!;
  const timelineEmptyEl = document.querySelector<HTMLParagraphElement>("#ew-timeline-empty")!;
  const previewOverlay = document.querySelector<HTMLDivElement>("#ew-preview-overlay")!;
  const previewBodyEl = document.querySelector<HTMLDivElement>("#ew-preview-body")!;

  let sessions: DraftSession[] = [];
  let activeKey: string | null = null;
  let assistantTab: "chat" | "personalisation" | "cta" = "chat";
  let personalisationOptions: PersonalisationOption[] | null = null;
  let ctaSuggestions: string[] | null = null;
  let brandVoice: BrandVoice | null = null;
  let templates: EmailTemplate[] = [];
  let generatePending = false;

  function activeSession(): DraftSession | null {
    return sessions.find((s) => s.key === activeKey) ?? null;
  }

  function selectedLead(): Lead | null {
    const session = activeSession();
    if (!session) return null;
    return getLeads().find((l) => l.id === session.leadId) ?? null;
  }

  // --- Lead summary (recipient is chosen externally, in outreach.ts) ---

  function renderLeadPane(): void {
    const lead = selectedLead();
    if (!lead) {
      leadDetailsEl.innerHTML = '<p class="empty-hint">Select a lead above to start writing.</p>';
      return;
    }
    leadDetailsEl.innerHTML = `
      <h4>${escapeHtml(lead.company)}</h4>
      <dl class="info-list">
        <dt>Contact</dt><dd>${escapeHtml(lead.contact_name || "—")}</dd>
        <dt>Title</dt><dd>${escapeHtml(lead.contact_title || "—")}</dd>
        <dt>Industry</dt><dd>${escapeHtml(lead.industry || "—")}</dd>
        <dt>Website</dt><dd>${escapeHtml(lead.website || "—")}</dd>
        <dt>Notes</dt><dd>${escapeHtml(lead.lead_notes || "—")}</dd>
      </dl>
      ${
        lead.intelligence
          ? `<p class="empty-hint">AI Summary: ${escapeHtml(lead.intelligence.sales_summary)}</p>`
          : '<p class="empty-hint">No AI intelligence generated for this lead yet.</p>'
      }
    `;
  }

  function selectLeadForActiveSession(leadId: string): void {
    let session = activeSession();
    if (!session) {
      session = newSession(leadId);
      sessions = [...sessions, session];
      activeKey = session.key;
    } else {
      session.leadId = leadId;
    }
    personalisationOptions = null;
    ctaSuggestions = null;
    renderAll();
    void refreshTimeline();
  }

  // --- Draft tabs ---

  function renderDraftTabs(): void {
    draftTabsEl.innerHTML = sessions
      .map(
        (s) => `
        <div class="tab-chip ${s.key === activeKey ? "active" : ""}" data-key="${escapeHtml(s.key)}">
          <span class="tab-chip-title">${escapeHtml(s.subject || "New Draft")}${s.dirty ? " •" : ""}</span>
          <button class="tab-chip-close" type="button" data-key="${escapeHtml(s.key)}" title="Close">✕</button>
        </div>`
      )
      .join("");
    draftTabsEl.querySelectorAll<HTMLDivElement>(".tab-chip").forEach((chip) => {
      chip.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest(".tab-chip-close")) return;
        activeKey = chip.dataset.key!;
        personalisationOptions = null;
        ctaSuggestions = null;
        renderAll();
        void refreshTimeline();
      });
    });
    draftTabsEl.querySelectorAll<HTMLButtonElement>(".tab-chip-close").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        closeSession(btn.dataset.key!);
      });
    });
  }

  function closeSession(key: string): void {
    const wasActive = activeKey === key;
    sessions = sessions.filter((s) => s.key !== key);
    if (wasActive) activeKey = sessions.length > 0 ? sessions[sessions.length - 1].key : null;
    renderAll();
  }

  // --- Editor pane ---

  function renderEditor(): void {
    const session = activeSession();
    if (!session) {
      editorEl.innerHTML = '<p class="empty-hint">Select a lead on the left, then click "New Draft" to start.</p>';
      return;
    }

    editorEl.innerHTML = `
      <input id="ew-subject" type="text" class="search-input ew-subject-input" placeholder="Subject" value="${escapeHtml(session.subject)}" />
      <div id="ew-toolbar" class="ew-toolbar">
        <button class="btn btn-ghost btn-sm" type="button" data-cmd="bold"><strong>B</strong></button>
        <button class="btn btn-ghost btn-sm" type="button" data-cmd="italic"><em>I</em></button>
        <button class="btn btn-ghost btn-sm" type="button" data-cmd="underline"><u>U</u></button>
        <button class="btn btn-ghost btn-sm" type="button" data-cmd="insertUnorderedList">• List</button>
        <button id="ew-variable-btn" class="btn btn-ghost btn-sm" type="button">{{ }} Insert Variable</button>
        <div id="ew-variable-popover" class="ew-variable-popover hidden"></div>
      </div>
      <div id="ew-body" class="ew-body-editor" contenteditable="true">${session.bodyHtml}</div>

      ${
        session.estimatedOpenRate !== null
          ? `<div class="ew-metrics">
               <span class="status-badge">Open ~${Math.round((session.estimatedOpenRate ?? 0) * 100)}%</span>
               <span class="status-badge">Reply ~${Math.round((session.estimatedReplyRate ?? 0) * 100)}%</span>
               <span class="status-badge">Readability ${Math.round(session.estimatedReadability ?? 0)}/100</span>
             </div>`
          : ""
      }

      <textarea id="ew-instruction" rows="2" placeholder="What should this email achieve? e.g. Introduce our recruitment services"></textarea>
      <div class="card-actions">
        <select id="ew-preset" class="inline-edit">
          ${EMAIL_PRESETS.map((p) => `<option value="${p}" ${p === session.preset ? "selected" : ""}>${p}</option>`).join("")}
        </select>
        <select id="ew-length" class="inline-edit">
          ${EMAIL_LENGTHS.map((l) => `<option value="${l}" ${l === session.length ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <button id="ew-generate-btn" class="btn btn-primary" type="button">${session.draftId ? "Regenerate" : "Generate"}</button>
        <span class="ew-cost-hint">~$0.02 per generation</span>
        ${session.draftId ? "" : `<button id="ew-write-manually-btn" class="btn btn-ghost" type="button">Write it myself</button>`}
        <span id="ew-generate-status" class="status-message"></span>
      </div>

      <div class="card-actions ew-quick-actions">
        <button class="btn btn-ghost btn-sm ew-quick-btn" type="button" data-instruction="Make this shorter">Shorter</button>
        <button class="btn btn-ghost btn-sm ew-quick-btn" type="button" data-instruction="Make this longer">Longer</button>
        <button class="btn btn-ghost btn-sm ew-quick-btn" type="button" data-instruction="Make this more persuasive">More Persuasive</button>
        <button class="btn btn-ghost btn-sm ew-quick-btn" type="button" data-instruction="Fix any grammar issues">Fix Grammar</button>
        <button class="btn btn-ghost btn-sm ew-quick-btn" type="button" data-instruction="Change the tone to be warmer and more human">Change Tone</button>
      </div>

      <div class="card-actions">
        <button id="ew-save-btn" class="btn btn-secondary btn-sm" type="button">Save Draft</button>
        <button id="ew-copy-btn" class="btn btn-secondary btn-sm" type="button">Copy</button>
        <button id="ew-template-btn" class="btn btn-secondary btn-sm" type="button">Save as Template</button>
        <button id="ew-apply-template-btn" class="btn btn-secondary btn-sm" type="button">Apply Template</button>
        <button id="ew-preview-btn" class="btn btn-primary btn-sm" type="button">Preview &amp; Send</button>
        <span id="ew-save-status" class="status-message"></span>
      </div>
      <div id="ew-template-list" class="hidden"></div>
    `;

    wireEditor(session);
  }

  function wireEditor(session: DraftSession): void {
    const subjectInput = document.querySelector<HTMLInputElement>("#ew-subject")!;
    const bodyEl = document.querySelector<HTMLDivElement>("#ew-body")!;
    const instructionInput = document.querySelector<HTMLTextAreaElement>("#ew-instruction")!;
    const presetSelect = document.querySelector<HTMLSelectElement>("#ew-preset")!;
    const lengthSelect = document.querySelector<HTMLSelectElement>("#ew-length")!;
    const generateBtn = document.querySelector<HTMLButtonElement>("#ew-generate-btn")!;
    const generateStatus = document.querySelector<HTMLSpanElement>("#ew-generate-status")!;
    const saveStatus = document.querySelector<HTMLSpanElement>("#ew-save-status")!;

    function markDirty(): void {
      session.subject = subjectInput.value;
      session.bodyHtml = sanitizeHtmlFragment(bodyEl.innerHTML);
      session.dirty = true;
      renderDraftTabs();
    }
    subjectInput.addEventListener("input", markDirty);
    bodyEl.addEventListener("input", markDirty);
    presetSelect.addEventListener("change", () => {
      session.preset = presetSelect.value as EmailPreset;
    });
    lengthSelect.addEventListener("change", () => {
      session.length = lengthSelect.value as EmailLength;
    });

    document.querySelectorAll<HTMLButtonElement>("#ew-toolbar [data-cmd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        bodyEl.focus();
        document.execCommand(btn.dataset.cmd!);
      });
    });

    const variableBtn = document.querySelector<HTMLButtonElement>("#ew-variable-btn")!;
    const variablePopover = document.querySelector<HTMLDivElement>("#ew-variable-popover")!;
    variableBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      variablePopover.innerHTML = VARIABLES.map(
        (v) => `<button class="btn btn-ghost btn-sm ew-variable-option" type="button" data-key="${v.key}">${escapeHtml(v.label)}</button>`
      ).join("");
      variablePopover.classList.toggle("hidden");
      variablePopover.querySelectorAll<HTMLButtonElement>(".ew-variable-option").forEach((opt) => {
        opt.addEventListener("click", () => {
          bodyEl.focus();
          document.execCommand("insertText", false, `{{${opt.dataset.key}}}`);
          variablePopover.classList.add("hidden");
          markDirty();
        });
      });
    });
    document.addEventListener("click", () => variablePopover.classList.add("hidden"), { once: true });

    async function doGenerate(instructionOverride?: string): Promise<void> {
      if (generatePending) return;
      generatePending = true;
      generateBtn.disabled = true;
      generateStatus.textContent = "Generating… this uses Anthropic credits.";
      try {
        const instruction = instructionOverride ?? instructionInput.value.trim();
        let updated: EmailDraft;
        if (session.draftId) {
          updated = await refineEmailDraft(session.draftId, instruction || "Refine this email.");
        } else {
          updated = await generateEmailDraft(session.leadId, instruction, session.preset, session.length);
        }
        session.draftId = updated.id;
        session.subject = updated.subject;
        session.bodyHtml = textToHtml(updated.body);
        session.estimatedOpenRate = updated.estimated_open_rate;
        session.estimatedReplyRate = updated.estimated_reply_rate;
        session.estimatedReadability = updated.estimated_readability_score;
        session.dirty = false;
        generateStatus.textContent = "";
        renderEditor();
        renderDraftTabs();
        void refreshTimeline();
      } catch (err) {
        generateStatus.textContent = `Failed: ${err}`;
      } finally {
        generatePending = false;
        generateBtn.disabled = false;
      }
    }

    generateBtn.addEventListener("click", () => void doGenerate());

    document.querySelector<HTMLButtonElement>("#ew-write-manually-btn")?.addEventListener("click", () => void (async () => {
      const btn = document.querySelector<HTMLButtonElement>("#ew-write-manually-btn")!;
      btn.disabled = true;
      try {
        const created = await createManualEmailDraft(session.leadId);
        session.draftId = created.id;
        // The server returns a blank draft — keep whatever the rep already
        // typed rather than letting that clobber it.
        session.subject = subjectInput.value;
        session.bodyHtml = sanitizeHtmlFragment(bodyEl.innerHTML);
        session.dirty = true;
        renderEditor();
        renderDraftTabs();
      } catch (err) {
        generateStatus.textContent = `Failed: ${err}`;
        btn.disabled = false;
      }
    })());

    document.querySelectorAll<HTMLButtonElement>(".ew-quick-btn").forEach((btn) => {
      btn.addEventListener("click", () => void doGenerate(btn.dataset.instruction));
    });

    document.querySelector("#ew-save-btn")!.addEventListener("click", () => void saveDraft());

    async function saveDraft(): Promise<void> {
      if (!session.draftId) {
        saveStatus.textContent = "Generate an email first before saving.";
        return;
      }
      saveStatus.textContent = "Saving...";
      try {
        await updateEmailDraft(session.draftId, { subject: session.subject, body: session.bodyHtml });
        session.dirty = false;
        renderDraftTabs();
        saveStatus.textContent = "Saved";
        setTimeout(() => {
          saveStatus.textContent = "";
        }, 1500);
      } catch (err) {
        saveStatus.textContent = `Failed to save: ${err}`;
      }
    }

    document.querySelector("#ew-copy-btn")!.addEventListener("click", async () => {
      await navigator.clipboard.writeText(bodyEl.innerText);
      saveStatus.textContent = "Copied to clipboard";
      setTimeout(() => {
        saveStatus.textContent = "";
      }, 1500);
    });

    document.querySelector("#ew-template-btn")!.addEventListener("click", () => openTemplateNameForm());

    function openTemplateNameForm(): void {
      const existing = document.querySelector("#ew-template-name-form");
      if (existing) return;
      const form = document.createElement("div");
      form.id = "ew-template-name-form";
      form.className = "new-list-form";
      form.innerHTML = `
        <input id="ew-template-name-input" type="text" class="search-input" placeholder="Template name" />
        <button id="ew-template-name-save-btn" class="btn btn-primary btn-sm" type="button">Save</button>
        <button id="ew-template-name-cancel-btn" class="btn btn-ghost btn-sm" type="button">Cancel</button>
      `;
      editorEl.appendChild(form);
      const nameInput = form.querySelector<HTMLInputElement>("#ew-template-name-input")!;
      nameInput.focus();
      form.querySelector("#ew-template-name-cancel-btn")!.addEventListener("click", () => form.remove());
      form.querySelector("#ew-template-name-save-btn")!.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        if (!name) return;
        await createEmailTemplate(name, session.subject, bodyEl.innerText, session.preset, session.length);
        await refreshTemplates();
        form.remove();
        saveStatus.textContent = "Template saved";
        setTimeout(() => {
          saveStatus.textContent = "";
        }, 1500);
      });
    }

    document.querySelector("#ew-apply-template-btn")!.addEventListener("click", () => {
      const listEl = document.querySelector<HTMLDivElement>("#ew-template-list")!;
      listEl.classList.toggle("hidden");
      if (listEl.classList.contains("hidden")) return;
      listEl.innerHTML =
        templates.length === 0
          ? '<p class="empty-hint">No saved templates yet.</p>'
          : `<ul class="history-list">${templates
              .map(
                (t) => `
              <li class="history-list-row">
                <span>${escapeHtml(t.name)}</span>
                <button class="btn btn-ghost btn-sm ew-apply-template-row-btn" type="button" data-id="${t.id}">Apply</button>
              </li>`
              )
              .join("")}</ul>`;
      listEl.querySelectorAll<HTMLButtonElement>(".ew-apply-template-row-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const applied = await applyEmailTemplate(btn.dataset.id!, session.leadId);
          session.subject = applied.subject;
          session.bodyHtml = textToHtml(applied.body);
          session.dirty = true;
          listEl.classList.add("hidden");
          renderEditor();
          renderDraftTabs();
        });
      });
    });

    document.querySelector("#ew-preview-btn")!.addEventListener("click", () => void openPreview(session));
  }

  // --- Preview overlay ---

  let previewSession: DraftSession | null = null;

  async function openPreview(session: DraftSession): Promise<void> {
    previewSession = session;
    const sendBtn = document.querySelector<HTMLButtonElement>("#ew-preview-send-btn")!;
    sendBtn.classList.remove("hidden");
    sendBtn.disabled = false;
    document.querySelector<HTMLButtonElement>("#ew-preview-edit-btn")!.classList.remove("hidden");
    document.querySelector<HTMLButtonElement>("#ew-preview-back-btn")!.classList.remove("hidden");
    document.querySelector<HTMLButtonElement>("#ew-preview-done-btn")!.classList.add("hidden");
    const lead = getLeads().find((l) => l.id === session.leadId);
    const to = lead?.emails[0]?.email ?? "";
    const accounts = await listEmailOAuthAccounts().catch(() => []);

    previewBodyEl.innerHTML = `
      <p class="empty-hint">
        From: ${accounts.length > 0 ? escapeHtml(accounts.map((a) => a.email_address).join(", ")) : "no email account connected"}
        · To: ${escapeHtml(to || "no email on file")} · ${escapeHtml(new Date().toLocaleString())}
      </p>
      <h3>${escapeHtml(session.subject)}</h3>
      <div class="ew-preview-content">${session.bodyHtml}</div>
      ${
        accounts.length > 1
          ? `<select id="ew-preview-provider-select" class="inline-edit">
               ${accounts.map((a) => `<option value="${a.provider}">${escapeHtml(a.provider)} (${escapeHtml(a.email_address)})</option>`).join("")}
             </select>`
          : ""
      }
      <span id="ew-preview-send-status" class="status-message"></span>
    `;
    previewOverlay.dataset.hasAccount = accounts.length > 0 ? accounts[0].provider : "";
    previewOverlay.classList.remove("hidden");
  }

  document.querySelector("#ew-preview-close-btn")!.addEventListener("click", () => previewOverlay.classList.add("hidden"));
  document.querySelector("#ew-preview-back-btn")!.addEventListener("click", () => previewOverlay.classList.add("hidden"));
  document.querySelector("#ew-preview-edit-btn")!.addEventListener("click", () => previewOverlay.classList.add("hidden"));
  document.querySelector("#ew-preview-done-btn")!.addEventListener("click", () => previewOverlay.classList.add("hidden"));
  document.querySelector("#ew-preview-send-btn")!.addEventListener("click", () => void handleSend());

  async function handleSend(): Promise<void> {
    const status = document.querySelector<HTMLSpanElement>("#ew-preview-send-status");
    if (!previewSession || !previewSession.draftId) {
      if (status) status.textContent = "Generate the email first.";
      return;
    }
    const providerSelect = document.querySelector<HTMLSelectElement>("#ew-preview-provider-select");
    const provider = (providerSelect?.value ?? previewOverlay.dataset.hasAccount) as "gmail" | "microsoft" | "";
    if (!provider) {
      if (status) status.textContent = "Connect a Gmail or Microsoft account in Settings to send real email.";
      return;
    }
    const sendBtn = document.querySelector<HTMLButtonElement>("#ew-preview-send-btn")!;
    sendBtn.disabled = true;
    if (status) status.textContent = "Sending...";
    try {
      const to = getLeads().find((l) => l.id === previewSession!.leadId)?.emails[0]?.email ?? "";
      await sendEmailDraft(previewSession.draftId, provider);
      previewSession.dirty = false;
      renderDraftTabs();
      showSentConfirmation(previewSession, to);
    } catch (err) {
      if (status) status.textContent = `Failed to send: ${err}`;
      sendBtn.disabled = false;
    }
  }

  function showSentConfirmation(session: DraftSession, to: string): void {
    previewBodyEl.innerHTML = `
      <div class="ew-sent-confirmation">
        <div class="ew-sent-check">&check;</div>
        <h3>Email sent</h3>
        <p class="empty-hint">To ${escapeHtml(to || "—")} &middot; ${escapeHtml(new Date().toLocaleString())}</p>
        <h4>${escapeHtml(session.subject)}</h4>
        <div class="ew-preview-content">${session.bodyHtml}</div>
      </div>
    `;
    document.querySelector<HTMLButtonElement>("#ew-preview-send-btn")!.classList.add("hidden");
    document.querySelector<HTMLButtonElement>("#ew-preview-edit-btn")!.classList.add("hidden");
    document.querySelector<HTMLButtonElement>("#ew-preview-back-btn")!.classList.add("hidden");
    document.querySelector<HTMLButtonElement>("#ew-preview-done-btn")!.classList.remove("hidden");
  }

  // --- AI Assistant pane ---

  function renderAssistant(): void {
    document.querySelectorAll<HTMLButtonElement>(".ew-assistant-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === assistantTab);
    });
    const session = activeSession();
    if (!session) {
      assistantContentEl.innerHTML = '<p class="empty-hint">Select a lead and start a draft to use the AI assistant.</p>';
      return;
    }
    if (assistantTab === "chat") renderChatTab(session);
    else if (assistantTab === "personalisation") renderPersonalisationTab(session);
    else renderCtaTab(session);
  }

  function renderChatTab(session: DraftSession): void {
    assistantContentEl.innerHTML = `
      <div id="ew-chat-messages" class="intel-chat-messages"></div>
      <div class="contact-add-row">
        <input id="ew-chat-input" type="text" class="search-input" placeholder="e.g. Mention their recent hiring activity" />
        <button id="ew-chat-send-btn" class="btn btn-secondary btn-sm" type="button">Send</button>
      </div>
      <span id="ew-chat-status" class="status-message"></span>
    `;
    const messagesEl = document.querySelector<HTMLDivElement>("#ew-chat-messages")!;
    messagesEl.innerHTML =
      session.chatHistory.length === 0
        ? '<p class="empty-hint">Ask the AI to adjust this email — e.g. "make it more persuasive" or "add urgency."</p>'
        : session.chatHistory
            .map(
              (t) =>
                `<div class="intel-chat-bubble intel-chat-${t.role}"><strong>${t.role === "user" ? "You" : "AI"}:</strong> ${escapeHtml(t.content)}</div>`
            )
            .join("");

    const input = document.querySelector<HTMLInputElement>("#ew-chat-input")!;
    const sendBtn = document.querySelector<HTMLButtonElement>("#ew-chat-send-btn")!;
    const status = document.querySelector<HTMLSpanElement>("#ew-chat-status")!;

    async function send(): Promise<void> {
      const message = input.value.trim();
      if (!message || generatePending) return;
      if (!session.draftId) {
        status.textContent = "Generate an email first, then refine it here.";
        return;
      }
      generatePending = true;
      input.value = "";
      sendBtn.disabled = true;
      status.textContent = "Thinking… this uses Anthropic credits.";
      session.chatHistory = [...session.chatHistory, { role: "user", content: message }];
      renderChatTab(session);
      try {
        const updated = await refineEmailDraft(session.draftId, message);
        session.subject = updated.subject;
        session.bodyHtml = textToHtml(updated.body);
        session.estimatedOpenRate = updated.estimated_open_rate;
        session.estimatedReplyRate = updated.estimated_reply_rate;
        session.estimatedReadability = updated.estimated_readability_score;
        session.chatHistory = [...session.chatHistory, { role: "assistant", content: "Updated the email." }];
        generatePending = false;
        renderEditor();
        renderDraftTabs();
        renderChatTab(session);
      } catch (err) {
        generatePending = false;
        status.textContent = `Failed: ${err}`;
      }
    }

    sendBtn.addEventListener("click", () => void send());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void send();
    });
  }

  function renderPersonalisationTab(session: DraftSession): void {
    assistantContentEl.innerHTML = `
      <div class="card-actions">
        <button id="ew-personalisation-btn" class="btn btn-secondary btn-sm" type="button">Generate Personalisation</button>
        <span id="ew-personalisation-status" class="status-message"></span>
      </div>
      <div id="ew-personalisation-results"></div>
    `;
    const resultsEl = document.querySelector<HTMLDivElement>("#ew-personalisation-results")!;
    const renderResults = () => {
      if (!personalisationOptions) {
        resultsEl.innerHTML = '<p class="empty-hint">Generate a few personalisation angles grounded in this lead\'s real data.</p>';
        return;
      }
      resultsEl.innerHTML = personalisationOptions
        .map(
          (o, i) => `
          <div class="ew-personalisation-option">
            <p><strong>Hook:</strong> ${escapeHtml(o.hook)}</p>
            <p><strong>Pain point:</strong> ${escapeHtml(o.pain_point_observation)}</p>
            <p><strong>Growth:</strong> ${escapeHtml(o.growth_observation)}</p>
            <p><strong>Opportunity:</strong> ${escapeHtml(o.opportunity_statement)}</p>
            <button class="btn btn-secondary btn-sm ew-insert-personalisation-btn" type="button" data-index="${i}">Insert</button>
          </div>`
        )
        .join("");
      resultsEl.querySelectorAll<HTMLButtonElement>(".ew-insert-personalisation-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const option = personalisationOptions![Number(btn.dataset.index)];
          const bodyEl = document.querySelector<HTMLDivElement>("#ew-body");
          if (bodyEl) {
            bodyEl.innerHTML = `<p>${escapeHtml(option.hook)}</p>` + bodyEl.innerHTML;
            session.bodyHtml = bodyEl.innerHTML;
            session.dirty = true;
            renderDraftTabs();
          }
        });
      });
    };
    renderResults();

    document.querySelector("#ew-personalisation-btn")!.addEventListener("click", async () => {
      const status = document.querySelector<HTMLSpanElement>("#ew-personalisation-status")!;
      status.textContent = "Generating… this uses Anthropic credits.";
      try {
        personalisationOptions = await generateEmailPersonalisation(session.leadId, 3);
        status.textContent = "";
        renderResults();
      } catch (err) {
        status.textContent = `Failed: ${err}`;
      }
    });
  }

  function renderCtaTab(session: DraftSession): void {
    assistantContentEl.innerHTML = `
      <input id="ew-cta-goal" type="text" class="search-input" placeholder="Goal, e.g. Book a discovery call" />
      <div class="card-actions">
        <button id="ew-cta-btn" class="btn btn-secondary btn-sm" type="button">Suggest CTAs</button>
        <span id="ew-cta-status" class="status-message"></span>
      </div>
      <div id="ew-cta-results"></div>
    `;
    const resultsEl = document.querySelector<HTMLDivElement>("#ew-cta-results")!;
    const renderResults = () => {
      resultsEl.innerHTML = !ctaSuggestions
        ? '<p class="empty-hint">Get CTA suggestions tailored to your goal and this lead.</p>'
        : ctaSuggestions
            .map(
              (cta, i) =>
                `<button class="btn btn-ghost btn-sm ew-insert-cta-btn" type="button" data-index="${i}">${escapeHtml(cta)}</button>`
            )
            .join("");
      resultsEl.querySelectorAll<HTMLButtonElement>(".ew-insert-cta-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const cta = ctaSuggestions![Number(btn.dataset.index)];
          const bodyEl = document.querySelector<HTMLDivElement>("#ew-body");
          if (bodyEl) {
            bodyEl.innerHTML += `<p>${escapeHtml(cta)}</p>`;
            session.bodyHtml = bodyEl.innerHTML;
            session.dirty = true;
            renderDraftTabs();
          }
        });
      });
    };
    renderResults();

    document.querySelector("#ew-cta-btn")!.addEventListener("click", async () => {
      const goalInput = document.querySelector<HTMLInputElement>("#ew-cta-goal")!;
      const status = document.querySelector<HTMLSpanElement>("#ew-cta-status")!;
      status.textContent = "Generating… this uses Anthropic credits.";
      try {
        ctaSuggestions = await getEmailCtaSuggestions(session.leadId, goalInput.value.trim() || "Book a call");
        status.textContent = "";
        renderResults();
      } catch (err) {
        status.textContent = `Failed: ${err}`;
      }
    });
  }

  document.querySelectorAll<HTMLButtonElement>(".ew-assistant-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      assistantTab = btn.dataset.tab as "chat" | "personalisation" | "cta";
      renderAssistant();
    });
  });

  // --- Timeline pane ---

  async function refreshTimeline(): Promise<void> {
    const session = activeSession();
    if (!session) {
      timelineListEl.innerHTML = "";
      timelineEmptyEl.classList.remove("hidden");
      return;
    }
    const entries: TimelineEntry[] = await getLeadTimeline(session.leadId);
    if (entries.length === 0) {
      timelineListEl.innerHTML = "";
      timelineEmptyEl.classList.remove("hidden");
      return;
    }
    timelineEmptyEl.classList.add("hidden");
    timelineListEl.innerHTML = entries
      .map(
        (e) => `
        <li class="history-list-row">
          <span class="empty-hint">${escapeHtml(new Date(e.timestamp).toLocaleString())}</span>
          <span>${escapeHtml(e.summary)}</span>
        </li>`
      )
      .join("");
  }

  // --- Templates / Brand voice loading ---

  async function refreshTemplates(): Promise<void> {
    templates = await listEmailTemplates();
  }

  // --- Global render + autosave ---

  function renderAll(): void {
    renderLeadPane();
    renderDraftTabs();
    renderEditor();
    renderAssistant();
  }

  document.querySelector("#ew-preview-overlay")!.addEventListener("click", (event) => {
    if (event.target === previewOverlay) previewOverlay.classList.add("hidden");
  });

  setInterval(() => {
    const session = activeSession();
    if (session && session.dirty && session.draftId) {
      void updateEmailDraft(session.draftId, { subject: session.subject, body: session.bodyHtml }).then(() => {
        session.dirty = false;
        renderDraftTabs();
      });
    }
  }, 5000);

  document.addEventListener("keydown", (event) => {
    if (!container.closest("body") || container.style.display === "none") return;
    const isMeta = event.metaKey || event.ctrlKey;
    if (isMeta && event.key === "Enter") {
      event.preventDefault();
      document.querySelector<HTMLButtonElement>("#ew-generate-btn")?.click();
    } else if (isMeta && event.key === "s") {
      event.preventDefault();
      document.querySelector<HTMLButtonElement>("#ew-save-btn")?.click();
    }
  });

  subscribe(renderLeadPane);

  void (async () => {
    brandVoice = await getBrandVoice().catch(() => null);
    void brandVoice;
    await refreshTemplates();
  })();

  renderAll();

  return { focusLead: selectLeadForActiveSession };
}
