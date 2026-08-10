import { getActiveTabId, getOpenTabs, subscribeTabs } from "../tabs";

/** Compact top bar: shows the current page as a breadcrumb + today's date.
 * Presentation only — reads the active view from the existing tabs store. */
export function initTopBar(): void {
  const pageEl = document.querySelector<HTMLElement>("#tb-page");
  const dateEl = document.querySelector<HTMLElement>("#tb-date");
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString(undefined, {
      weekday: "short", day: "numeric", month: "short",
    });
  }
  function update(): void {
    if (!pageEl) return;
    const active = getActiveTabId();
    const tab = getOpenTabs().find((t) => t.id === active) ?? getOpenTabs()[0];
    pageEl.textContent = tab?.title ?? "Today";
  }
  subscribeTabs(update);
  update();
}
