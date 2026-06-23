import { showToast } from "./toast";

export type ViewName =
  | "dashboard"
  | "cold-call-lists"
  | "sales-intelligence"
  | "email-writer"
  | "calendar"
  | "analytics"
  | "settings";

export interface Tab {
  id: string;
  title: string;
  view: ViewName;
}

const MAX_TABS = 4;
const DEFAULT_TAB: Tab = { id: "dashboard", title: "Dashboard", view: "dashboard" };

// One tab per view (every screen here is a singleton — there's no per-instance
// data like "lead X's tab"), so the tab id is just the view name.
let openTabs: Tab[] = [DEFAULT_TAB];
let activeTabId: string = DEFAULT_TAB.id;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => fn());
}

export function getOpenTabs(): Tab[] {
  return openTabs;
}

export function getActiveTabId(): string {
  return activeTabId;
}

export function subscribeTabs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Opens a new tab for this view, or switches to it if already open. Blocks
 * (with a toast) past the 4-tab limit. */
export function openTab(view: ViewName, title: string): void {
  const existing = openTabs.find((t) => t.view === view);
  if (existing) {
    activeTabId = existing.id;
    notify();
    return;
  }
  if (openTabs.length >= MAX_TABS) {
    showToast("Close a tab before opening a new one");
    return;
  }
  openTabs = [...openTabs, { id: view, title, view }];
  activeTabId = view;
  notify();
}

export function switchTab(id: string): void {
  if (openTabs.some((t) => t.id === id)) {
    activeTabId = id;
    notify();
  }
}

/** Closing the active tab falls back to the most-recently-opened remaining
 * one; closing the last tab reopens Dashboard so the app is never blank. */
export function closeTab(id: string): void {
  const wasActive = activeTabId === id;
  openTabs = openTabs.filter((t) => t.id !== id);
  if (openTabs.length === 0) {
    openTabs = [DEFAULT_TAB];
    activeTabId = DEFAULT_TAB.id;
  } else if (wasActive) {
    activeTabId = openTabs[openTabs.length - 1].id;
  }
  notify();
}
