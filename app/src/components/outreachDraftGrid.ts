import { type EmailProvider, type ListCampaignDraft, sendEmailDraft, updateEmailDraft } from "../api";
import { CONTACT_STATUS_ORDER } from "../constants";
import { escapeHtml, renderEmailBodyHtml } from "../utils";

// Shared review/edit/send grid for a batch of email_drafts — used by both
// "whole list" campaigns (server-generated, async) and "specific leads"
// composition (generated client-side, one at a time). Either way these are
// ordinary email_drafts rows, so editing/sending reuses the same endpoints
// list_campaigns.py already established. See listCampaign.ts for the
// original single-purpose version this was extracted from.

const renderBodyHtml = renderEmailBodyHtml;

function draftCardHtml(d: ListCampaignDraft, canSend: boolean): string {
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
        ${sent || noEmail || !canSend ? "" : `<button class="btn btn-ghost btn-sm lc-send-btn">Send</button>`}
        <span class="status-message lc-draft-status"></span>
      </div>
    </div>`;
}

/** Renders a status-grouped grid of draft cards into `container` and wires
 * edit/save/send on each. Drafts are mutated in place on save/send so the
 * caller's own array stays in sync; `onChange` fires after any mutation so
 * the caller can refresh surrounding chrome (counts, "sent" messaging). */
export function renderDraftGrid(
  container: HTMLElement,
  drafts: ListCampaignDraft[],
  provider: EmailProvider,
  hasAccount: boolean,
  onChange: () => void
): void {
  if (drafts.length === 0) {
    container.innerHTML = `<p class="empty-state">No drafts to show.</p>`;
    return;
  }

  const sections = CONTACT_STATUS_ORDER.map((st) => {
    const group = drafts.filter((d) => (d.contact_status || "New") === st);
    if (group.length === 0) return "";
    return `
      <section class="card">
        <h3 class="card-title">${escapeHtml(st)} <span class="empty-hint">· ${group.length}</span></h3>
        <div class="lc-draft-list">${group.map((d) => draftCardHtml(d, hasAccount)).join("")}</div>
      </section>`;
  }).join("");

  const ungrouped = drafts.filter((d) => !CONTACT_STATUS_ORDER.includes(d.contact_status || "New"));
  const otherSection = ungrouped.length > 0
    ? `<section class="card"><h3 class="card-title">Other <span class="empty-hint">· ${ungrouped.length}</span></h3>
       <div class="lc-draft-list">${ungrouped.map((d) => draftCardHtml(d, hasAccount)).join("")}</div></section>`
    : "";

  container.innerHTML = sections + otherSection;

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
        onChange();
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
        onChange();
      } catch (err) {
        cardStatus.textContent = String(err);
        sendBtn.disabled = false;
      }
    })());
  });
}
