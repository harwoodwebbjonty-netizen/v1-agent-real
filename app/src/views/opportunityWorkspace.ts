import {
  type CallLog,
  type Lead,
  type LeadIntelligenceVersion,
  type OpportunityStage,
  type TimelineEntry,
  createCallLog,
  createCalendarEvent,
  generateLeadIntelligence,
  getLeadIntelligenceHistory,
  getLeadTimeline,
  listCallLogs,
  listEmailDrafts,
  updateLead,
  type CallOutcome,
  type EmailDraft,
} from "../api";
import { getEvents, refreshCalendarEvents, subscribeCalendarEvents, type CalendarEvent } from "../calendarEvents";
import { reportBodyHtml } from "../components/sidePanel";
import { setPendingEmailWriterLead } from "../emailWriterHandoff";
import { consumePendingOpportunityWorkspaceLead } from "../opportunityWorkspaceHandoff";
import { getLeads, hasLoadedLeads, refreshLeads, subscribe } from "../state";
import { getActiveTabId, openTab, subscribeTabs } from "../tabs";
import { showToast } from "../toast";
import { escapeHtml, skeletonBlockHtml } from "../utils";

const STAGE_LABELS: Record<OpportunityStage, string> = {
  none: "Not an opportunity yet",
  engaged: "Engaged",
  opportunity: "Opportunity",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

// Column order for the kanban board — deliberately excludes "none" (not yet
// an opportunity; those leads live on the Leads screen, not here).
const KANBAN_STAGES: OpportunityStage[] = ["engaged", "opportunity", "proposal", "won", "lost"];

const OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected: "Connected",
  voicemail: "Voicemail",
  no_answer: "No answer",
  wrong_number: "Wrong number",
  other: "Other",
};

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+0-9]/g, "")}`;
}

function activeOpportunities(): Lead[] {
  return getLeads()
    .filter((l) => l.opportunity_stage !== "none")
    .sort((a, b) => a.opportunity_stage.localeCompare(b.opportunity_stage));
}

export function initOpportunityWorkspace(): void {
  const container = document.querySelector<HTMLDivElement>("#view-opportunity-workspace")!;
  let selectedLeadId: string | null = null;
  let callLogs: CallLog[] = [];
  let drafts: EmailDraft[] = [];
  let intelHistory: LeadIntelligenceVersion[] = [];
  let timeline: TimelineEntry[] = [];

  async function moveLeadToStage(leadId: string, stage: OpportunityStage): Promise<void> {
    const lead = getLeads().find((l) => l.id === leadId);
    if (!lead || lead.opportunity_stage === stage) return;
    await updateLead(leadId, { opportunityStage: stage });
    await refreshLeads();
    showToast(`${lead.company} moved to ${STAGE_LABELS[stage]}`);
  }

  function renderList(): void {
    if (!hasLoadedLeads()) {
      container.innerHTML = `<main class="container">${skeletonBlockHtml(4)}</main>`;
      return;
    }

    const opportunities = activeOpportunities();

    if (!opportunities.length) {
      container.innerHTML = `
        <main class="container">
          <section class="card-title-row">
            <h2 class="card-title">Opportunities</h2>
          </section>
          <p class="card-subtitle">Active deals — click into one for its full working environment.</p>
          <p class="empty-hint">No active opportunities yet. Move a lead to Opportunity from its Next Best Action.</p>
        </main>
      `;
      return;
    }

    const columnsHtml = KANBAN_STAGES.map((stage) => {
      const cardsInStage = opportunities.filter((l) => l.opportunity_stage === stage);
      return `
        <div class="kanban-column" data-stage="${stage}">
          <div class="kanban-column-head">
            <span class="kanban-column-title">${escapeHtml(STAGE_LABELS[stage])}</span>
            <span class="kanban-column-count">${cardsInStage.length}</span>
          </div>
          <div class="kanban-column-body" data-stage="${stage}">
            ${
              cardsInStage.length
                ? cardsInStage
                    .map(
                      (lead) => `
              <div class="kanban-card" draggable="true" data-lead-id="${escapeHtml(lead.id)}">
                <span class="kanban-card-company">${escapeHtml(lead.company)}</span>
                ${lead.industry ? `<span class="kanban-card-meta">${escapeHtml(lead.industry)}</span>` : ""}
                <button type="button" class="btn btn-ghost btn-sm kanban-card-open-btn">Open &rarr;</button>
              </div>`
                    )
                    .join("")
                : `<p class="kanban-column-empty">Drop a card here</p>`
            }
          </div>
        </div>`;
    }).join("");

    container.innerHTML = `
      <main class="container">
        <section class="card-title-row">
          <h2 class="card-title">Opportunities</h2>
        </section>
        <p class="card-subtitle">Active deals — drag a card to change its stage, or open one for its full working environment.</p>
        <div class="kanban-board">${columnsHtml}</div>
      </main>
    `;

    container.querySelectorAll<HTMLButtonElement>(".kanban-card-open-btn").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const card = btn.closest<HTMLElement>(".kanban-card")!;
        openWorkspace(card.dataset.leadId!);
      });
    });

    container.querySelectorAll<HTMLElement>(".kanban-card").forEach((card) => {
      card.addEventListener("dragstart", (ev) => {
        ev.dataTransfer?.setData("text/plain", card.dataset.leadId!);
        ev.dataTransfer!.effectAllowed = "move";
        card.classList.add("kanban-card-dragging");
      });
      card.addEventListener("dragend", () => card.classList.remove("kanban-card-dragging"));
    });

    container.querySelectorAll<HTMLElement>(".kanban-column-body").forEach((columnBody) => {
      columnBody.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        ev.dataTransfer!.dropEffect = "move";
        columnBody.classList.add("kanban-column-drop-target");
      });
      columnBody.addEventListener("dragleave", () => columnBody.classList.remove("kanban-column-drop-target"));
      columnBody.addEventListener("drop", (ev) => {
        ev.preventDefault();
        columnBody.classList.remove("kanban-column-drop-target");
        const leadId = ev.dataTransfer?.getData("text/plain");
        const stage = columnBody.dataset.stage as OpportunityStage;
        if (leadId) void moveLeadToStage(leadId, stage);
      });
    });
  }

  function openWorkspace(leadId: string): void {
    selectedLeadId = leadId;
    void loadAndRenderDetail();
  }

  async function loadAndRenderDetail(): Promise<void> {
    const lead = getLeads().find((l) => l.id === selectedLeadId);
    if (!lead) {
      selectedLeadId = null;
      renderList();
      return;
    }
    [callLogs, drafts, intelHistory, timeline] = await Promise.all([
      listCallLogs(lead.id),
      listEmailDrafts(lead.id),
      getLeadIntelligenceHistory(lead.id),
      getLeadTimeline(lead.id),
    ]);
    renderDetail(lead);
  }

  function renderDetail(lead: Lead): void {
    const events = getEvents().filter((e) => e.lead_id === lead.id);
    const intel = lead.intelligence;

    container.innerHTML = `
      <main class="container">
        <button type="button" class="btn btn-ghost btn-sm" id="ow-back-btn">&larr; All Opportunities</button>

        <section class="card">
          <div class="call-queue-card-header">
            <div>
              <h2 class="call-queue-company">${escapeHtml(lead.company)}</h2>
              <div class="call-queue-meta">
                ${lead.industry ? `<span>${escapeHtml(lead.industry)}</span>` : ""}
                ${lead.website ? `<a href="${escapeHtml(lead.website)}" target="_blank" rel="noopener">${escapeHtml(lead.website)}</a>` : ""}
                ${intel ? `<span class="status-badge intel-${intel.lead_temperature.toLowerCase()}">${intel.lead_temperature} · ${intel.lead_score}</span>` : ""}
              </div>
            </div>
            <a class="btn btn-primary" href="${telHref(lead.phone_number)}">Start Call · ${escapeHtml(lead.phone_number)}</a>
          </div>
          <div class="card-actions">
            <label class="empty-hint" for="ow-stage-select">Stage</label>
            <select id="ow-stage-select" class="inline-edit">
              ${Object.entries(STAGE_LABELS)
                .filter(([value]) => value !== "none")
                .map(([value, label]) => `<option value="${value}" ${lead.opportunity_stage === value ? "selected" : ""}>${label}</option>`)
                .join("")}
            </select>
            <button type="button" class="btn btn-ghost btn-sm" id="ow-email-btn">Generate Email</button>
            <button type="button" class="btn btn-ghost btn-sm" id="ow-followup-btn">Create Follow-up (+3 days)</button>
          </div>
        </section>

        <section class="card">
          <h3 class="action-section-title">Notes</h3>
          <textarea id="ow-notes" rows="3">${escapeHtml(lead.lead_notes)}</textarea>
          <div class="card-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="ow-save-notes-btn">Save Notes</button>
          </div>
        </section>

        <section class="card">
          <h3 class="action-section-title">Log a Call</h3>
          <form id="ow-call-form" class="call-outcome-form">
            <div class="call-outcome-row">
              <select class="inline-edit" id="ow-outcome-select" required>
                <option value="" disabled selected>Outcome...</option>
                ${Object.entries(OUTCOME_LABELS)
                  .map(([value, label]) => `<option value="${value}">${label}</option>`)
                  .join("")}
              </select>
              <input type="number" min="0" class="search-input" id="ow-duration-input" placeholder="Duration (min)" />
            </div>
            <textarea id="ow-call-notes" rows="2" placeholder="What happened?"></textarea>
            <div class="card-actions">
              <button type="submit" class="btn btn-secondary btn-sm">Save Call</button>
            </div>
          </form>
          ${
            callLogs.length
              ? `<ul class="history-list" style="margin-top: var(--space-3)">${callLogs
                  .map(
                    (c) => `<li class="history-list-row"><span class="history-time">${escapeHtml(new Date(c.created_at).toLocaleString())}</span><span>${escapeHtml(OUTCOME_LABELS[c.outcome])}${c.notes ? " — " + escapeHtml(c.notes) : ""}</span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="empty-hint">No calls logged yet.</p>`
          }
        </section>

        <section class="card">
          <h3 class="action-section-title">Emails</h3>
          ${
            drafts.length
              ? `<ul class="history-list">${drafts
                  .map(
                    (d) => `<li class="history-list-row"><span>${escapeHtml(d.subject || "(no subject)")}</span><span class="status-badge ${d.status === "sent" ? "verified" : "unverified"}">${escapeHtml(d.status)}</span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="empty-hint">No drafts yet for this lead.</p>`
          }
        </section>

        <section class="card">
          <h3 class="action-section-title">Tasks &amp; Follow-ups</h3>
          ${
            events.length
              ? `<ul class="history-list">${events
                  .map(
                    (e: CalendarEvent) => `<li class="history-list-row"><span class="history-time">${escapeHtml(e.date)} ${escapeHtml(e.time)}</span><span>${escapeHtml(e.title)}</span><span class="status-badge cal-type-${e.type}">${escapeHtml(e.type)}</span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="empty-hint">Nothing scheduled for this lead.</p>`
          }
        </section>

        <section class="card">
          <h3 class="action-section-title">AI Insights</h3>
          ${
            intel
              ? reportBodyHtml(intel) + `<p class="empty-hint" style="margin-top:var(--space-3)">${intelHistory.length} version(s) generated</p>`
              : `<p class="empty-hint">No AI Sales Intelligence generated yet.</p><button type="button" class="btn btn-secondary btn-sm" id="ow-research-btn">Generate Research</button>`
          }
        </section>

        <section class="card">
          <h3 class="action-section-title">Timeline</h3>
          ${
            timeline.length
              ? `<ul class="history-list">${timeline
                  .map(
                    (t) => `<li class="history-list-row"><span class="history-time">${escapeHtml(new Date(t.timestamp).toLocaleString())}</span><span>${escapeHtml(t.summary)}</span></li>`
                  )
                  .join("")}</ul>`
              : `<p class="empty-hint">No activity recorded yet.</p>`
          }
        </section>
      </main>
    `;

    container.querySelector<HTMLButtonElement>("#ow-back-btn")!.addEventListener("click", () => {
      selectedLeadId = null;
      renderList();
    });

    container.querySelector<HTMLSelectElement>("#ow-stage-select")!.addEventListener("change", async (ev) => {
      const value = (ev.target as HTMLSelectElement).value as OpportunityStage;
      await updateLead(lead.id, { opportunityStage: value });
      await refreshLeads();
      showToast(`Stage updated to ${STAGE_LABELS[value]}`);
    });

    container.querySelector<HTMLButtonElement>("#ow-email-btn")!.addEventListener("click", () => {
      setPendingEmailWriterLead(lead.id);
      openTab("outreach", "Outreach");
    });

    container.querySelector<HTMLButtonElement>("#ow-followup-btn")!.addEventListener("click", async (ev) => {
      const btn = ev.target as HTMLButtonElement;
      btn.disabled = true;
      try {
        const followUpDate = new Date();
        followUpDate.setDate(followUpDate.getDate() + 3);
        await createCalendarEvent(`Follow up: ${lead.company}`, followUpDate.toISOString().slice(0, 10), "", "followup", lead.id);
        await refreshCalendarEvents();
        showToast("Follow-up created for 3 days from now");
      } finally {
        btn.disabled = false;
      }
    });

    container.querySelector<HTMLButtonElement>("#ow-save-notes-btn")!.addEventListener("click", async () => {
      const notes = container.querySelector<HTMLTextAreaElement>("#ow-notes")!.value;
      await updateLead(lead.id, { leadNotes: notes });
      await refreshLeads();
      showToast("Notes saved");
    });

    container.querySelector<HTMLFormElement>("#ow-call-form")!.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const outcome = container.querySelector<HTMLSelectElement>("#ow-outcome-select")!.value as CallOutcome;
      const notes = container.querySelector<HTMLTextAreaElement>("#ow-call-notes")!.value.trim();
      const durationMin = container.querySelector<HTMLInputElement>("#ow-duration-input")!.value;
      await createCallLog(lead.id, outcome, notes, durationMin ? Number(durationMin) * 60 : undefined);
      showToast("Call logged");
      await loadAndRenderDetail();
    });

    container.querySelector<HTMLButtonElement>("#ow-research-btn")?.addEventListener("click", async (ev) => {
      const btn = ev.target as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Generating...";
      try {
        await generateLeadIntelligence(lead.id);
        await refreshLeads();
        await loadAndRenderDetail();
      } catch (err) {
        showToast(`Research failed: ${err}`);
        btn.disabled = false;
        btn.textContent = "Generate Research";
      }
    });
  }

  function render(): void {
    if (selectedLeadId) {
      const lead = getLeads().find((l) => l.id === selectedLeadId);
      if (lead) {
        renderDetail(lead);
        return;
      }
    }
    renderList();
  }

  function checkPendingHandoff(): void {
    const pendingLeadId = consumePendingOpportunityWorkspaceLead();
    if (pendingLeadId) openWorkspace(pendingLeadId);
  }

  subscribeTabs(() => {
    if (getActiveTabId() === "opportunity-workspace") checkPendingHandoff();
  });
  subscribe(render);
  subscribeCalendarEvents(render);

  renderList();
}
