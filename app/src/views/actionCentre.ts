import {
  type Lead,
  addLeadEmail,
  addLeadPhone,
  assignLead,
  deleteLeadEmail,
  deleteLeadPhone,
  exportDraftsToMailchimp,
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
    <main class="container today-view">
      <header class="page-head">
        <div>
          <h1 class="page-title">Today</h1>
          <div class="page-meta">
            <span id="today-date"></span>
            <span class="pm-sep">·</span>
            <span class="mono pm-sync">WORKLIST — NOT A REPORT</span>
          </div>
        </div>
      </header>

      <div class="brief-strip" id="today-brief"></div>

      <section class="card action-section" data-section="calls">
        <div class="sec-head">
          <span class="sec-num">01</span>
          <h3 class="action-section-title">Calls due today</h3>
          <span class="sec-rule"></span>
          <span class="sec-count" data-count="calls"></span>
        </div>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="followups">
        <div class="sec-head">
          <span class="sec-num">02</span>
          <h3 class="action-section-title">Follow-ups due</h3>
          <span class="sec-rule"></span>
          <span class="sec-count" data-count="followups"></span>
        </div>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="emails">
        <div class="sec-head">
          <span class="sec-num">03</span>
          <h3 class="action-section-title">Emails requiring action</h3>
          <span class="sec-rule"></span>
          <div class="mc-export-panel" id="mc-export-panel">
            <input type="text" id="mc-campaign-name" class="inline-edit mc-campaign-input"
              placeholder="Campaign name…" />
            <button type="button" class="btn btn-secondary btn-sm" id="mc-export-btn">
              Export to Mailchimp
            </button>
            <span id="mc-export-status" class="status-message"></span>
          </div>
        </div>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="research">
        <div class="sec-head">
          <span class="sec-num">04</span>
          <h3 class="action-section-title">Companies requiring research</h3>
          <span class="sec-rule"></span>
          <span class="sec-count" data-count="research"></span>
        </div>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="opportunities">
        <div class="sec-head">
          <span class="sec-num">05</span>
          <h3 class="action-section-title">Opportunities in progress</h3>
          <span class="sec-rule"></span>
          <span class="sec-count" data-count="opportunities"></span>
        </div>
        <div class="action-section-body"></div>
      </section>

      <section class="card action-section" data-section="replied">
        <div class="sec-head">
          <span class="sec-num">06</span>
          <h3 class="action-section-title">Marked as Replied</h3>
          <span class="sec-rule"></span>
          <span class="sec-count" data-count="replied"></span>
        </div>
        <div class="action-section-body"></div>
      </section>
    </main>
  `;

  // Page header date (presentation only).
  const dateEl = container.querySelector<HTMLSpanElement>("#today-date");
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long", day: "numeric", month: "long",
    });
  }

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

  // Editorial worklist row. Keeps the exact hooks the click handlers rely on:
  // .action-row[data-lead-id], .action-row-title, and the button classes.
  function wlRow(leadId: string, mk: string, title: string, metaHtml: string, chipHtml: string, buttonsHtml: string): string {
    return `
      <div class="action-row wl-row" data-lead-id="${escapeHtml(leadId)}">
        <span class="wl-mk wl-${mk}"></span>
        <div class="wl-body">
          <div class="action-row-title wl-t">${escapeHtml(title)}</div>
          ${metaHtml ? `<div class="wl-s">${metaHtml}</div>` : ""}
        </div>
        <div class="wl-end">${chipHtml}${buttonsHtml}</div>
      </div>`;
  }
  function wlChip(text: string, cls: string): string {
    return `<span class="wl-chip ${cls}"><span class="wl-cd"></span>${escapeHtml(text)}</span>`;
  }
  const btnDetails = `<button type="button" class="btn btn-ghost btn-sm action-row-details-btn">View</button>`;
  const btnEmail = (label: string) => `<button type="button" class="btn btn-ghost btn-sm action-row-email-btn">${escapeHtml(label)}</button>`;

  let pendingDrafts: PendingEmailDraft[] = [];

  function setCount(key: string, n: number): void {
    const el = container.querySelector<HTMLSpanElement>(`.sec-count[data-count="${key}"]`);
    if (el) el.textContent = n ? String(n) : "—";
  }

  function render(): void {
    refreshIfOpen(getLeads());

    const calls = callsDueToday();
    setCount("calls", calls.length);
    sections.calls.innerHTML = calls.length
      ? calls
          .map(({ event, lead }) =>
            wlRow(lead.id, "call", lead.company,
              event.time ? `<span class="mono">${escapeHtml(event.time)}</span>` : "",
              wlChip("Call", "wl-hi"), btnDetails))
          .join("")
      : emptyRow("No calls due. Nice and clear.");

    const followUps = followUpsDue();
    setCount("followups", followUps.length);
    sections.followups.innerHTML = followUps.length
      ? followUps
          .map((lead) =>
            wlRow(lead.id, "follow", lead.company,
              escapeHtml(lead.next_best_action.reason),
              wlChip("Follow-up", "wl-info"), btnEmail("Send Follow-up") + btnDetails))
          .join("")
      : emptyRow("No follow-ups due.");

    setCount("emails", pendingDrafts.length);
    sections.emails.innerHTML = pendingDrafts.length
      ? pendingDrafts
          .map((draft) =>
            wlRow(draft.lead_id, "email", draft.lead_company,
              escapeHtml(draft.subject || "(no subject yet)"),
              wlChip("Draft", "wl-purple"), btnEmail("Continue Draft")))
          .join("")
      : emptyRow("No unfinished drafts.");

    const research = companiesNeedingResearch();
    setCount("research", research.length);
    sections.research.innerHTML = research.length
      ? research
          .map((lead) =>
            wlRow(lead.id, "research", lead.company,
              escapeHtml(lead.next_best_action.reason),
              wlChip("Research", "wl-amber"), btnDetails))
          .join("")
      : emptyRow("Every lead has been researched.");

    const opportunities = opportunitiesInProgress();
    setCount("opportunities", opportunities.length);
    sections.opportunities.innerHTML = opportunities.length
      ? opportunities
          .map((lead) =>
            wlRow(lead.id, "opp", lead.company, "",
              `<span class="status-badge cal-type-task">${escapeHtml(lead.opportunity_stage)}</span>`,
              btnDetails))
          .join("")
      : emptyRow("No opportunities in progress yet.");

    const replied = recentlyReplied();
    setCount("replied", replied.length);
    sections.replied.innerHTML = replied.length
      ? replied
          .map((lead) =>
            wlRow(lead.id, "ok", lead.company, "",
              wlChip("Replied", "wl-ok"), btnEmail("Generate Email") + btnDetails))
          .join("")
      : emptyRow("Nobody marked as Replied right now.");

    // Daily brief — derived entirely from the counts above (no invented data).
    const briefEl = container.querySelector<HTMLDivElement>("#today-brief");
    if (briefEl) {
      const totalDue = calls.length + followUps.length + pendingDrafts.length;
      const priority = totalDue === 0
        ? "Nothing outstanding right now — a clean slate."
        : `${totalDue} open item${totalDue === 1 ? "" : "s"} to clear` +
          (followUps.length ? ` — start with the ${followUps.length} follow-up${followUps.length === 1 ? "" : "s"} due` : "") +
          (calls.length ? `, then ${calls.length} call${calls.length === 1 ? "" : "s"}` : "") + ".";
      briefEl.innerHTML = `
        <div class="bs-cell bs-lead"><div class="bs-l">Priority</div><div class="bs-k">${escapeHtml(priority)}</div></div>
        <div class="bs-cell"><div class="bs-l">Calls due</div><div class="bs-k tnum">${calls.length}</div></div>
        <div class="bs-cell"><div class="bs-l">Follow-ups</div><div class="bs-k tnum">${followUps.length}</div></div>
        <div class="bs-cell"><div class="bs-l">Emails to action</div><div class="bs-k tnum">${pendingDrafts.length}</div></div>`;
    }

    container.querySelectorAll<HTMLButtonElement>(".action-row-details-btn").forEach((btn) => {
      btn.addEventListener("click", () => openLead(btn.closest<HTMLElement>(".action-row")!.dataset.leadId!));
    });
    container.querySelectorAll<HTMLButtonElement>(".action-row-email-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const leadId = btn.closest<HTMLElement>(".action-row")!.dataset.leadId!;
        setPendingEmailWriterLead(leadId);
        openTab("outreach", "Outreach");
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
    bindMailchimpExport();
  }

  function bindMailchimpExport(): void {
    const btn = document.getElementById("mc-export-btn") as HTMLButtonElement | null;
    const nameInput = document.getElementById("mc-campaign-name") as HTMLInputElement | null;
    const statusEl = document.getElementById("mc-export-status");
    if (!btn || !nameInput || !statusEl) return;

    btn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      if (pendingDrafts.length === 0) {
        statusEl.textContent = "No pending drafts to export.";
        return;
      }
      btn.disabled = true;
      btn.textContent = "Exporting…";
      statusEl.textContent = "";
      try {
        const result = await exportDraftsToMailchimp(name);
        statusEl.innerHTML =
          `${result.exported} exported, ${result.skipped} skipped — ` +
          `<a href="#" id="mc-open-link">Copy Mailchimp link</a>`;
        document.getElementById("mc-open-link")?.addEventListener("click", (e) => {
          e.preventDefault();
          void navigator.clipboard.writeText(result.mailchimp_url).then(() => {
            if (statusEl) statusEl.textContent = "Mailchimp URL copied to clipboard — paste it in your browser.";
          });
        });
        nameInput.value = "";
      } catch (err) {
        statusEl.textContent = `Export failed: ${err}`;
      } finally {
        btn.disabled = false;
        btn.textContent = "Export to Mailchimp";
      }
    });
  }

  subscribe(render);
  subscribeCalendarEvents(render);
  subscribeTeam(() => setTeamMembers(getTeamMembers()));
  void Promise.all([refreshLeads(), refreshCalendarEvents(), refreshTeamMembers()]).then(refreshAll);
}
