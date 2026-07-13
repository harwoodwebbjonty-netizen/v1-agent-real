import type { EmailEntry, Lead, LeadIntelligence, LeadIntelligenceVersion, PhoneEntry, UserInfo } from "../api";
import { EMAIL_PATTERN, getLeadIntelligenceHistory, PHONE_PATTERN, setLeadFollowUp } from "../api";
import { copyToClipboard } from "../contact";
import { setPendingEmailWriterLead } from "../emailWriterHandoff";
import { openTab } from "../tabs";
import { escapeHtml } from "../utils";

let currentLead: Lead | null = null;
let teamMembers: UserInfo[] = [];
let editingPhoneId: string | null = null;
let editingEmailId: string | null = null;
let intelligenceHistory: LeadIntelligenceVersion[] | null = null;
let viewingVersionId: string | null = null;
let intelligenceOnCooldown = false;
let intelligenceCooldownTimer: ReturnType<typeof setTimeout> | null = null;

let onAssign: ((id: string, assignedUserId: string | null) => Promise<void>) | null = null;
let onAddPhone: ((id: string, phoneNumber: string) => Promise<void>) | null = null;
let onUpdatePhone: ((id: string, phoneId: string, phoneNumber: string) => Promise<void>) | null = null;
let onDeletePhone: ((id: string, phoneId: string) => Promise<void>) | null = null;
let onAddEmail: ((id: string, email: string) => Promise<void>) | null = null;
let onUpdateEmail: ((id: string, emailId: string, email: string) => Promise<void>) | null = null;
let onDeleteEmail: ((id: string, emailId: string) => Promise<void>) | null = null;
let onSaveNotes: ((id: string, notes: string) => Promise<void>) | null = null;
let onSaveDetails:
  | ((id: string, contactName: string, contactTitle: string, website: string, linkedin: string) => Promise<void>)
  | null = null;
let onScrapeEmail: ((id: string) => Promise<void>) | null = null;
let onGenerateIntelligence: ((id: string) => Promise<void>) | null = null;

interface Charge {
  status: string;
  created_on: string;
  delivered_on: string;
  classification: string;
  holders: string[];
  description: string;
}

function renderChData(lead: Lead): void {
  const el = document.querySelector("#ch-data-section")!;
  if (!lead.ch_data) {
    el.innerHTML = '<p class="empty-hint">Not enriched yet — click "Enrich from CH" on the Leads page.</p>';
    return;
  }
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(lead.ch_data); } catch { /* ignore */ }

  const charges: Charge[] = Array.isArray(d["charges"]) ? (d["charges"] as Charge[]) : [];
  const outstandingCharges = charges.filter((c) => c.status === "outstanding");

  const chargeBadge = (c: Charge) => {
    const badge = c.status === "outstanding" ? "unverified" : "verified";
    return `<span class="status-badge ${badge}">${escapeHtml(c.status || "unknown")}</span>`;
  };

  el.innerHTML = `
    <dl class="info-list">
      <dt>Company number</dt><dd>${escapeHtml(String(d["company_number"] || "—"))}</dd>
      <dt>Type</dt><dd>${escapeHtml(String(d["company_type"] || "—"))}</dd>
      <dt>Incorporated</dt><dd>${escapeHtml(String(d["incorporation_date"] || "—"))}</dd>
      <dt>Directors</dt><dd>${escapeHtml((d["directors"] as string[] || []).join(", ") || "—")}</dd>
      <dt>Charges on file</dt><dd>${escapeHtml(String(d["charges_total"] ?? charges.length))}</dd>
      <dt>Outstanding charges</dt><dd>${outstandingCharges.length > 0 ? `<strong>${outstandingCharges.length}</strong>` : "0"}</dd>
    </dl>
    ${charges.length === 0
      ? '<p class="empty-hint">No charges registered at Companies House.</p>'
      : `<div class="ch-charges-list">
          ${charges.map((c) => `
            <div class="ch-charge-row">
              <div class="ch-charge-header">
                ${chargeBadge(c)}
                <span class="ch-charge-type">${escapeHtml(c.classification || "Charge")}</span>
                <span class="empty-hint">${escapeHtml(c.created_on || "")}</span>
              </div>
              ${c.holders.length > 0 ? `<div class="ch-charge-holders">Held by: <strong>${escapeHtml(c.holders.join(", "))}</strong></div>` : ""}
              ${c.description ? `<div class="ch-charge-desc empty-hint">${escapeHtml(c.description)}</div>` : ""}
            </div>`).join("")}
         </div>`}
  `;
}

function render(): void {
  if (!currentLead) return;
  const lead = currentLead;

  document.querySelector("#side-panel-title")!.textContent = lead.company;
  document.querySelector("#side-panel-info")!.innerHTML = `
    <dt>Source</dt><dd>${lead.source_url ? `<a href="${escapeHtml(lead.source_url)}" target="_blank">${escapeHtml(lead.source_url)}</a>` : "—"}</dd>
    <dt>Verification status</dt><dd>${escapeHtml(lead.status)}</dd>
    <dt>Research notes</dt><dd>${escapeHtml(lead.notes || "—")}</dd>
    <dt>Industry</dt><dd>${escapeHtml(lead.industry || "Uncategorized")}</dd>
    <dt>Contact status</dt><dd>${escapeHtml(lead.contact_status)}</dd>
    <dt>Owner</dt><dd>${escapeHtml(lead.owner_name || "—")}</dd>
    <dt>First looked up</dt><dd>${escapeHtml(new Date(lead.timestamp).toLocaleString())}</dd>
  `;

  (document.querySelector("#side-panel-notes") as HTMLTextAreaElement).value = lead.lead_notes;
  (document.querySelector("#detail-contact-name") as HTMLInputElement).value = lead.contact_name;
  (document.querySelector("#detail-contact-title") as HTMLInputElement).value = lead.contact_title;
  (document.querySelector("#detail-website") as HTMLInputElement).value = lead.website;
  (document.querySelector("#detail-linkedin") as HTMLInputElement).value = lead.linkedin;

  renderAssignment(lead);
  renderPhones(lead);
  renderEmails(lead);
  renderFollowUp(lead);
  renderChData(lead);
  renderIntelligence(lead);
}

function renderFollowUp(lead: Lead): void {
  const dateInput = document.querySelector<HTMLInputElement>("#follow-up-date-input")!;
  const current = document.querySelector<HTMLElement>("#follow-up-current")!;
  dateInput.value = lead.follow_up_at ? lead.follow_up_at.slice(0, 10) : "";
  if (lead.follow_up_at) {
    const d = new Date(lead.follow_up_at);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const isOverdue = d < today;
    const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    current.textContent = isOverdue ? `Overdue: ${label}` : `Scheduled: ${label}`;
    current.style.color = isOverdue ? "var(--danger)" : "var(--accent-text)";
  } else {
    current.textContent = "No follow-up scheduled";
    current.style.color = "";
  }
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function temperatureClass(t: "Hot" | "Warm" | "Cold"): string {
  return t === "Hot" ? "intel-hot" : t === "Warm" ? "intel-warm" : "intel-cold";
}

export function reportBodyHtml(r: LeadIntelligence | LeadIntelligenceVersion): string {
  const list = (items: string[]) =>
    items.length > 0
      ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`
      : '<p class="empty-hint">None identified</p>';

  return `
    <div class="intel-score-row">
      <span class="status-badge ${temperatureClass(r.lead_temperature)}">${escapeHtml(r.lead_temperature)} · ${r.lead_score}/100</span>
      <span class="empty-hint">
        Maturity ${r.score_breakdown.company_maturity} · Hiring ${r.score_breakdown.hiring_intensity} ·
        Growth ${r.score_breakdown.growth_signals} · Buying intent ${r.score_breakdown.buying_intent} ·
        Fit ${r.score_breakdown.accessibility_fit}
      </span>
    </div>

    <div class="intel-call-brief">
      <strong>Call Brief</strong>
      <p>${escapeHtml(r.call_brief)}</p>
    </div>

    <h5>Executive Summary</h5>
    <p>${escapeHtml(r.executive_summary)}</p>

    <h5>Sales Summary</h5>
    <p>${escapeHtml(r.sales_summary)}</p>

    <h5>Pain Points</h5>
    <p class="empty-hint">Operational</p>
    ${list(r.pain_points.operational)}
    <p class="empty-hint">Sales / Revenue</p>
    ${list(r.pain_points.sales_revenue)}
    <p class="empty-hint">Recruitment / Scaling</p>
    ${list(r.pain_points.recruitment_scaling)}

    <h5>Buying Signals</h5>
    ${list(r.buying_signals)}

    <h5>Conversation Starters</h5>
    ${list(r.conversation_starters)}

    <h5>Discovery Questions</h5>
    <ol>${r.discovery_questions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ol>

    <h5>Objection Handling</h5>
    <ul class="intel-objections">
      ${r.objection_handling
        .map(
          (o) =>
            `<li><strong>${escapeHtml(o.category)}:</strong> ${escapeHtml(o.objection)}<br/><span class="empty-hint">${escapeHtml(o.response)}</span></li>`
        )
        .join("")}
    </ul>

    <h5>Recommended Pitch Angle</h5>
    <p>${escapeHtml(r.pitch_angle)}</p>

    <h5>Confidence Note</h5>
    <p class="empty-hint">${escapeHtml(r.confidence_note)}</p>
  `;
}

function renderIntelligence(lead: Lead): void {
  const el = document.querySelector("#intelligence-section")!;
  const intel = lead.intelligence;

  if (!intel) {
    el.innerHTML = `
      <p class="empty-hint">No AI intelligence generated yet for this lead.</p>
      <div class="card-actions">
        <button id="generate-intelligence-btn" class="btn btn-secondary btn-sm">Generate AI Intelligence</button>
        <span id="intelligence-status" class="status-message"></span>
      </div>
    `;
    wireGenerateButton(lead);
    return;
  }

  const viewing = viewingVersionId ? intelligenceHistory?.find((v) => v.id === viewingVersionId) ?? null : null;
  const report = viewing ?? intel;

  el.innerHTML = `
    ${
      viewing
        ? `<div class="intel-history-banner">
             Viewing version from ${escapeHtml(formatDate(viewing.created_at))} — not the latest.
             <button id="back-to-latest-btn" class="btn btn-ghost btn-sm">Back to latest</button>
           </div>`
        : ""
    }
    ${reportBodyHtml(report)}
    <p class="empty-hint">Generated ${escapeHtml(formatDate(intel.generated_at))} · Updated ${escapeHtml(formatDate(intel.updated_at))}</p>
    <div class="card-actions">
      <button id="generate-intelligence-btn" class="btn btn-secondary btn-sm">Refresh AI Intelligence</button>
      <span id="intelligence-status" class="status-message"></span>
    </div>
    ${
      intel.version_count > 1
        ? `<button id="toggle-history-btn" class="btn btn-ghost btn-sm">
             ${intelligenceHistory ? "Hide" : "View"} history (${intel.version_count} versions)
           </button>
           <ul id="intelligence-history-list" class="history-list ${intelligenceHistory ? "" : "hidden"}"></ul>`
        : ""
    }
  `;

  wireGenerateButton(lead);

  document.querySelector("#back-to-latest-btn")?.addEventListener("click", () => {
    viewingVersionId = null;
    renderIntelligence(lead);
  });

  document.querySelector("#toggle-history-btn")?.addEventListener("click", async () => {
    if (intelligenceHistory) {
      intelligenceHistory = null;
      renderIntelligence(lead);
      return;
    }
    intelligenceHistory = await getLeadIntelligenceHistory(lead.id);
    renderIntelligence(lead);
  });

  if (intelligenceHistory) {
    const listEl = document.querySelector("#intelligence-history-list")!;
    listEl.innerHTML = intelligenceHistory
      .map(
        (v) => `
        <li class="history-list-row">
          <span>${escapeHtml(formatDate(v.created_at))} — ${escapeHtml(v.lead_temperature)} · ${v.lead_score}/100</span>
          <button class="btn btn-ghost btn-sm view-version-btn" data-version-id="${escapeHtml(v.id)}">View</button>
        </li>`
      )
      .join("");
    listEl.querySelectorAll<HTMLButtonElement>(".view-version-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        viewingVersionId = btn.dataset.versionId!;
        renderIntelligence(lead);
      });
    });
  }
}

function wireGenerateButton(lead: Lead): void {
  const btn = document.querySelector<HTMLButtonElement>("#generate-intelligence-btn")!;
  btn.disabled = intelligenceOnCooldown;
  btn.addEventListener("click", () => void handleGenerateClick(lead));
}

async function handleGenerateClick(lead: Lead): Promise<void> {
  if (!onGenerateIntelligence) return;
  intelligenceOnCooldown = true;
  if (intelligenceCooldownTimer) clearTimeout(intelligenceCooldownTimer);

  const btn = document.querySelector<HTMLButtonElement>("#generate-intelligence-btn");
  const status = document.querySelector<HTMLSpanElement>("#intelligence-status");
  if (btn) btn.disabled = true;
  if (status) {
    status.textContent = "Researching… this uses more Anthropic credits than other lookups and may take up to a minute.";
  }

  try {
    await onGenerateIntelligence(lead.id);
    viewingVersionId = null;
    intelligenceHistory = null;
    // Cooldown continues for 20s after success to discourage accidental
    // repeat-click cost spam — re-queried by id since the section above
    // re-renders (and replaces this button) as soon as the lead refreshes.
    intelligenceCooldownTimer = setTimeout(() => {
      intelligenceOnCooldown = false;
      const freshBtn = document.querySelector<HTMLButtonElement>("#generate-intelligence-btn");
      if (freshBtn) freshBtn.disabled = false;
    }, 20000);
  } catch (err) {
    intelligenceOnCooldown = false;
    const freshStatus = document.querySelector<HTMLSpanElement>("#intelligence-status");
    if (freshStatus) freshStatus.textContent = String(err);
    const freshBtn = document.querySelector<HTMLButtonElement>("#generate-intelligence-btn");
    if (freshBtn) freshBtn.disabled = false;
  }
}

function renderAssignment(lead: Lead): void {
  const el = document.querySelector("#assignment-section")!;
  el.innerHTML = `
    <select id="assign-select" class="inline-edit">
      <option value="">Unassigned</option>
      ${teamMembers
        .map(
          (m) =>
            `<option value="${escapeHtml(m.id)}" ${m.id === lead.assigned_user_id ? "selected" : ""}>${escapeHtml(m.name)}</option>`
        )
        .join("")}
    </select>
  `;
  document.querySelector("#assign-select")!.addEventListener("change", async (event) => {
    if (!currentLead || !onAssign) return;
    const value = (event.target as HTMLSelectElement).value;
    await onAssign(currentLead.id, value.length > 0 ? value : null);
  });
}

function renderPhones(lead: Lead): void {
  const el = document.querySelector("#phones-section")!;
  if (lead.phones.length === 0) {
    el.innerHTML = '<p class="empty-hint">No phone numbers yet</p>';
    return;
  }
  el.innerHTML = lead.phones.map((p) => phoneRowHtml(p)).join("");

  el.querySelectorAll<HTMLButtonElement>(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => void copyToClipboard(btn.dataset.value!));
  });
  el.querySelectorAll<HTMLButtonElement>(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingPhoneId = btn.dataset.id!;
      renderPhones(lead);
    });
  });
  el.querySelectorAll<HTMLButtonElement>(".cancel-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingPhoneId = null;
      renderPhones(lead);
    });
  });
  el.querySelectorAll<HTMLButtonElement>(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!currentLead || !onDeletePhone) return;
      await onDeletePhone(currentLead.id, btn.dataset.id!);
    });
  });
  el.querySelectorAll<HTMLFormElement>(".edit-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>("input")!;
      const value = input.value.trim();
      if (!PHONE_PATTERN.test(value) || !currentLead || !onUpdatePhone) return;
      await onUpdatePhone(currentLead.id, form.dataset.id!, value);
      editingPhoneId = null;
    });
  });
}

function phoneRowHtml(p: PhoneEntry): string {
  if (p.id === editingPhoneId) {
    return `
      <form class="contact-row edit-form" data-id="${escapeHtml(p.id)}">
        <input type="text" class="inline-edit contact-row-edit-input" value="${escapeHtml(p.phone_number)}" />
        <button type="submit" class="icon-btn" title="Save">✓</button>
        <button type="button" class="icon-btn cancel-edit-btn" title="Cancel">✕</button>
      </form>
    `;
  }
  return `
    <div class="contact-row">
      <span class="contact-row-value">${escapeHtml(p.phone_number)}</span>
      ${p.source === "scraped" ? '<span class="empty-hint">scraped</span>' : ""}
      <a class="icon-btn" href="tel:${escapeHtml(p.phone_number)}" title="Call"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></a>
      <button class="icon-btn copy-btn" type="button" data-value="${escapeHtml(p.phone_number)}" title="Copy">⧉</button>
      <button class="icon-btn edit-btn" type="button" data-id="${escapeHtml(p.id)}" title="Edit">✎</button>
      <button class="icon-btn delete-btn" type="button" data-id="${escapeHtml(p.id)}" title="Delete">✕</button>
    </div>
  `;
}

function renderEmails(lead: Lead): void {
  const el = document.querySelector("#emails-section")!;
  if (lead.emails.length === 0) {
    el.innerHTML = '<p class="empty-hint">No email addresses yet</p>';
    return;
  }
  el.innerHTML =
    lead.emails.map((e) => emailRowHtml(e)).join("") +
    `<button class="btn btn-ghost btn-sm" id="verify-emails-btn" type="button"
       title="Free checks: does the domain accept mail, and does the address match the contact or a director">
       Verify addresses</button>
     <span id="verify-emails-status" class="empty-hint"></span>`;

  el.querySelector<HTMLButtonElement>("#verify-emails-btn")!.addEventListener("click", async () => {
    const btn = el.querySelector<HTMLButtonElement>("#verify-emails-btn")!;
    const status = el.querySelector<HTMLSpanElement>("#verify-emails-status")!;
    btn.disabled = true;
    status.textContent = "Checking…";
    try {
      const { verifyLeadEmails } = await import("../api");
      const updated = await verifyLeadEmails(lead.id);
      currentLead = updated;
      renderEmails(updated);
    } catch (err) {
      status.textContent = String(err);
      btn.disabled = false;
    }
  });

  el.querySelectorAll<HTMLButtonElement>(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => void copyToClipboard(btn.dataset.value!));
  });
  el.querySelectorAll<HTMLButtonElement>(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingEmailId = btn.dataset.id!;
      renderEmails(lead);
    });
  });
  el.querySelectorAll<HTMLButtonElement>(".cancel-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingEmailId = null;
      renderEmails(lead);
    });
  });
  el.querySelectorAll<HTMLButtonElement>(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!currentLead || !onDeleteEmail) return;
      await onDeleteEmail(currentLead.id, btn.dataset.id!);
    });
  });
  el.querySelectorAll<HTMLFormElement>(".edit-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>("input")!;
      const value = input.value.trim();
      if (!EMAIL_PATTERN.test(value) || !currentLead || !onUpdateEmail) return;
      await onUpdateEmail(currentLead.id, form.dataset.id!, value);
      editingEmailId = null;
    });
  });
}

/** Two-part badge: deliverability (domain) + who the address belongs to.
 * Hover shows the full explanation. */
function verifyBadgeHtml(e: EmailEntry): string {
  const status = e.verify_status ?? "unchecked";
  if (status === "unchecked") return "";
  const title = escapeHtml(e.verify_detail ?? "");

  let cls = "unverified";
  let label = "domain?";
  if (status === "undeliverable") { cls = "not_found"; label = "dead domain"; }
  else if (status === "deliverable") { cls = "verified"; label = "deliverable"; }
  else { cls = "unverified"; label = "risky"; }

  const match = e.person_match ?? "unknown";
  let personHtml = "";
  if (match === "person") personHtml = `<span class="status-badge verified" title="${title}">matches contact</span>`;
  else if (match === "director") personHtml = `<span class="status-badge verified" title="${title}">matches director</span>`;
  else if (match === "generic") personHtml = `<span class="status-badge unverified" title="${title}">generic inbox</span>`;
  else if (match === "mismatch") personHtml = `<span class="status-badge not_found" title="${title}">name mismatch</span>`;

  return `<span class="status-badge ${cls}" title="${title}">${label}</span>${personHtml}`;
}

function emailRowHtml(e: EmailEntry): string {
  if (e.id === editingEmailId) {
    return `
      <form class="contact-row edit-form" data-id="${escapeHtml(e.id)}">
        <input type="email" class="inline-edit contact-row-edit-input" value="${escapeHtml(e.email)}" />
        <button type="submit" class="icon-btn" title="Save">✓</button>
        <button type="button" class="icon-btn cancel-edit-btn" title="Cancel">✕</button>
      </form>
    `;
  }
  return `
    <div class="contact-row">
      <span class="contact-row-value">${escapeHtml(e.email)}</span>
      ${verifyBadgeHtml(e)}
      ${e.source === "scraped" ? '<span class="empty-hint">scraped</span>' : ""}
      <a class="icon-btn" href="mailto:${escapeHtml(e.email)}" title="Email">✉</a>
      <button class="icon-btn copy-btn" type="button" data-value="${escapeHtml(e.email)}" title="Copy">⧉</button>
      <button class="icon-btn edit-btn" type="button" data-id="${escapeHtml(e.id)}" title="Edit">✎</button>
      <button class="icon-btn delete-btn" type="button" data-id="${escapeHtml(e.id)}" title="Delete">✕</button>
    </div>
  `;
}

export function openSidePanel(lead: Lead): void {
  currentLead = lead;
  editingPhoneId = null;
  editingEmailId = null;
  viewingVersionId = null;
  intelligenceHistory = null;
  render();
  document.querySelector("#side-panel")!.classList.remove("hidden");
}

export function closeSidePanel(): void {
  document.querySelector("#side-panel")!.classList.add("hidden");
  currentLead = null;
}

/** Keeps the panel in sync if the underlying lead list changes while it's open (e.g. after a refresh). */
export function refreshIfOpen(leads: Lead[]): void {
  if (!currentLead) return;
  const updated = leads.find((l) => l.id === currentLead!.id);
  if (updated) {
    currentLead = updated;
    render();
  }
}

/** Team roster, used to populate the "Assign to" dropdown. */
export function setTeamMembers(members: UserInfo[]): void {
  teamMembers = members;
  if (currentLead) renderAssignment(currentLead);
}

export interface SidePanelCallbacks {
  onSaveNotes: (id: string, notes: string) => Promise<void>;
  onSaveDetails: (id: string, contactName: string, contactTitle: string, website: string, linkedin: string) => Promise<void>;
  onAssign: (id: string, assignedUserId: string | null) => Promise<void>;
  onAddPhone: (id: string, phoneNumber: string) => Promise<void>;
  onUpdatePhone: (id: string, phoneId: string, phoneNumber: string) => Promise<void>;
  onDeletePhone: (id: string, phoneId: string) => Promise<void>;
  onAddEmail: (id: string, email: string) => Promise<void>;
  onUpdateEmail: (id: string, emailId: string, email: string) => Promise<void>;
  onDeleteEmail: (id: string, emailId: string) => Promise<void>;
  /** Independent AI scraper — separate action from phone lookup, never automatic. */
  onScrapeEmail: (id: string) => Promise<void>;
  /** Manual trigger only — also used for "Refresh" (same backend action). Never automatic. */
  onGenerateIntelligence: (id: string) => Promise<void>;
}

/** Swaps which handlers the panel's already-wired buttons invoke, without
 * re-attaching DOM listeners. Call this (not `initSidePanel`) when a
 * different view — e.g. a cold call list — needs the same panel to act on
 * its own lead set instead of the Dashboard's. */
export function setSidePanelCallbacks(callbacks: SidePanelCallbacks): void {
  onAssign = callbacks.onAssign;
  onAddPhone = callbacks.onAddPhone;
  onUpdatePhone = callbacks.onUpdatePhone;
  onDeletePhone = callbacks.onDeletePhone;
  onAddEmail = callbacks.onAddEmail;
  onUpdateEmail = callbacks.onUpdateEmail;
  onDeleteEmail = callbacks.onDeleteEmail;
  onSaveNotes = callbacks.onSaveNotes;
  onSaveDetails = callbacks.onSaveDetails;
  onScrapeEmail = callbacks.onScrapeEmail;
  onGenerateIntelligence = callbacks.onGenerateIntelligence;
}

/** Wires the panel's DOM listeners exactly once (called from Dashboard's
 * startup). Use `setSidePanelCallbacks` elsewhere to swap behavior. */
export function initSidePanel(callbacks: SidePanelCallbacks): void {
  setSidePanelCallbacks(callbacks);

  document.querySelector("#side-panel-close-btn")!.addEventListener("click", closeSidePanel);
  document.querySelector("#write-email-btn")!.addEventListener("click", () => {
    if (!currentLead) return;
    setPendingEmailWriterLead(currentLead.id);
    closeSidePanel();
    openTab("outreach", "Outreach");
  });
  document.querySelector("#side-panel-save-notes-btn")!.addEventListener("click", async () => {
    if (!currentLead) return;
    const notes = (document.querySelector("#side-panel-notes") as HTMLTextAreaElement).value;
    await onSaveNotes!(currentLead.id, notes);
  });

  document.querySelector("#save-details-btn")!.addEventListener("click", async () => {
    if (!currentLead) return;
    const contactName = (document.querySelector("#detail-contact-name") as HTMLInputElement).value.trim();
    const contactTitle = (document.querySelector("#detail-contact-title") as HTMLInputElement).value.trim();
    const website = (document.querySelector("#detail-website") as HTMLInputElement).value.trim();
    const linkedin = (document.querySelector("#detail-linkedin") as HTMLInputElement).value.trim();
    await onSaveDetails!(currentLead.id, contactName, contactTitle, website, linkedin);
  });

  const phoneInput = document.querySelector<HTMLInputElement>("#add-phone-input")!;
  const phoneError = document.querySelector<HTMLSpanElement>("#add-phone-error")!;
  document.querySelector("#add-phone-btn")!.addEventListener("click", async () => {
    const value = phoneInput.value.trim();
    if (!currentLead) return;
    if (!PHONE_PATTERN.test(value)) {
      phoneError.textContent = "That doesn't look like a valid phone number.";
      return;
    }
    phoneError.textContent = "";
    try {
      await onAddPhone!(currentLead.id, value);
      phoneInput.value = "";
    } catch (err) {
      phoneError.textContent = String(err);
    }
  });

  // Follow-up scheduling
  const followUpDateInput = document.querySelector<HTMLInputElement>("#follow-up-date-input")!;
  document.querySelectorAll<HTMLButtonElement>(".follow-up-quick").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!currentLead) return;
      const days = parseInt(btn.dataset.days ?? "0", 10);
      const d = new Date(); d.setDate(d.getDate() + days);
      const iso = d.toISOString().slice(0, 10) + "T09:00:00";
      currentLead = await setLeadFollowUp(currentLead.id, iso);
      renderFollowUp(currentLead);
    });
  });
  document.querySelector("#follow-up-set-btn")!.addEventListener("click", async () => {
    if (!currentLead || !followUpDateInput.value) return;
    currentLead = await setLeadFollowUp(currentLead.id, followUpDateInput.value + "T09:00:00");
    renderFollowUp(currentLead);
  });
  document.querySelector("#follow-up-clear-btn")!.addEventListener("click", async () => {
    if (!currentLead) return;
    currentLead = await setLeadFollowUp(currentLead.id, null);
    renderFollowUp(currentLead);
  });

  const emailInput = document.querySelector<HTMLInputElement>("#add-email-input")!;
  const emailError = document.querySelector<HTMLSpanElement>("#add-email-error")!;
  document.querySelector("#add-email-btn")!.addEventListener("click", async () => {
    const value = emailInput.value.trim();
    if (!currentLead) return;
    if (!EMAIL_PATTERN.test(value)) {
      emailError.textContent = "That doesn't look like a valid email address.";
      return;
    }
    emailError.textContent = "";
    try {
      await onAddEmail!(currentLead.id, value);
      emailInput.value = "";
    } catch (err) {
      emailError.textContent = String(err);
    }
  });

  const scrapeBtn = document.querySelector<HTMLButtonElement>("#scrape-email-btn")!;
  const scrapeStatus = document.querySelector<HTMLSpanElement>("#scrape-email-status")!;
  scrapeBtn.addEventListener("click", async () => {
    if (!currentLead) return;
    scrapeBtn.disabled = true;
    scrapeStatus.textContent = "Scraping… this uses Anthropic credits.";
    try {
      await onScrapeEmail!(currentLead.id);
      scrapeStatus.textContent = "";
    } catch (err) {
      scrapeStatus.textContent = `Scrape failed: ${err}`;
    } finally {
      scrapeBtn.disabled = false;
    }
  });
}
