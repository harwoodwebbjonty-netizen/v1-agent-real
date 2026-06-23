import { getLogEntries, type Lead } from "./api";

type Listener = () => void;

let leads: Lead[] = [];
const listeners = new Set<Listener>();

export function getLeads(): Lead[] {
  return leads;
}

export function setLeads(newLeads: Lead[]): void {
  leads = newLeads;
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshLeads(): Promise<void> {
  const fetched = await getLogEntries();
  setLeads(fetched);
}
