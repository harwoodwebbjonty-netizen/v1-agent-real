import { openTab, type ViewName } from "../tabs";

const NAV_TITLES: Record<ViewName, string> = {
  dashboard: "Dashboard",
  "cold-call-lists": "Cold Call Lists",
  "sales-intelligence": "AI Sales Intelligence",
  "email-writer": "AI Email Writer",
  calendar: "Calendar",
  analytics: "Analytics",
  settings: "Settings",
};

/** Wires sidebar nav links to tabs.ts, which remains the source of truth for
 * which view is currently shown (see router.ts) — only the visual strip of
 * open-tab chips has been removed, not the underlying view-switching. */
export function initTabBar(): void {
  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((link) => {
    const view = link.dataset.nav as ViewName;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openTab(view, NAV_TITLES[view]);
    });
  });
}
