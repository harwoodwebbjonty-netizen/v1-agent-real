import {
  type Lead,
  addLeadEmail,
  addLeadPhone,
  assignLead,
  deleteLeadEmail,
  deleteLeadPhone,
  generateLeadIntelligence,
  listPendingEmailDrafts,
  scrapeLeadEmail,
  updateLead,
  updateLeadEmail,
  updateLeadPhone,
  type PendingEmailDraft,
} from "../api";
import { getEvents, refreshCalendarEvents, subscribeCalendarEvents, type CalendarEvent } from "../calendarEvents";
import {
  openSidePanel,
  refreshIfOpen,
  setSidePanelCallbacks,
  setTeamMembers,
  type SidePanelCallbacks,
} from "../components/sidePanel";
import { setPendingEmailWriterLead } from "../emailWriterHandoff";
import { setPendingOpportunityWorkspaceLead } from "../opportunityWorkspaceHandoff";
import { getLeads, refreshLeads, subscribe } from "../state";
import { getTeamMembers, refreshTeamMembers, subscribeTeam } from "../team";
import { openTab } from "../tabs";
import { showToast } from "../toast";
import { escapeHtml } from "../utils";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function callsDueToday(): { event: CalendarEvent; lead: Lead }[] {
  const today = todayIso();
  const leads = getLeads();
  return getEvents()
    .filter((e) => e.type === "call" && e.date <= today && e.lead_id)
    .map((event) => ({ event, lead: leads.find((l) => l.id === event.lead_id) }))
    .filter((x): x is { event: CalendarEvent; lead: Lead } => !!x.lead);
}

function followUpsDue(): Lead[] {
  const today = todayIso();
  const overdueFollowUpLeadIds = new Set(
    getEvents()
      .filter((e) => e.type === "followup" && e.date <= today && e.lead_id)
      .map((e) => e.lead_id!)
  );
  return getLeads().filter(
    (l) => l.next_best_action.action === "Send follow-up email" || overdueFollowUpLeadIds.has(l.id)
  );
}

function companiesNeedingResearch(): Lead[] {
  return getLeads().filter(
    (l) => l.next_best_action.action === "Generate research" || l.next_best_action.action === "Verify phone"
  );
}

function opportunitiesInProgress(): Lead[] {
  return getLeads()
    .filter((l) => ["engaged", "opportunity", "proposal"].includes(l.opportunity_stage))
    .sort((a, b) => a.opportunity_stage.localeCompare(b.opportunity_stage));
}

function recentlyReplied(): Lead[] {
  return getLeads().filter((l) => l.contact_status === "Replied");
}

export function initActionCentre(): void {
  const container = document.querySelector<HTMLDivElement>("#view-action-centre")!;
  container.innerHTML = `
    <main class="container">
      <section class="card-title-row">
        <h2 class="card-title">Today</h2>
      </section>
      <p class="card-subtitle">What needs doing right now — not a report, a worklist.</p>

      <section class="card action-section" data-section="calls">
        <h3 class="action-section-title">Calls due today</h3>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="followups">
        <h3 class="action-section-title">Follow-ups due</h3>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="emails">
        <h3 class="action-section-title">Emails requiring action</h3>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="research">
        <h3 class="action-section-title">Companies requiring research</h3>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="opportunities">
        <h3 class="action-section-title">Opportunities in progress</h3>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="replied">
        <h3 class="action-section-title">Marked as Replied</h3>
        <div class="action-section-body"></div>
      </section>
    </main>
  `;

  const sections = {
    calls: container.querySelector<HTMLDivElement>('[data-section="calls"] .action-section-body')!,
    followups: container.querySelector<HTMLDivElement>('[data-section="followups"] .action-section-body')!,
    emails: container.querySelector<HTMLDivElement>('[data-section="emails"] .action-section-body')!,
    research: container.querySelector<HTMLDivElement>('[data-section="research"] .action-section-body')!,
    opportunities: container.querySelector<HTMLDivElement>('[data-section="opportunities"] .action-section-body')!,
    replied: container.querySelector<HTMLDivElement>('[data-section="replied"] .action-section-body')!,
  };

  const actionCentreSidePanelCallbacks: SidePanelCallbacks = {
    onSaveNotes: async (id, notes) => {
      await updateLead(id, { leadNotes: notes });
      await refreshLeads();
    },
    onAssign: async (id, assignedUserId) => {
      await assignLead(id, assignedUserId);
      await refreshLeads();
    },
    onSaveDetails: async (id, contactName, contactTitle, website, linkedin) => {
      await updateLead(id, { contactName, contactTitle, website, linkedin });
      await refreshLeads();
    },
    onAddPhone: async (id, phoneNumber) => {
      await addLeadPhone(id, phoneNumber);
      await refreshLeads();
    },
    onUpdatePhone: async (id, phoneId, phoneNumber) => {
      await updateLeadPhone(id, phoneId, phoneNumber);
      await refreshLeads();
    },
    onDeletePhone: async (id, phoneId) => {
      await deleteLeadPhone(id, phoneId);
      await refreshLeads();
    },
    onAddEmail: async (id, email) => {
      await addLeadEmail(id, email);
      await refreshLeads();
    },
    onUpdateEmail: async (id, emailId, email) => {
      await updateLeadEmail(id, emailId, email);
      await refreshLeads();
    },
    onDeleteEmail: async (id, emailId) => {
      await deleteLeadEmail(id, emailId);
      await refreshLeads();
    },
    onScrapeEmail: async (id) => {
      await scrapeLeadEmail(id);
      await refreshLeads();
    },
    onGenerateIntelligence: async (id) => {
      await generateLeadIntelligence(id);
      await refreshLeads();
    },
  };

  function openLead(leadId: string): void {
    const lead = getLeads().find((l) => l.id === leadId);
    if (!lead) return;
    setSidePanelCallbacks(actionCentreSidePanelCallbacks);
    openSidePanel(lead);
  }

  function emptyRow(message: string): string {
    return `<p class="empty-hint">${escapeHtml(message)}</p>`;
  }

  let pendingDrafts: PendingEmailDraft[] = [];

  function render(): void {
    refreshIfOpen(getLeads());

    const calls = callsDueToday();
    sections.calls.innerHTML = calls.length
      ? calls
          .map(
            ({ event, lead }) => `
        <div class="action-row" data-lead-id="${escapeHtml(lead.id)}">
          <span class="action-row-title">${escapeHtml(lead.company)}</span>
          <span class="empty-hint">${escapeHtml(event.time || "")}</span>
          <button type="button" class="btn btn-ghost btn-sm action-row-open-queue">Open in Call Queue</button>
        </div>`
          )
          .join("")
      : emptyRow("No calls due. Nice and clear.");

    const followUps = followUpsDue();
    sections.followups.innerHTML = followUps.length
      ? followUps
          .map(
            (lead) => `
        <div class="action-row" data-lead-id="${escapeHtml(lead.id)}">
          <span class="action-row-title">${escapeHtml(lead.company)}</span>
          <span class="empty-hint">${escapeHtml(lead.next_best_action.reason)}</span>
          <button type="button" class="btn btn-ghost btn-sm action-row-email-btn">Send Follow-up</button>
          <button type="button" class="btn btn-ghost btn-sm action-row-details-btn">View</button>
        </div>`
          )
          .join("")
      : emptyRow("No follow-ups due.");

    sections.emails.innerHTML = pendingDrafts.length
      ? pendingDrafts
          .map(
            (draft) => `
        <div class="action-row" data-lead-id="${escapeHtml(draft.lead_id)}">
          <span class="action-row-title">${escapeHtml(draft.lead_company)}</span>
          <span class="empty-hint">${escapeHtml(draft.subject || "(no subject yet)")}</span>
          <button type="button" class="btn btn-ghost btn-sm action-row-email-btn">Continue Draft</button>
        </div>`
          )
          .join("")
      : emptyRow("No unfinished drafts.");

    const research = companiesNeedingResearch();
    sections.research.innerHTML = research.length
      ? research
          .map(
            (lead) => `
        <div class="action-row" data-lead-id="${escapeHtml(lead.id)}">
          <span class="action-row-title">${escapeHtml(lead.company)}</span>
          <span class="empty-hint">${escapeHtml(lead.next_best_action.reason)}</span>
          <button type="button" class="btn btn-ghost btn-sm action-row-details-btn">View</button>
        </div>`
          )
          .join("")
      : emptyRow("Every lead has been researched.");

    const opportunities = opportunitiesInProgress();
    sections.opportunities.innerHTML = opportunities.length
      ? opportunities
          .map(
            (lead) => `
        <div class="action-row" data-lead-id="${escapeHtml(lead.id)}">
          <span class="action-row-title">${escapeHtml(lead.company)}</span>
          <span class="status-badge cal-type-task">${escapeHtml(lead.opportunity_stage)}</span>
          <button type="button" class="btn btn-ghost btn-sm action-row-opportunity-btn">Open Workspace</button>
        </div>`
          )
          .join("")
      : emptyRow("No opportunities in progress yet.");

    const replied = recentlyReplied();
    sections.replied.innerHTML = replied.length
      ? replied
          .map(
            (lead) => `
        <div class="action-row" data-lead-id="${escapeHtml(lead.id)}">
          <span class="action-row-title">${escapeHtml(lead.company)}</span>
          <button type="button" class="btn btn-ghost btn-sm action-row-email-btn">Generate Email</button>
          <button type="button" class="btn btn-ghost btn-sm action-row-details-btn">View</button>
        </div>`
          )
          .join("")
      : emptyRow("Nobody marked as Replied right now.");

    container.querySelectorAll<HTMLButtonElement>(".action-row-open-queue").forEach((btn) => {
      btn.addEventListener("click", () => openTab("call-queue", "Call Queue"));
    });
    container.querySelectorAll<HTMLButtonElement>(".action-row-opportunity-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const leadId = btn.closest<HTMLElement>(".action-row")!.dataset.leadId!;
        setPendingOpportunityWorkspaceLead(leadId);
        openTab("opportunity-workspace", "Opportunities");
      });
    });
    container.querySelectorAll<HTMLButtonElement>(".action-row-details-btn").forEach((btn) => {
      btn.addEventListener("click", () => openLead(btn.closest<HTMLElement>(".action-row")!.dataset.leadId!));
    });
    container.querySelectorAll<HTMLButtonElement>(".action-row-email-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const leadId = btn.closest<HTMLElement>(".action-row")!.dataset.leadId!;
        setPendingEmailWriterLead(leadId);
        openTab("email-writer", "AI Email Writer");
      });
    });
  }

  async function refreshAll(): Promise<void> {
    try {
      pendingDrafts = await listPendingEmailDrafts();
    } catch (err) {
      showToast(`Could not load pending drafts: ${err}`);
    }
    render();
  }

  subscribe(render);
  subscribeCalendarEvents(render);
  subscribeTeam(() => setTeamMembers(getTeamMembers()));
  void Promise.all([refreshLeads(), refreshCalendarEvents(), refreshTeamMembers()]).then(refreshAll);
}
