import { getLogEntries, type Lead } from "./api";

type Listener = () => void;

let leads: Lead[] = [];
let hasLoaded = false;
const listeners = new Set<Listener>();

export function getLeads(): Lead[] {
  return leads;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** False until the first refreshLeads() call resolves (success OR failure) —
 * lets any view reading getLeads() tell "genuinely no leads" apart from
 * "hasn't fetched yet", the same ambiguity every screen depending on this
 * shared state independently had to solve before this existed. */
export function hasLoadedLeads(): boolean {
  return hasLoaded;
}

export async function refreshLeads(): Promise<void> {
  try {
    leads = await getLogEntries();
  } finally {
    // Always notify subscribers once the first attempt resolves, success or
    // failure — otherwise a failed initial fetch leaves every view that only
    // reacts via subscribe() (not its own try/catch) stuck showing a loading
    // skeleton forever, since nothing would ever re-trigger their render.
    hasLoaded = true;
    listeners.forEach((fn) => fn());
  }
}
