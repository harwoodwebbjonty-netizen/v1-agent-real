export type ViewName =
  | "action-centre"
  | "activity-feed"
  | "ai-prospecting"
  | "dashboard"
  | "call-queue"
  | "opportunity-workspace"
  | "cold-call-lists"
  | "sales-intelligence"
  | "email-writer"
  | "sequences"
  | "calendar"
  | "outreach"
  | "win-back"
  | "analytics"
  | "settings"
  | "connectors";

export interface Tab {
  id: string;
  title: string;
  view: ViewName;
}

const DEFAULT_TAB: Tab = { id: "action-centre", title: "Today", view: "action-centre" };

// There's no tab-strip UI anymore — sidebar nav links just switch the
// current view directly — so this is really a single active view, kept as
// a one-element list so router.ts's lookup shape didn't need to change.
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

/** Switches the current view. */
export function openTab(view: ViewName, title: string): void {
  openTabs = [{ id: view, title, view }];
  activeTabId = view;
  notify();
}
