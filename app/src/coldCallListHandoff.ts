// Tiny shared state so Today's "Carry on calling" button can hand off which
// list to jump straight into when it opens the Cold Call Lists tab — same
// lightweight-module-state style as emailWriterHandoff.ts.

let pendingListId: string | null = null;

export function setPendingColdCallList(listId: string): void {
  pendingListId = listId;
}

export function consumePendingColdCallList(): string | null {
  const id = pendingListId;
  pendingListId = null;
  return id;
}
