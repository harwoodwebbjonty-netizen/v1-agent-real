import {
  type ChatTurn,
  type Lead,
  type LeadIntelligenceVersion,
  chatAboutLead,
  generateLeadIntelligence,
  getLeadIntelligenceHistory,
  lookupCompanyPhone,
} from "../api";
import { formatDate, reportBodyHtml, temperatureClass } from "../components/sidePanel";
import { getLeads, refreshLeads, subscribe } from "../state";
import { escapeHtml } from "../utils";

export function initSalesIntelligence(): void {
  const container = document.querySelector<HTMLDivElement>("#view-sales-intelligence")!;
  container.innerHTML = `
    <main class="container">
      <section class="card">
        <h2 class="card-title">AI Sales Intelligence</h2>
        <p class="card-subtitle">Search a company, browse existing intelligence, and ask follow-up questions.</p>
        <div class="card-actions">
          <input id="intel-search-input" type="text" class="search-input" placeholder="Search a company..." />
          <button id="intel-search-btn" class="btn btn-primary">Look up</button>
          <span id="intel-search-status" class="status-message"></span>
        </div>
      </section>

      <div class="intel-screen-layout">
        <section class="card intel-leads-list-card">
          <h2 class="card-title">Leads with Intelligence</h2>
          <ul id="intel-leads-list" class="history-list"></ul>
          <p id="intel-leads-empty" class="empty-state hidden">
            No leads have AI intelligence yet — search a company above, or generate it from an existing lead.
          </p>
        </section>

        <section class="card intel-workspace-card">
          <div id="intel-workspace">
            <p class="empty-hint">Select a lead from the list, or search a company above.</p>
          </div>
        </section>
      </div>
    </main>
  `;

  const searchInput = document.querySelector<HTMLInputElement>("#intel-search-input")!;
  const searchBtn = document.querySelector<HTMLButtonElement>("#intel-search-btn")!;
  const searchStatus = document.querySelector<HTMLSpanElement>("#intel-search-status")!;
  const leadsListEl = document.querySelector<HTMLUListElement>("#intel-leads-list")!;
  const leadsEmptyEl = document.querySelector<HTMLParagraphElement>("#intel-leads-empty")!;
  const workspaceEl = document.querySelector<HTMLDivElement>("#intel-workspace")!;

  let selectedLeadId: string | null = null;
  let intelHistory: LeadIntelligenceVersion[] | null = null;
  let viewingVersionId: string | null = null;
  let onCooldown = false;
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  let chatHistory: ChatTurn[] = [];
  let chatPending = false;

  function leadsWithIntelligence(): Lead[] {
    return getLeads()
      .filter((l) => l.intelligence !== null)
      .sort((a, b) => b.intelligence!.lead_score - a.intelligence!.lead_score);
  }

  function renderLeadsList(): void {
    const leads = leadsWithIntelligence();
    if (leads.length === 0) {
      leadsListEl.innerHTML = "";
      leadsEmptyEl.classList.remove("hidden");
      return;
    }
    leadsEmptyEl.classList.add("hidden");
    leadsListEl.innerHTML = leads
      .map(
        (l) => `
        <li class="history-list-row intel-lead-row ${l.id === selectedLeadId ? "active" : ""}" data-lead-id="${escapeHtml(l.id)}">
          <span>${escapeHtml(l.company)}</span>
          <span class="status-badge ${temperatureClass(l.intelligence!.lead_temperature)}">${escapeHtml(l.intelligence!.lead_temperature)} · ${l.intelligence!.lead_score}/100</span>
        </li>`
      )
      .join("");
    leadsListEl.querySelectorAll<HTMLLIElement>(".intel-lead-row").forEach((row) => {
      row.addEventListener("click", () => selectLead(row.dataset.leadId!));
    });
  }

  function selectLead(leadId: string): void {
    selectedLeadId = leadId;
    intelHistory = null;
    viewingVersionId = null;
    chatHistory = [];
    renderLeadsList();
    renderWorkspace();
  }

  function renderWorkspace(): void {
    const lead = getLeads().find((l) => l.id === selectedLeadId);
    if (!lead) {
      workspaceEl.innerHTML = '<p class="empty-hint">Select a lead from the list, or search a company above.</p>';
      return;
    }

    if (!lead.intelligence) {
      workspaceEl.innerHTML = `
        <h3>${escapeHtml(lead.company)}</h3>
        <p class="empty-hint">No AI intelligence generated yet for this lead.</p>
        <div class="card-actions">
          <button id="intel-generate-btn" class="btn btn-secondary btn-sm">Generate AI Intelligence</button>
          <span id="intel-generate-status" class="status-message"></span>
        </div>
      `;
      wireGenerateButton(lead);
      return;
    }

    const intel = lead.intelligence;
    const viewing = viewingVersionId ? intelHistory?.find((v) => v.id === viewingVersionId) ?? null : null;
    const report = viewing ?? intel;

    workspaceEl.innerHTML = `
      <h3>${escapeHtml(lead.company)}</h3>
      ${
        viewing
          ? `<div class="intel-history-banner">
               Viewing version from ${escapeHtml(formatDate(viewing.created_at))} — not the latest.
               <button id="intel-back-to-latest-btn" class="btn btn-ghost btn-sm">Back to latest</button>
             </div>`
          : ""
      }
      ${reportBodyHtml(report)}
      <p class="empty-hint">Generated ${escapeHtml(formatDate(intel.generated_at))} · Updated ${escapeHtml(formatDate(intel.updated_at))}</p>
      <div class="card-actions">
        <button id="intel-generate-btn" class="btn btn-secondary btn-sm">Refresh AI Intelligence</button>
        <span id="intel-generate-status" class="status-message"></span>
      </div>
      ${
        intel.version_count > 1
          ? `<button id="intel-toggle-history-btn" class="btn btn-ghost btn-sm">
               ${intelHistory ? "Hide" : "View"} history (${intel.version_count} versions)
             </button>
             <ul id="intel-history-list" class="history-list ${intelHistory ? "" : "hidden"}"></ul>`
          : ""
      }

      <h4>Ask Questions</h4>
      <div id="intel-chat-section"></div>
    `;

    wireGenerateButton(lead);

    document.querySelector("#intel-back-to-latest-btn")?.addEventListener("click", () => {
      viewingVersionId = null;
      renderWorkspace();
    });

    document.querySelector("#intel-toggle-history-btn")?.addEventListener("click", async () => {
      if (intelHistory) {
        intelHistory = null;
        renderWorkspace();
        return;
      }
      intelHistory = await getLeadIntelligenceHistory(lead.id);
      renderWorkspace();
    });

    if (intelHistory) {
      const listEl = document.querySelector("#intel-history-list")!;
      listEl.innerHTML = intelHistory
        .map(
          (v) => `
          <li class="history-list-row">
            <span>${escapeHtml(formatDate(v.created_at))} — ${escapeHtml(v.lead_temperature)} · ${v.lead_score}/100</span>
            <button class="btn btn-ghost btn-sm intel-view-version-btn" data-version-id="${escapeHtml(v.id)}">View</button>
          </li>`
        )
        .join("");
      listEl.querySelectorAll<HTMLButtonElement>(".intel-view-version-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          viewingVersionId = btn.dataset.versionId!;
          renderWorkspace();
        });
      });
    }

    renderChat(lead);
  }

  function chatContextFor(lead: Lead): string {
    const intel = lead.intelligence;
    return JSON.stringify({
      company: lead.company,
      industry: lead.industry || "Uncategorized",
      status: lead.status,
      executive_summary: intel?.executive_summary ?? "",
      sales_summary: intel?.sales_summary ?? "",
      pain_points: intel?.pain_points ?? null,
      buying_signals: intel?.buying_signals ?? [],
      lead_score: intel?.lead_score ?? null,
      lead_temperature: intel?.lead_temperature ?? null,
    });
  }

  function renderChat(lead: Lead): void {
    const chatEl = document.querySelector<HTMLDivElement>("#intel-chat-section")!;
    chatEl.innerHTML = `
      <div id="intel-chat-messages" class="intel-chat-messages"></div>
      <div class="contact-add-row">
        <input id="intel-chat-input" type="text" class="search-input" placeholder="Ask a question about this lead..." ${chatPending ? "disabled" : ""} />
        <button id="intel-chat-send-btn" class="btn btn-secondary btn-sm" ${chatPending ? "disabled" : ""}>Send</button>
      </div>
      <span id="intel-chat-status" class="status-message"></span>
    `;

    const messagesEl = document.querySelector<HTMLDivElement>("#intel-chat-messages")!;
    if (chatHistory.length === 0) {
      messagesEl.innerHTML = '<p class="empty-hint">Ask anything about this lead — answers are based only on its researched intelligence, no actions are taken.</p>';
    } else {
      messagesEl.innerHTML = chatHistory
        .map(
          (turn) =>
            `<div class="intel-chat-bubble intel-chat-${turn.role}"><strong>${turn.role === "user" ? "You" : "AI"}:</strong> ${escapeHtml(turn.content)}</div>`
        )
        .join("");
    }

    const input = document.querySelector<HTMLInputElement>("#intel-chat-input")!;
    const sendBtn = document.querySelector<HTMLButtonElement>("#intel-chat-send-btn")!;
    const status = document.querySelector<HTMLSpanElement>("#intel-chat-status")!;

    async function send(): Promise<void> {
      const message = input.value.trim();
      if (!message || chatPending) return;
      chatPending = true;
      input.value = "";
      input.disabled = true;
      sendBtn.disabled = true;
      status.textContent = "Thinking… this uses Anthropic credits.";
      chatHistory = [...chatHistory, { role: "user", content: message }];
      renderChatMessagesOnly();

      try {
        const reply = await chatAboutLead(chatContextFor(lead), message, chatHistory.slice(0, -1));
        chatHistory = [...chatHistory, { role: "assistant", content: reply }];
        status.textContent = "";
      } catch (err) {
        status.textContent = `Failed to get a reply: ${err}`;
      } finally {
        chatPending = false;
        renderChat(lead);
      }
    }

    function renderChatMessagesOnly(): void {
      messagesEl.innerHTML = chatHistory
        .map(
          (turn) =>
            `<div class="intel-chat-bubble intel-chat-${turn.role}"><strong>${turn.role === "user" ? "You" : "AI"}:</strong> ${escapeHtml(turn.content)}</div>`
        )
        .join("");
    }

    sendBtn.addEventListener("click", () => void send());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void send();
    });
  }

  function wireGenerateButton(lead: Lead): void {
    const btn = document.querySelector<HTMLButtonElement>("#intel-generate-btn")!;
    btn.disabled = onCooldown;
    btn.addEventListener("click", () => void handleGenerateClick(lead));
  }

  async function handleGenerateClick(lead: Lead): Promise<void> {
    onCooldown = true;
    if (cooldownTimer) clearTimeout(cooldownTimer);
    const btn = document.querySelector<HTMLButtonElement>("#intel-generate-btn");
    const status = document.querySelector<HTMLSpanElement>("#intel-generate-status");
    if (btn) btn.disabled = true;
    if (status) {
      status.textContent = "Researching… this uses more Anthropic credits than other lookups and may take up to a minute.";
    }

    try {
      await generateLeadIntelligence(lead.id);
      await refreshLeads();
      viewingVersionId = null;
      intelHistory = null;
      cooldownTimer = setTimeout(() => {
        onCooldown = false;
        const freshBtn = document.querySelector<HTMLButtonElement>("#intel-generate-btn");
        if (freshBtn) freshBtn.disabled = false;
      }, 20000);
    } catch (err) {
      onCooldown = false;
      const freshStatus = document.querySelector<HTMLSpanElement>("#intel-generate-status");
      if (freshStatus) freshStatus.textContent = String(err);
      const freshBtn = document.querySelector<HTMLButtonElement>("#intel-generate-btn");
      if (freshBtn) freshBtn.disabled = false;
    }
  }

  searchBtn.addEventListener("click", async () => {
    const company = searchInput.value.trim();
    if (!company) return;
    searchBtn.disabled = true;
    searchStatus.textContent = `Looking up ${company}...`;
    try {
      await lookupCompanyPhone(company);
      await refreshLeads();
      const newest = getLeads()[getLeads().length - 1];
      if (newest && newest.company === company) {
        selectLead(newest.id);
      }
      searchStatus.textContent = "";
      searchInput.value = "";
    } catch (err) {
      searchStatus.textContent = `Error looking up ${company}: ${err}`;
    } finally {
      searchBtn.disabled = false;
    }
  });

  subscribe(() => {
    renderLeadsList();
    if (selectedLeadId) renderWorkspace();
  });

  renderLeadsList();
}
