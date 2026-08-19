import { hasPermission, subscribeAuth } from "../auth";
import { getActiveTabId, openTab, type ViewName } from "../tabs";

// Each top-level nav section maps to a "view" permission. A section is shown only
// if the user's role grants it (admin has all). Outreach's inner sub-tabs
// (email writer, sequences) live under one shared "view_outreach" permission
// and aren't gated separately. "connectors" is deliberately absent — every
// signed-in user manages their own connections regardless of role, same as
// the backend's email-oauth endpoints (no permission dependency at all).
export const NAV_PERMISSIONS: Partial<Record<ViewName, string>> = {
  "action-centre": "view_today",
  "activity-feed": "view_activity_feed",
  "ai-prospecting": "view_prospecting",
  dashboard: "view_leads",
  "opportunity-workspace": "view_leads",
  "sales-intelligence": "view_leads",
  "lender-calculator": "view_leads",
  "cold-call-lists": "view_cold_call_lists",
  "call-queue": "view_cold_call_lists",
  outreach: "view_outreach",
  "win-back": "view_win_back",
  calendar: "view_calendar",
  analytics: "view_analytics",
  settings: "view_settings",
};

export const NAV_TITLES: Record<ViewName, string> = {
  "action-centre": "Today",
  "activity-feed": "Activity Feed",
  "ai-prospecting": "AI Prospecting",
  dashboard: "Leads",
  "call-queue": "Call Queue",
  "opportunity-workspace": "Opportunities",
  "cold-call-lists": "Cold Call Lists",
  "sales-intelligence": "AI Sales Intelligence",
  "lender-calculator": "Lender Calculator",
  "email-writer": "AI Email Writer",
  sequences: "Sequences",
  outreach: "Outreach",
  "win-back": "Win-back",
  calendar: "Calendar",
  analytics: "Analytics",
  settings: "Settings",
  connectors: "Connectors",
};

export function initTabBar(): void {
  // Auth loads async after initTabBar runs, so subscribe to changes rather than
  // checking once at startup. Show each section only if the role grants its
  // view permission; the backend enforces the matching restriction on its
  // endpoints (this is UI convenience, not the security boundary).
  function updateNavVisibility(): void {
    document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((link) => {
      const view = link.dataset.nav as ViewName;
      const perm = NAV_PERMISSIONS[view];
      link.style.display = !perm || hasPermission(perm) ? "" : "none";
    });
    // If the user is on a section they can no longer see (role change / switch),
    // bounce them to the first section they can.
    const active = getActiveTabId() as ViewName;
    const activePerm = NAV_PERMISSIONS[active];
    if (activePerm && !hasPermission(activePerm)) {
      const firstAllowed = (Object.keys(NAV_PERMISSIONS) as ViewName[]).find(
        (v) => hasPermission(NAV_PERMISSIONS[v]!)
      );
      if (firstAllowed) openTab(firstAllowed, NAV_TITLES[firstAllowed]);
    }
  }
  subscribeAuth(updateNavVisibility);
  updateNavVisibility();

  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((link) => {
    const view = link.dataset.nav as ViewName;
    // Feeds the collapsed-sidebar hover tooltip (CSS attr(data-title))
    link.dataset.title = NAV_TITLES[view];
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openTab(view, NAV_TITLES[view]);
    });
  });
}
