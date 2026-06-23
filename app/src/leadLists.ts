import { listLeadLists, type LeadList } from "./api";

let lists: LeadList[] = [];
const listeners = new Set<() => void>();

export function getLeadLists(): LeadList[] {
  return lists;
}

export function subscribeLeadLists(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshLeadLists(): Promise<void> {
  lists = await listLeadLists();
  listeners.forEach((fn) => fn());
}
