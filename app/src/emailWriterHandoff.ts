// Tiny shared state so the side panel's "Write Email" button can hand off
// which lead to pre-load when it opens the Email Writer tab — same
// lightweight-module-state style as everything else in this app.

let pendingLeadId: string | null = null;

export function setPendingEmailWriterLead(leadId: string): void {
  pendingLeadId = leadId;
}

export function consumePendingEmailWriterLead(): string | null {
  const id = pendingLeadId;
  pendingLeadId = null;
  return id;
}
