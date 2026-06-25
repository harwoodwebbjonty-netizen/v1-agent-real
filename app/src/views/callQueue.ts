import {
  type Lead,
  addLeadEmail,
  addLeadPhone,
  assignLead,
  createCallLog,
  createCalendarEvent,
  deleteLeadEmail,
  deleteLeadPhone,
  generateLeadIntelligence,
  scrapeLeadEmail,
  updateLead,
  updateLeadEmail,
  updateLeadPhone,
  type CallOutcome,
} from "../api";
import { getEvents, refreshCalendarEvents, subscribeCalendarEvents, type CalendarEvent } from "../calendarEvents";
import { setPendingEmailWriterLead } from "../emailWriterHandoff";
import {
  openSidePanel,
  refreshIfOpen,
  setSidePanelCallbacks,
  setTeamMembers,
  type SidePanelCallbacks,
} from "../components/sidePanel";
import { getLeads, refreshLeads, subscribe } from "../state";
import { getTeamMembers, refreshTeamMembers, subscribeTeam } from "../team";
import { openTab } from "../tabs";
import { showToast } from "../toast";
import { escapeHtml } from "../utils";

const OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected: "Connected",
  voicemail: "Voicemail",
  no_answer: "No answer",
  wrong_number: "Wrong number",
  other: "Other",
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+0-9]/g, "")}`;
}

function dueCalls(): { event: CalendarEvent; lead: Lead }[] {
  const today = todayIso();
  const leads = getLeads();
  return getEvents()
    .filter((e) => e.type === "call" && e.date <= today && e.lead_id)
    .map((event) => ({ event, lead: leads.find((l) => l.id === event.lead_id) }))
    .filter((x): x is { event: CalendarEvent; lead: Lead } => !!x.lead)
    .sort((a, b) => (a.event.date + a.event.time).localeCompare(b.event.date + b.event.time));
}

export function initCallQueue(): void {
  const container = document.querySelector<HTMLDivElement>("#view-call-queue")!;
  container.innerHTML = `
    <main class="container">
      <section class="card-title-row">
        <span class="card-icon-badge" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </span>
        <h2 class="card-title">Call Queue</h2>
      </section>
      <p class="card-subtitle">Calls scheduled for today and overdue calls. Work through this list top to bottom.</p>
      <div id="call-queue-list" class="call-queue-list"></div>
    </main>
  `;

  const listEl = document.querySelector<HTMLDivElement>("#call-queue-list")!;

  const callQueueSidePanelCallbacks: SidePanelCallbacks = {
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

  function render(): void {
    const calls = dueCalls();
    refreshIfOpen(getLeads());

    if (calls.length === 0) {
      listEl.innerHTML = `<div class="card empty-state">No calls due. Schedule one from a lead's details, or check back later.</div>`;
      return;
    }

    listEl.innerHTML = calls
      .map(({ event, lead }) => {
        const intel = lead.intelligence;
        const overdue = event.date < todayIso();
        const starters = intel?.conversation_starters?.slice(0, 3) ?? [];
        const questions = intel?.discovery_questions?.slice(0, 3) ?? [];

        return `
        <div class="card call-queue-card" data-lead-id="${escapeHtml(lead.id)}" data-event-id="${escapeHtml(event.id)}">
          <div class="call-queue-card-header">
            <div>
              <h3 class="call-queue-company">${escapeHtml(lead.company)}</h3>
              <div class="call-queue-meta">
                ${lead.industry ? `<span>${escapeHtml(lead.industry)}</span>` : ""}
                <span class="status-badge ${overdue ? "not_found" : "cal-type-call"}">${overdue ? "Overdue" : "Today"} · ${escapeHtml(event.time || "")}</span>
                ${intel ? `<span class="status-badge intel-${intel.lead_temperature.toLowerCase()}">${intel.lead_temperature} · ${intel.lead_score}</span>` : ""}
              </div>
              <p class="call-queue-nba"><strong>Next best action:</strong> ${escapeHtml(lead.next_best_action.action)} <span class="empty-hint">— ${escapeHtml(lead.next_best_action.reason)}</span></p>
            </div>
            <a class="btn btn-primary call-queue-start-btn" href="${telHref(lead.phone_number)}">Start Call · ${escapeHtml(lead.phone_number)}</a>
          </div>

          ${lead.website ? `<p class="call-queue-website"><a href="${escapeHtml(lead.website)}" target="_blank" rel="noopener">${escapeHtml(lead.website)}</a></p>` : ""}
          ${lead.lead_notes ? `<p class="call-queue-notes"><strong>Notes:</strong> ${escapeHtml(lead.lead_notes)}</p>` : ""}

          ${
            intel
              ? `
            ${intel.call_brief ? `<div class="intel-call-brief"><h4>Call brief</h4><p>${escapeHtml(intel.call_brief)}</p></div>` : ""}
            ${
              starters.length || questions.length
                ? `<div class="call-queue-talking-points">
                    ${starters.length ? `<div><h5>Suggested openers</h5><ul>${starters.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul></div>` : ""}
                    ${questions.length ? `<div><h5>Discovery questions</h5><ul>${questions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul></div>` : ""}
                  </div>`
                : ""
            }`
              : `<p class="empty-hint">No AI research generated yet for this lead.</p>`
          }

          <form class="call-outcome-form" data-lead-id="${escapeHtml(lead.id)}" data-event-id="${escapeHtml(event.id)}">
            <div class="call-outcome-row">
              <select class="inline-edit call-outcome-select" required>
                <option value="" disabled selected>Log outcome...</option>
                ${Object.entries(OUTCOME_LABELS)
                  .map(([value, label]) => `<option value="${value}">${label}</option>`)
                  .join("")}
              </select>
              <input type="number" min="0" class="search-input call-outcome-duration" placeholder="Duration (min)" />
            </div>
            <textarea class="call-outcome-notes" rows="2" placeholder="What happened on this call?"></textarea>
            <div class="card-actions">
              <button type="submit" class="btn btn-secondary btn-sm">Save Outcome</button>
              <button type="button" class="btn btn-ghost btn-sm call-queue-followup-btn">Create Follow-up (+3 days)</button>
              <button type="button" class="btn btn-ghost btn-sm call-queue-email-btn">Generate Email</button>
              ${!intel ? `<button type="button" class="btn btn-ghost btn-sm call-queue-research-btn">Generate Research</button>` : ""}
              ${lead.next_best_action.action === "Move to Opportunity" ? `<button type="button" class="btn btn-ghost btn-sm call-queue-opportunity-btn">Move to Opportunity</button>` : ""}
              <button type="button" class="btn btn-ghost btn-sm call-queue-details-btn">View Full Details</button>
            </div>
          </form>
        </div>`;
      })
      .join("");

    listEl.querySelectorAll<HTMLFormElement>(".call-outcome-form").forEach((form) => {
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const leadId = form.dataset.leadId!;
        const eventId = form.dataset.eventId!;
        const outcome = form.querySelector<HTMLSelectElement>(".call-outcome-select")!.value as CallOutcome;
        const notes = form.querySelector<HTMLTextAreaElement>(".call-outcome-notes")!.value.trim();
        const durationMin = form.querySelector<HTMLInputElement>(".call-outcome-duration")!.value;
        const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
        submitBtn.disabled = true;
        try {
          await createCallLog(leadId, outcome, notes, durationMin ? Number(durationMin) * 60 : undefined, eventId);
          showToast("Call outcome saved");
          render();
        } finally {
          submitBtn.disabled = false;
        }
      });
    });

    listEl.querySelectorAll<HTMLButtonElement>(".call-queue-followup-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest<HTMLElement>(".call-queue-card")!;
        const leadId = card.dataset.leadId!;
        const lead = getLeads().find((l) => l.id === leadId);
        if (!lead) return;
        const followUpDate = new Date();
        followUpDate.setDate(followUpDate.getDate() + 3);
        btn.disabled = true;
        try {
          await createCalendarEvent(
            `Follow up: ${lead.company}`,
            followUpDate.toISOString().slice(0, 10),
            "",
            "followup",
            lead.id
          );
          await refreshCalendarEvents();
          showToast("Follow-up created for 3 days from now");
        } finally {
          btn.disabled = false;
        }
      });
    });

    listEl.querySelectorAll<HTMLButtonElement>(".call-queue-opportunity-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest<HTMLElement>(".call-queue-card")!;
        btn.disabled = true;
        try {
          await updateLead(card.dataset.leadId!, { opportunityStage: "opportunity" });
          await refreshLeads();
          showToast("Moved to Opportunity");
          render();
        } finally {
          btn.disabled = false;
        }
      });
    });

    listEl.querySelectorAll<HTMLButtonElement>(".call-queue-email-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const card = btn.closest<HTMLElement>(".call-queue-card")!;
        setPendingEmailWriterLead(card.dataset.leadId!);
        openTab("email-writer", "AI Email Writer");
      });
    });

    listEl.querySelectorAll<HTMLButtonElement>(".call-queue-research-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const card = btn.closest<HTMLElement>(".call-queue-card")!;
        btn.disabled = true;
        btn.textContent = "Generating...";
        try {
          await generateLeadIntelligence(card.dataset.leadId!);
          await refreshLeads();
          render();
        } catch (err) {
          showToast(`Research failed: ${err}`);
          btn.disabled = false;
          btn.textContent = "Generate Research";
        }
      });
    });

    listEl.querySelectorAll<HTMLButtonElement>(".call-queue-details-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const card = btn.closest<HTMLElement>(".call-queue-card")!;
        const lead = getLeads().find((l) => l.id === card.dataset.leadId);
        if (!lead) return;
        setSidePanelCallbacks(callQueueSidePanelCallbacks);
        openSidePanel(lead);
      });
    });
  }

  subscribe(render);
  subscribeCalendarEvents(render);
  subscribeTeam(() => setTeamMembers(getTeamMembers()));
  void Promise.all([refreshLeads(), refreshCalendarEvents(), refreshTeamMembers()]).then(render);
}
