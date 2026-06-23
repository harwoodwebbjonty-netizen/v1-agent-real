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

export function listEventsForDate(date: string): CalendarEvent[] {
  return events.filter((e) => e.date === date);
}

export async function refreshCalendarEvents(): Promise<void> {
  events = await listCalendarEvents();
  notify();
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
