import {
  type Sequence,
  type SequenceEnrollment,
  type SequenceStep,
  type SequenceStepType,
  addSequenceStep,
  createSequence,
  deleteSequence,
  deleteSequenceStep,
  enrollLeadInSequence,
  listSequenceEnrollments,
  listSequenceSteps,
  listSequences,
  stopSequenceEnrollment,
  updateSequence,
} from "../api";
import { getLeads, subscribe } from "../state";
import { showToast } from "../toast";
import { escapeHtml } from "../utils";

const STEP_TYPE_LABELS: Record<SequenceStepType, string> = {
  email: "Send Email",
  call_task: "Call Task",
  followup_task: "Follow-up Task",
  reminder_task: "Reminder Task",
};

export function initSequences(): void {
  const container = document.querySelector<HTMLDivElement>("#view-sequences")!;
  let sequences: Sequence[] = [];
  let selectedSequenceId: string | null = null;
  let steps: SequenceStep[] = [];
  let enrollments: SequenceEnrollment[] = [];

  async function refreshSequences(): Promise<void> {
    sequences = await listSequences();
    render();
  }

  async function refreshDetail(): Promise<void> {
    if (!selectedSequenceId) return;
    [steps, enrollments] = await Promise.all([
      listSequenceSteps(selectedSequenceId),
      listSequenceEnrollments(selectedSequenceId),
    ]);
    render();
  }

  function renderList(): void {
    container.innerHTML = `
      <main class="container">
        <section class="card-title-row">
          <h2 class="card-title">Sequences</h2>
        </section>
        <p class="card-subtitle">Multi-step outreach — email steps send for real, task steps create real calendar tasks.</p>

        <section class="card">
          <div class="new-list-form">
            <input id="seq-new-name" type="text" class="search-input" placeholder="New sequence name..." style="max-width: 320px" />
            <button type="button" id="seq-create-btn" class="btn btn-primary">Create Sequence</button>
          </div>
        </section>

        <div class="action-section-body" style="margin-top: var(--space-4)">
          ${
            sequences.length
              ? sequences
                  .map(
                    (seq) => `
              <div class="card sequence-row" data-sequence-id="${escapeHtml(seq.id)}">
                <div class="call-queue-card-header">
                  <div>
                    <h3 class="call-queue-company">${escapeHtml(seq.name)}</h3>
                    <div class="call-queue-meta">
                      <span class="status-badge ${seq.status === "active" ? "verified" : seq.status === "paused" ? "unverified" : "not_found"}">${escapeHtml(seq.status)}</span>
                      <span class="empty-hint">${seq.step_count} step(s) · ${seq.enrollment_count} enrolled</span>
                    </div>
                  </div>
                  <div class="card-actions">
                    <button type="button" class="btn btn-ghost btn-sm seq-toggle-btn">${seq.status === "active" ? "Pause" : "Activate"}</button>
                    <button type="button" class="btn btn-secondary btn-sm seq-manage-btn">Manage</button>
                    <button type="button" class="btn btn-danger-ghost btn-sm seq-delete-btn">Delete</button>
                  </div>
                </div>
              </div>`
                  )
                  .join("")
              : `<p class="empty-hint">No sequences yet — create one above.</p>`
          }
        </div>
      </main>
    `;

    container.querySelector<HTMLButtonElement>("#seq-create-btn")!.addEventListener("click", async () => {
      const input = container.querySelector<HTMLInputElement>("#seq-new-name")!;
      const name = input.value.trim();
      if (!name) return;
      await createSequence(name);
      input.value = "";
      await refreshSequences();
    });

    container.querySelectorAll<HTMLElement>(".sequence-row").forEach((row) => {
      const id = row.dataset.sequenceId!;
      row.querySelector(".seq-manage-btn")!.addEventListener("click", () => {
        selectedSequenceId = id;
        void refreshDetail();
      });
      row.querySelector(".seq-toggle-btn")!.addEventListener("click", async () => {
        const seq = sequences.find((s) => s.id === id)!;
        await updateSequence(id, { status: seq.status === "active" ? "paused" : "active" });
        await refreshSequences();
      });
      row.querySelector(".seq-delete-btn")!.addEventListener("click", async () => {
        await deleteSequence(id);
        await refreshSequences();
      });
    });
  }

  function renderDetail(): void {
    const sequence = sequences.find((s) => s.id === selectedSequenceId);
    if (!sequence) {
      selectedSequenceId = null;
      renderList();
      return;
    }
    const enrolledLeadIds = new Set(enrollments.filter((e) => e.status === "active").map((e) => e.lead_id));
    const availableLeads = getLeads().filter((l) => !enrolledLeadIds.has(l.id));

    container.innerHTML = `
      <main class="container">
        <button type="button" class="btn btn-ghost btn-sm" id="seq-back-btn">&larr; All Sequences</button>

        <section class="card">
          <h2 class="call-queue-company">${escapeHtml(sequence.name)}</h2>
          <span class="status-badge ${sequence.status === "active" ? "verified" : sequence.status === "paused" ? "unverified" : "not_found"}">${escapeHtml(sequence.status)}</span>
        </section>

        <section class="card">
          <h3 class="action-section-title">Steps</h3>
          ${
            steps.length
              ? `<ul class="history-list">${steps
                  .map(
                    (step, i) => `
                <li class="history-list-row" data-step-id="${escapeHtml(step.id)}">
                  <span><strong>${i + 1}.</strong> ${escapeHtml(STEP_TYPE_LABELS[step.step_type])} — Day ${step.delay_days}${step.subject_template ? `: ${escapeHtml(step.subject_template)}` : ""}</span>
                  <button type="button" class="btn btn-ghost btn-sm seq-delete-step-btn">Remove</button>
                </li>`
                  )
                  .join("")}</ul>`
              : `<p class="empty-hint">No steps yet — add one below.</p>`
          }
          <form id="seq-add-step-form" class="call-outcome-form" style="margin-top: var(--space-3)">
            <div class="call-outcome-row">
              <select id="seq-step-type" class="inline-edit" required>
                ${Object.entries(STEP_TYPE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
              </select>
              <input type="number" min="0" id="seq-step-delay" class="search-input" placeholder="Delay (days)" value="0" style="width: 160px" />
            </div>
            <input type="text" id="seq-step-subject" class="search-input" placeholder="Subject / task title (supports {{first_name}}, {{company}}, ...)" />
            <textarea id="seq-step-body" rows="3" placeholder="Body / description"></textarea>
            <div class="card-actions">
              <button type="submit" class="btn btn-secondary btn-sm">Add Step</button>
            </div>
          </form>
        </section>

        <section class="card">
          <h3 class="action-section-title">Enrolled Leads</h3>
          <div class="new-list-form">
            <select id="seq-enroll-select" class="inline-edit" style="max-width: 320px">
              <option value="" disabled selected>Select a lead to enroll...</option>
              ${availableLeads.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.company)}</option>`).join("")}
            </select>
            <button type="button" id="seq-enroll-btn" class="btn btn-primary btn-sm">Enroll</button>
          </div>
          ${
            enrollments.length
              ? `<ul class="history-list" style="margin-top: var(--space-3)">${enrollments
                  .map(
                    (e) => `
                <li class="history-list-row" data-enrollment-id="${escapeHtml(e.id)}">
                  <span>${escapeHtml(e.lead_company)} — step ${e.current_step + 1}/${steps.length}</span>
                  <span class="status-badge ${e.status === "active" ? "verified" : e.status === "completed" ? "intel-cold" : "not_found"}" title="${escapeHtml(e.last_error || "")}">${escapeHtml(e.status)}</span>
                  ${e.status === "active" ? `<button type="button" class="btn btn-ghost btn-sm seq-stop-enrollment-btn">Stop</button>` : ""}
                </li>`
                  )
                  .join("")}</ul>`
              : `<p class="empty-hint">No leads enrolled yet.</p>`
          }
        </section>
      </main>
    `;

    container.querySelector<HTMLButtonElement>("#seq-back-btn")!.addEventListener("click", () => {
      selectedSequenceId = null;
      renderList();
    });

    container.querySelector<HTMLFormElement>("#seq-add-step-form")!.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const stepType = container.querySelector<HTMLSelectElement>("#seq-step-type")!.value as SequenceStepType;
      const delayDays = Number(container.querySelector<HTMLInputElement>("#seq-step-delay")!.value || 0);
      const subject = container.querySelector<HTMLInputElement>("#seq-step-subject")!.value;
      const body = container.querySelector<HTMLTextAreaElement>("#seq-step-body")!.value;
      await addSequenceStep(sequence.id, delayDays, stepType, subject, body);
      await refreshDetail();
      await refreshSequences();
    });

    container.querySelectorAll<HTMLElement>("[data-step-id]").forEach((row) => {
      row.querySelector(".seq-delete-step-btn")?.addEventListener("click", async () => {
        await deleteSequenceStep(sequence.id, row.dataset.stepId!);
        await refreshDetail();
        await refreshSequences();
      });
    });

    container.querySelector<HTMLButtonElement>("#seq-enroll-btn")!.addEventListener("click", async () => {
      const select = container.querySelector<HTMLSelectElement>("#seq-enroll-select")!;
      if (!select.value) return;
      try {
        await enrollLeadInSequence(sequence.id, select.value);
        showToast("Lead enrolled");
        await refreshDetail();
        await refreshSequences();
      } catch (err) {
        showToast(`Could not enroll: ${err}`);
      }
    });

    container.querySelectorAll<HTMLElement>("[data-enrollment-id]").forEach((row) => {
      row.querySelector(".seq-stop-enrollment-btn")?.addEventListener("click", async () => {
        await stopSequenceEnrollment(sequence.id, row.dataset.enrollmentId!);
        await refreshDetail();
      });
    });
  }

  function render(): void {
    if (selectedSequenceId) {
      renderDetail();
    } else {
      renderList();
    }
  }

  subscribe(render);
  void refreshSequences();
}
