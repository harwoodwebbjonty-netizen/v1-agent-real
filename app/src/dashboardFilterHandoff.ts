// Same lightweight handoff pattern as emailWriterHandoff.ts — lets Analytics'
// funnel rows filter the Dashboard down to a contact-status stage without
// duplicating Dashboard's own filtering UI.

let pendingMinRank: number | null = null;

export function setPendingDashboardContactStatusFilter(minRank: number): void {
  pendingMinRank = minRank;
}

export function consumePendingDashboardContactStatusFilter(): number | null {
  const rank = pendingMinRank;
  pendingMinRank = null;
  return rank;
}
