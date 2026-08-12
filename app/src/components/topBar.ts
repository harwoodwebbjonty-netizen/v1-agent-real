import { getCurrentUser, subscribeAuth } from "../auth";
import { renderAvatarHtml } from "../avatar";
import { getLeadLists, subscribeLeadLists } from "../leadLists";
import { getLeads, subscribe } from "../state";
import { getActiveTabId, getOpenTabs, openTab, subscribeTabs } from "../tabs";

/** Compact top bar: breadcrumb, global lead search, worklist bell, and the
 * current user. Everything routes through existing stores/views — no new
 * backend, no dead controls. */
export function initTopBar(): void {
  const pageEl = document.querySelector<HTMLElement>("#tb-page");
  const dateEl = document.querySelector<HTMLElement>("#tb-date");
  const searchEl = document.querySelector<HTMLInputElement>("#tb-search-input");
  const notifEl = document.querySelector<HTMLButtonElement>("#tb-notif");
  const userAva = document.querySelector<HTMLElement>("#tb-user-ava");
  const userName = document.querySelector<HTMLElement>("#tb-user-name");
  const userBtn = document.querySelector<HTMLButtonElement>("#tb-user");

  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }

  // breadcrumb follows the active view
  function updateCrumb(): void {
    if (!pageEl) return;
    const active = getActiveTabId();
    const tab = getOpenTabs().find((t) => t.id === active) ?? getOpenTabs()[0];
    pageEl.textContent = tab?.title ?? "Today";
  }
  subscribeTabs(updateCrumb);
  updateCrumb();

  // global search → routes to Leads and drives the existing dashboard search
  function runSearch(): void {
    if (!searchEl) return;
    const q = searchEl.value;
    openTab("dashboard", "Leads");
    const dashSearch = document.querySelector<HTMLInputElement>("#search-input");
    if (dashSearch) {
      dashSearch.value = q;
      dashSearch.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  // Cmd/Ctrl+K now opens the real command palette (components/commandPalette.ts)
  // instead of just focusing this box — Enter here still works as a direct
  // shortcut straight into the Leads table for anyone already typing here.
  searchEl?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } });

  // bell → today's worklist; profile → identity switcher (both existing)
  notifEl?.addEventListener("click", () => openTab("action-centre", "Today"));
  userBtn?.addEventListener("click", () => document.querySelector<HTMLButtonElement>("#identity-trigger")?.click());

  function updateUser(): void {
    const u = getCurrentUser();
    if (userAva) userAva.innerHTML = u ? renderAvatarHtml(u, "avatar-sm") : "";
    if (userName) userName.textContent = u ? u.name : "";
  }
  subscribeAuth(updateUser);
  updateUser();

  // live nav counts (Leads, Cold Call Lists)
  function updateCounts(): void {
    const leads = document.querySelector<HTMLElement>("#nav-count-dashboard");
    const lists = document.querySelector<HTMLElement>("#nav-count-cold-call-lists");
    if (leads) leads.textContent = getLeads().length ? getLeads().length.toLocaleString() : "";
    if (lists) lists.textContent = getLeadLists().length ? String(getLeadLists().length) : "";
  }
  subscribe(updateCounts);
  subscribeLeadLists(updateCounts);
  updateCounts();
}
