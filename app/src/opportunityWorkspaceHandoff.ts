// Same lightweight handoff pattern as emailWriterHandoff.ts — lets any view
// deep-link into a specific lead's Opportunity Workspace.

let pendingLeadId: string | null = null;

export function setPendingOpportunityWorkspaceLead(leadId: string): void {
  pendingLeadId = leadId;
}

export function consumePendingOpportunityWorkspaceLead(): string | null {
  const id = pendingLeadId;
  pendingLeadId = null;
  return id;
}
