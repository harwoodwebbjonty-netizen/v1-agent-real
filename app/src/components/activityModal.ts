import type { ActivityEvent, Lead } from "../api";
import { listLeadActivity, triggerLeadRefresh } from "../api";
import { escapeHtml } from "../utils";

function eventLabel(type: string): string {
  return type.replace(/_/g, " ");
}

function formatDetected(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = diffMs / 3600000;
  if (diffH < 1) return "just now";
  if (diffH < 24) return `${Math.floor(diffH)}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function renderEventRow(event: ActivityEvent): string {
  const label = eventLabel(event.event_type);
  const badgeClass = `event-badge event-badge-${event.event_type}`;
  const timeStr = formatDetected(event.detected_at);
  const occurredStr = event.occurred_at ? ` · ${event.occurred_at}` : "";
  return `
    <div class="activity-event-row">
      <div class="activity-event-body">
        <div class="activity-event-header">
          <span class="${badgeClass}">${escapeHtml(label)}</span>
          <span class="activity-event-desc">${escapeHtml(event.description)}</span>
          <span class="activity-event-time">${escapeHtml(timeStr)}${escapeHtml(occurredStr)}</span>
        </div>
      </div>
    </div>
  `;
}

export function openActivityModal(lead: Lead): void {
  const overlay = document.getElementById("activity-modal-overlay");
  const container = document.getElementById("activity-modal-content");
  if (!overlay || !container) return;

  // Show modal immediately with loading state
  overlay.classList.remove("hidden");
  container.innerHTML = `
    <div class="activity-modal-header">
      <div>
        <div class="activity-modal-title">${escapeHtml(lead.company)}</div>
        ${lead.company_number
          ? `<div class="activity-modal-subtitle">CH: ${escapeHtml(lead.company_number)}</div>`
          : `<div class="activity-modal-subtitle text-muted">No Companies House number</div>`
        }
      </div>
      <button class="modal-close-btn" id="activity-modal-close" type="button">✕</button>
    </div>
    <div class="activity-modal-body" id="activity-modal-body">
      <div class="activity-loading">Loading activity…</div>
    </div>
    <div class="activity-modal-footer">
      <button class="btn btn-secondary btn-sm" id="activity-refresh-btn" type="button"
        ${!lead.company_number ? "disabled" : ""}>
        Refresh Now
      </button>
      ${lead.last_dg_refreshed_at
        ? `<span class="activity-modal-last-refreshed">Last refreshed: ${formatDetected(lead.last_dg_refreshed_at)}</span>`
        : ""
      }
    </div>
  `;

  const closeBtn = document.getElementById("activity-modal-close");
  closeBtn?.addEventListener("click", closeActivityModal);

  const refreshBtn = document.getElementById("activity-refresh-btn") as HTMLButtonElement | null;
  refreshBtn?.addEventListener("click", () => void handleRefresh(lead, refreshBtn!));

  // Load events
  void loadEvents(lead);
}

async function loadEvents(lead: Lead): Promise<void> {
  const body = document.getElementById("activity-modal-body");
  if (!body) return;

  try {
    const events = await listLeadActivity(lead.id);
    if (!lead.company_number) {
      body.innerHTML = `<div class="activity-empty-state">
        <p>This lead has no Companies House number. Activity feed requires a CH-linked company.</p>
        <p class="text-muted">Add the CH number via the lead details panel, then trigger a manual refresh.</p>
      </div>`;
      return;
    }
    if (events.length === 0) {
      body.innerHTML = `<div class="activity-empty-state">
        <p>No activity detected yet.</p>
        <p class="text-muted">The background scheduler checks for changes automatically. Click "Refresh Now" to check immediately.</p>
      </div>`;
      return;
    }
    body.innerHTML = events.map(renderEventRow).join("");
  } catch {
    body.innerHTML = `<div class="activity-empty-state text-danger">Failed to load activity. Please try again.</div>`;
  }
}

async function handleRefresh(lead: Lead, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    await triggerLeadRefresh(lead.id);
    // Brief wait then reload — the backend fires-and-forgets, so give it 2s
    await new Promise((r) => setTimeout(r, 2000));
    void loadEvents(lead);
    btn.textContent = "Refresh Now";
    btn.disabled = false;
  } catch {
    btn.textContent = "Refresh Now";
    btn.disabled = false;
  }
}

export function closeActivityModal(): void {
  document.getElementById("activity-modal-overlay")?.classList.add("hidden");
}

export function initActivityModalOverlay(): void {
  const overlay = document.getElementById("activity-modal-overlay");
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) closeActivityModal();
  });
}

/** Call this after renderRows() to batch-load pulse dots for all visible leads. */
export function updatePulseDots(
  tbody: HTMLTableSectionElement,
  summaries: Record<string, { count: number; latest_detected_at: string | null; has_recent_24h: boolean }>
): void {
  const dots = tbody.querySelectorAll<HTMLElement>(".activity-dot[data-lead-id]");
  const now = Date.now();
  dots.forEach((dot) => {
    const id = dot.dataset.leadId!;
    const summary = summaries[id];
    if (!summary || summary.count === 0) {
      dot.className = "activity-dot pulse-none";
      dot.title = "No activity detected yet";
      return;
    }
    const latest = summary.latest_detected_at ? new Date(summary.latest_detected_at).getTime() : 0;
    const ageH = (now - latest) / 3600000;
    let pulseClass = "pulse-slow";
    if (ageH < 24) pulseClass = "pulse-fast";
    else if (ageH < 72) pulseClass = "pulse-medium";
    dot.className = `activity-dot ${pulseClass}`;
    dot.title = `${summary.count} event${summary.count === 1 ? "" : "s"} · last ${formatDetected(summary.latest_detected_at!)}`;
  });
}
