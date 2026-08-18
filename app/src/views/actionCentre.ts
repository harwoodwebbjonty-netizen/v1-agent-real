import {
  type Lead,
  type LeadList,
  addLeadEmail,
  addLeadPhone,
  addLeadTag,
  assignLead,
  deleteEmailDraft,
  deleteLeadEmail,
  deleteLeadPhone,
  deleteLeadTag,
  exportDraftsToMailchimp,
  generateLeadIntelligence,
  listPendingEmailDrafts,
  scrapeLeadEmail,
  setLeadCustomFieldValue,
  updateLead,
  updateLeadEmail,
  updateLeadPhone,
  type PendingEmailDraft,
} from "../api";
import { getCurrentUser } from "../auth";
import { deleteEvent, getEvents, refreshCalendarEvents, subscribeCalendarEvents, type CalendarEvent } from "../calendarEvents";
import {
  openSidePanel,
  refreshIfOpen,
  setSidePanelCallbacks,
  setTeamMembers,
  type SidePanelCallbacks,
} from "../components/sidePanel";
import { setPendingColdCallList } from "../coldCallListHandoff";
import { setPendingEmailWriterLead } from "../emailWriterHandoff";
import { getLeadLists, refreshLeadLists, subscribeLeadLists } from "../leadLists";
import { getLeads, refreshLeads, subscribe } from "../state";
import { getTeamMembers, refreshTeamMembers, subscribeTeam } from "../team";
import { openTab } from "../tabs";
import { showToast } from "../toast";
import { escapeHtml, skeletonBlockHtml } from "../utils";

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

// Pairs each due follow-up with its backing calendar event when one exists
// (some follow-ups are purely next_best_action-driven, with no event to mark
// done) — the Worklist row uses `event` to decide whether it can offer Done.
function followUpsDue(): { lead: Lead; event: CalendarEvent | null }[] {
  const today = todayIso();
  const events = getEvents().filter((e) => e.type === "followup" && e.date <= today && e.lead_id);
  const eventByLead = new Map(events.map((e) => [e.lead_id!, e]));
  const leads = getLeads();
  const ids = new Set(eventByLead.keys());
  for (const l of leads) {
    if (l.next_best_action.action === "Send follow-up email") ids.add(l.id);
  }
  const result: { lead: Lead; event: CalendarEvent | null }[] = [];
  for (const id of ids) {
    const lead = leads.find((l) => l.id === id);
    if (lead) result.push({ lead, event: eventByLead.get(id) ?? null });
  }
  return result;
}

// Upcoming calendar items beyond today — so the rep can see what's coming
// without switching to the full Calendar view.
function upcomingEvents(limit = 6): CalendarEvent[] {
  const today = todayIso();
  return getEvents()
    .filter((e) => e.date > today)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .slice(0, limit);
}

// Calling progress for a lead list, mirroring coldCallLists.ts's listStats —
// duplicated locally to avoid coupling the two views' internals together.
function listCallStats(listId: string): { called: number; total: number } {
  const leads = getLeads().filter((l) => l.list_id === listId);
  return { called: leads.filter((l) => l.called_at).length, total: leads.length };
}

// The rep's own most-recently-created list that isn't fully called through —
// what "Carry on calling" resumes.
function myActiveCallList(): LeadList | null {
  const me = getCurrentUser();
  if (!me) return null;
  const candidates = getLeadLists()
    .filter((l) => l.owner_user_id === me.id)
    .map((l) => ({ list: l, stats: listCallStats(l.id) }))
    .filter(({ stats }) => stats.total > 0 && stats.called < stats.total)
    .sort((a, b) => b.list.created_at.localeCompare(a.list.created_at));
  return candidates[0]?.list ?? null;
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
            <span class="mono pm-sync">WORKLIST</span>
            <span id="today-status"></span>
          </div>
        </div>
        <div class="acts">
          <div class="mc-export-panel" id="mc-export-panel">
            <input type="text" id="mc-campaign-name" class="inline-edit mc-campaign-input"
              placeholder="Campaign name…" />
            <button type="button" class="btn btn-secondary btn-sm" id="mc-export-btn">
              Export to Mailchimp
            </button>
            <span id="mc-export-status" class="status-message"></span>
          </div>
          <button type="button" class="btn btn-primary" id="today-start-calling">Start calling</button>
        </div>
      </header>

      <div class="sec-head">
        <span class="sec-num">01</span>
        <h3 class="action-section-title">Daily brief</h3>
        <span class="sec-rule"></span>
        <span class="sec-count" data-count="brief"></span>
      </div>
      <div class="brief-strip" id="today-brief"></div>

      <section class="card action-section" data-section="worklist">
        <div class="sec-head">
          <span class="sec-num">02</span>
          <h3 class="action-section-title">Worklist</h3>
          <span class="sec-rule"></span>
          <span class="sec-count" data-count="worklist"></span>
        </div>
        <div class="action-section-body"></div>
      </section>

      <div class="cols today-cols">
        <div class="panel">
          <div class="subhead"><h3>Next calls</h3><span class="eyebrow">03 · Calling block</span></div>
          <div id="today-carry-on"></div>
          <ul class="calls" id="today-next-calls"></ul>
          <div class="p-section-label">Upcoming</div>
          <ul class="calls" id="today-upcoming"></ul>
        </div>
        <div class="panel">
          <div class="subhead"><h3>Pipeline</h3><span class="eyebrow">04 · This month</span></div>
          <div class="funnel" id="today-funnel"></div>
        </div>
      </div>

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
    worklist: container.querySelector<HTMLDivElement>('[data-section="worklist"] .action-section-body')!,
    opportunities: container.querySelector<HTMLDivElement>('[data-section="opportunities"] .action-section-body')!,
    replied: container.querySelector<HTMLDivElement>('[data-section="replied"] .action-section-body')!,
  };

  // Page-head "Start calling" opens the calling workspace — jumps straight
  // into the rep's in-progress list ("carry on") when one exists.
  container
    .querySelector<HTMLButtonElement>("#today-start-calling")
    ?.addEventListener("click", () => {
      const active = myActiveCallList();
      if (active) setPendingColdCallList(active.id);
      openTab("cold-call-lists", "Cold Call Lists");
    });

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
    onAddTag: async (id, tag) => {
      await addLeadTag(id, tag);
      await refreshLeads();
    },
    onDeleteTag: async (id, tag) => {
      await deleteLeadTag(id, tag);
      await refreshLeads();
    },
    onSetCustomFieldValue: async (id, fieldId, value) => {
      await setLeadCustomFieldValue(id, fieldId, value);
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
  function wlRow(
    leadId: string, mk: string, when: string, whenSub: string,
    title: string, subHtml: string, chipHtml: string, buttonsHtml: string
  ): string {
    return `
      <div class="action-row wl-row" data-lead-id="${escapeHtml(leadId)}">
        <div class="wl-when">${escapeHtml(when)}${whenSub ? `<em>${escapeHtml(whenSub)}</em>` : ""}</div>
        <div class="wl-rail"><span class="wl-mk wl-${mk}"></span></div>
        <div class="wl-body">
          <div class="action-row-title wl-t">${escapeHtml(title)}</div>
          ${subHtml ? `<div class="wl-s">${subHtml}</div>` : ""}
        </div>
        <div class="wl-end">${chipHtml}${buttonsHtml}</div>
      </div>`;
  }
  const companyB = (name: string): string => `<b>${escapeHtml(name)}</b>`;
  function wlChip(text: string, cls: string): string {
    return `<span class="wl-chip ${cls}"><span class="wl-cd"></span>${escapeHtml(text)}</span>`;
  }
  const btnDetails = `<button type="button" class="btn btn-ghost btn-sm action-row-details-btn">View</button>`;
  const btnEmail = (label: string) => `<button type="button" class="btn btn-ghost btn-sm action-row-email-btn">${escapeHtml(label)}</button>`;
  // "Done" clears the calendar reminder (call/follow-up event) — it does not
  // log a call outcome; that still happens via Call Queue / Cold Call Lists.
  const btnDone = (kind: "call" | "followup", eventId: string) =>
    `<button type="button" class="btn btn-ghost btn-sm action-row-done-btn" data-done-kind="${kind}" data-done-id="${escapeHtml(eventId)}">Done</button>`;
  const btnDeleteDraft = (draftId: string) =>
    `<button type="button" class="btn btn-danger-ghost btn-sm action-row-done-btn" data-done-kind="draft" data-done-id="${escapeHtml(draftId)}">Delete</button>`;

  let pendingDrafts: PendingEmailDraft[] = [];
  // Worklist compaction: show the top rows, collapse the rest behind a toggle.
  let worklistExpanded = false;
  const WORKLIST_COLLAPSE_AT = 6;
  let isInitialLoad = true;

  function setCount(key: string, n: number): void {
    const el = container.querySelector<HTMLSpanElement>(`.sec-count[data-count="${key}"]`);
    if (el) el.textContent = n ? String(n) : "—";
  }

  function render(): void {
    if (isInitialLoad) {
      const skeleton = skeletonBlockHtml(3);
      sections.worklist.innerHTML = skeleton;
      sections.opportunities.innerHTML = skeleton;
      sections.replied.innerHTML = skeleton;
      return;
    }
    refreshIfOpen(getLeads());
    const today = todayIso();

    const calls = callsDueToday();
    const followUps = followUpsDue();
    const research = companiesNeedingResearch();

    // 02 Worklist — one priority-ordered list mixing follow-ups, calls, email
    // drafts and research. Each row reuses the existing hooks so every action
    // (View, Send Follow-up, Continue Draft) keeps working exactly as before.
    const overdueFollowIds = new Set(
      getEvents().filter((e) => e.type === "followup" && e.date < today && !!e.lead_id).map((e) => e.lead_id!)
    );
    const worklistRows: string[] = [
      ...followUps.map(({ lead, event }) => {
        const reason = lead.next_best_action.reason;
        return wlRow(lead.id, "follow", "—", overdueFollowIds.has(lead.id) ? "OVERDUE" : "",
          reason ? `Follow up — ${reason}` : "Follow up",
          companyB(lead.company),
          wlChip("Follow-up", "wl-info"),
          btnEmail("Send Follow-up") + btnDetails + (event ? btnDone("followup", event.id) : ""));
      }),
      ...calls.map(({ event, lead }) =>
        wlRow(lead.id, "call", event.time || "—", "",
          "Call",
          companyB(lead.company) + (lead.phone_number ? ` · <span class="mono">${escapeHtml(lead.phone_number)}</span>` : ""),
          wlChip("Call", "wl-hi"), btnDetails + btnDone("call", event.id))),
      ...pendingDrafts.map((draft) =>
        wlRow(draft.lead_id, "email", "—", "",
          draft.subject ? `Send email — ${draft.subject}` : "Send follow-up email",
          companyB(draft.lead_company),
          wlChip("Draft", "wl-purple"), btnEmail("Continue Draft") + btnDeleteDraft(draft.id))),
      ...research.map((lead) => {
        const reason = lead.next_best_action.reason;
        return wlRow(lead.id, "research", "—", "",
          reason ? `Research — ${reason}` : "Research",
          companyB(lead.company),
          wlChip("Research", "wl-amber"), btnDetails);
      }),
    ];
    const worklistCount = worklistRows.length;
    setCount("worklist", worklistCount);
    if (!worklistCount) {
      sections.worklist.innerHTML = emptyRow("Nothing outstanding — a clean slate.");
    } else if (worklistCount <= WORKLIST_COLLAPSE_AT) {
      sections.worklist.innerHTML = worklistRows.join("");
    } else {
      const hiddenCount = worklistCount - WORKLIST_COLLAPSE_AT;
      sections.worklist.innerHTML =
        worklistRows.slice(0, WORKLIST_COLLAPSE_AT).join("") +
        `<div class="wl-more-rows${worklistExpanded ? "" : " hidden"}" id="wl-more-rows">${worklistRows.slice(WORKLIST_COLLAPSE_AT).join("")}</div>` +
        `<button type="button" class="wl-more-toggle" id="wl-more-toggle" aria-expanded="${worklistExpanded}">${worklistExpanded ? "Show less" : `Show ${hiddenCount} more`}</button>`;
      const moreToggle = container.querySelector<HTMLButtonElement>("#wl-more-toggle");
      const moreRows = container.querySelector<HTMLElement>("#wl-more-rows");
      moreToggle?.addEventListener("click", () => {
        worklistExpanded = !worklistExpanded;
        moreRows?.classList.toggle("hidden", !worklistExpanded);
        moreToggle.setAttribute("aria-expanded", String(worklistExpanded));
        moreToggle.textContent = worklistExpanded ? "Show less" : `Show ${hiddenCount} more`;
      });
    }

    const opportunities = opportunitiesInProgress();
    setCount("opportunities", opportunities.length);
    sections.opportunities.innerHTML = opportunities.length
      ? opportunities
          .map((lead) =>
            wlRow(lead.id, "opp", "—", "",
              "Opportunity",
              companyB(lead.company),
              `<span class="status-badge cal-type-task">${escapeHtml(lead.opportunity_stage)}</span>`,
              btnDetails))
          .join("")
      : emptyRow("No opportunities in progress yet.");

    const replied = recentlyReplied();
    setCount("replied", replied.length);
    sections.replied.innerHTML = replied.length
      ? replied
          .map((lead) =>
            wlRow(lead.id, "ok", "—", "",
              "Replied",
              companyB(lead.company),
              wlChip("Replied", "wl-ok"), btnEmail("Generate Email") + btnDetails))
          .join("")
      : emptyRow("Nobody marked as Replied right now.");

    // 03 Next calls — the calls-due list in a compact calling-block panel.
    const nextCallsEl = container.querySelector<HTMLUListElement>("#today-next-calls");
    if (nextCallsEl) {
      nextCallsEl.innerHTML = calls.length
        ? calls
            .map(({ event, lead }) => {
              const loc = lead.industry ? escapeHtml(lead.industry) : "";
              const phone = lead.phone_number ? escapeHtml(lead.phone_number) : "—";
              const tm = event.time ? escapeHtml(event.time) : "—";
              return `<li><span class="tm">${tm}</span><span class="co"><b>${escapeHtml(lead.company)}</b><span>${loc}</span></span><span class="phone">${phone}</span></li>`;
            })
            .join("")
        : `<li class="calls-empty">No calls scheduled today.</li>`;
    }

    // "Carry on calling" — the rep's own in-progress cold-call list, not a
    // flat list of every lead needing a call. Jumps straight into it via the
    // same handoff "Start calling" uses.
    const carryOnEl = container.querySelector<HTMLDivElement>("#today-carry-on");
    if (carryOnEl) {
      const active = myActiveCallList();
      if (active) {
        const s = listCallStats(active.id);
        carryOnEl.innerHTML = `
          <button type="button" class="carry-on-btn" id="today-carry-on-btn">
            <span class="carry-on-name">${escapeHtml(active.name)}</span>
            <span class="carry-on-prog mono">${s.called}/${s.total} called</span>
            <span class="carry-on-cta">Carry on →</span>
          </button>`;
        carryOnEl.querySelector<HTMLButtonElement>("#today-carry-on-btn")?.addEventListener("click", () => {
          setPendingColdCallList(active.id);
          openTab("cold-call-lists", "Cold Call Lists");
        });
      } else {
        carryOnEl.innerHTML = "";
      }
    }

    // Upcoming — calendar items beyond today, so the rep can see what's
    // coming without switching to the full Calendar view.
    const upcomingEl = container.querySelector<HTMLUListElement>("#today-upcoming");
    if (upcomingEl) {
      const upcoming = upcomingEvents();
      const leads = getLeads();
      const typeLabel: Record<CalendarEvent["type"], string> = { call: "Call", followup: "Follow-up", task: "Task" };
      upcomingEl.innerHTML = upcoming.length
        ? upcoming
            .map((e) => {
              const lead = e.lead_id ? leads.find((l) => l.id === e.lead_id) : undefined;
              const dateLabel = new Date(`${e.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
              const sub = `${typeLabel[e.type]}${e.time ? ` · ${e.time}` : ""}`;
              return `<li${lead ? ` class="upcoming-row" data-lead-id="${escapeHtml(lead.id)}"` : ""}>
                <span class="tm">${escapeHtml(dateLabel)}</span>
                <span class="co"><b>${escapeHtml(lead ? lead.company : e.title)}</b><span>${escapeHtml(sub)}</span></span>
              </li>`;
            })
            .join("")
        : `<li class="calls-empty">Nothing else on the calendar yet.</li>`;
      upcomingEl.querySelectorAll<HTMLLIElement>(".upcoming-row").forEach((li) => {
        li.addEventListener("click", () => openLead(li.dataset.leadId!));
      });
    }

    // 04 Pipeline — live funnel derived from the real lead pool (no invented data).
    const funnelEl = container.querySelector<HTMLDivElement>("#today-funnel");
    if (funnelEl) {
      const leads = getLeads();
      const total = leads.length;
      const contacted = leads.filter((l) => l.contact_status && !/^not/i.test(l.contact_status)).length;
      const repliedN = leads.filter((l) => l.contact_status === "Replied").length;
      const won = leads.filter((l) => l.opportunity_stage === "won").length;
      const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 100) : 0);
      const w = (n: number): number => (total > 0 ? Math.max(2, Math.round((n / total) * 100)) : 0);
      funnelEl.innerHTML = `
        <div class="stage"><span class="sl">New</span><div class="track"><div class="fill" style="width:100%"><b>${total.toLocaleString()}</b></div></div><span class="cv">—</span></div>
        <div class="stage"><span class="sl">Contacted</span><div class="track"><div class="fill g2" style="width:${w(contacted)}%"><b>${contacted.toLocaleString()}</b></div></div><span class="cv">${pct(contacted, total)}% <em>of new</em></span></div>
        <div class="stage"><span class="sl">Replied</span><div class="track"><div class="fill g3" style="width:${w(repliedN)}%"><b>${repliedN.toLocaleString()}</b></div></div><span class="cv">${pct(repliedN, contacted)}% <em>of cont.</em></span></div>
        <div class="stage"><span class="sl">Won</span><div class="track"><div class="fill g4" style="width:${w(won)}%"><b>${won.toLocaleString()}</b></div></div><span class="cv">${pct(won, repliedN)}% <em>of replied</em></span></div>`;
    }

    // Status chip (truthful: overdue count or "on track") + brief aside.
    const overdueCount = getEvents().filter(
      (e) => (e.type === "call" || e.type === "followup") && e.date < today && !!e.lead_id
    ).length;
    const statusEl = container.querySelector<HTMLSpanElement>("#today-status");
    if (statusEl) {
      statusEl.innerHTML = overdueCount > 0
        ? `<span class="wl-chip wl-amber"><span class="wl-cd"></span>${overdueCount} OVERDUE</span>`
        : `<span class="wl-chip wl-ok"><span class="wl-cd"></span>ON TRACK</span>`;
    }
    const briefCountEl = container.querySelector<HTMLSpanElement>('.sec-count[data-count="brief"]');
    if (briefCountEl) {
      briefCountEl.textContent =
        `${worklistCount} item${worklistCount === 1 ? "" : "s"}` + (overdueCount > 0 ? ` · ${overdueCount} overdue` : "");
    }

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
    container.querySelectorAll<HTMLButtonElement>(".action-row-done-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const kind = btn.dataset.doneKind!;
        const id = btn.dataset.doneId!;
        if (kind === "draft") {
          if (!confirm("Delete this draft? This can't be undone.")) return;
          btn.disabled = true;
          try {
            await deleteEmailDraft(id);
            pendingDrafts = pendingDrafts.filter((d) => d.id !== id);
            render();
          } catch (err) {
            showToast(`Could not delete draft: ${err}`);
            btn.disabled = false;
          }
          return;
        }
        if (!confirm("Mark as done? This removes the reminder from your calendar (it won't log a call outcome).")) return;
        btn.disabled = true;
        try {
          await deleteEvent(id);
        } catch (err) {
          showToast(`Could not update the calendar: ${err}`);
          btn.disabled = false;
        }
      });
    });
  }

  async function refreshAll(): Promise<void> {
    try {
      pendingDrafts = await listPendingEmailDrafts();
    } catch (err) {
      showToast(`Could not load pending drafts: ${err}`);
    }
    isInitialLoad = false;
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

  render();
  subscribe(render);
  subscribeCalendarEvents(render);
  subscribeTeam(() => setTeamMembers(getTeamMembers()));
  subscribeLeadLists(render);
  void Promise.all([refreshLeads(), refreshCalendarEvents(), refreshTeamMembers(), refreshLeadLists()])
    .then(refreshAll)
    .catch((err) => {
      isInitialLoad = false;
      showToast(`Could not load Today data: ${err}`);
      render();
    });
}
