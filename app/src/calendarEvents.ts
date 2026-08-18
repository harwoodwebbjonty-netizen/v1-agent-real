import {
  type CalendarEvent,
  type CalendarEventPatch,
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
} from "./api";

export type { CalendarEvent };

let events: CalendarEvent[] = [];
let hasLoaded = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

export function getEvents(): CalendarEvent[] {
  return events;
}

export function subscribeCalendarEvents(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** False until the first refreshCalendarEvents() call resolves (success OR
 * failure) — same "not loaded yet" vs "genuinely empty" distinction as
 * state.ts's hasLoadedLeads(), for the several screens that read getEvents(). */
export function hasLoadedEvents(): boolean {
  return hasLoaded;
}

export function listEventsForDate(date: string): CalendarEvent[] {
  return events.filter((e) => e.date === date);
}

export async function refreshCalendarEvents(): Promise<void> {
  try {
    events = await listCalendarEvents();
  } finally {
    hasLoaded = true;
    notify();
  }
}

export interface NewCalendarEvent {
  title: string;
  date: string;
  time: string;
  type: CalendarEvent["type"];
  leadId?: string;
}

export async function addEvent(input: NewCalendarEvent): Promise<void> {
  await createCalendarEvent(input.title, input.date, input.time, input.type, input.leadId);
  await refreshCalendarEvents();
}

export async function updateEvent(id: string, patch: CalendarEventPatch): Promise<void> {
  await updateCalendarEvent(id, patch);
  await refreshCalendarEvents();
}

export async function deleteEvent(id: string): Promise<void> {
  await deleteCalendarEvent(id);
  await refreshCalendarEvents();
}
