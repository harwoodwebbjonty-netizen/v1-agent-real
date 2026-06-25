import { getActiveTabId, getOpenTabs, subscribeTabs, type ViewName } from "./tabs";

const ALL_VIEWS: ViewName[] = [
  "action-centre",
  "dashboard",
  "call-queue",
  "opportunity-workspace",
  "cold-call-lists",
  "sales-intelligence",
  "email-writer",
  "sequences",
  "calendar",
  "analytics",
  "settings",
];

/** Shows the active tab's view container, hides the rest, and keeps the
 * sidebar nav links' active state in sync. Driven by tabs.ts (not the URL
 * hash) — tabs are the source of truth for what's visible now. */
export function initTabRouter(): void {
  function apply(): void {
    const activeId = getActiveTabId();
    const activeView = getOpenTabs().find((t) => t.id === activeId)?.view;

    for (const v of ALL_VIEWS) {
      const el = document.getElementById(`view-${v}`);
      if (el) el.style.display = v === activeView ? "" : "none";
    }
    document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((a) => {
      a.classList.toggle("active", a.dataset.nav === activeView);
    });
  }

  subscribeTabs(apply);
  apply();
}
