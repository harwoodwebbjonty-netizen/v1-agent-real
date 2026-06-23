import { closeTab, getActiveTabId, getOpenTabs, openTab, subscribeTabs, switchTab, type ViewName } from "../tabs";
import { escapeHtml } from "../utils";

const NAV_TITLES: Record<ViewName, string> = {
  dashboard: "Dashboard",
  "cold-call-lists": "Cold Call Lists",
  "sales-intelligence": "AI Sales Intelligence",
  "email-writer": "AI Email Writer",
  calendar: "Calendar",
  analytics: "Analytics",
  settings: "Settings",
};

export function initTabBar(): void {
  const container = document.querySelector<HTMLDivElement>("#tab-bar")!;

  function render(): void {
    const tabs = getOpenTabs();
    const activeId = getActiveTabId();

    container.innerHTML = tabs
      .map(
        (tab) => `
        <div class="tab-chip ${tab.id === activeId ? "active" : ""}" data-tab-id="${escapeHtml(tab.id)}">
          <span class="tab-chip-title">${escapeHtml(tab.title)}</span>
          <button class="tab-chip-close" type="button" data-tab-id="${escapeHtml(tab.id)}" title="Close">✕</button>
        </div>`
      )
      .join("");

    container.querySelectorAll<HTMLDivElement>(".tab-chip").forEach((chip) => {
      chip.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest(".tab-chip-close")) return;
        switchTab(chip.dataset.tabId!);
      });
    });
    container.querySelectorAll<HTMLButtonElement>(".tab-chip-close").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(btn.dataset.tabId!);
      });
    });
  }

  subscribeTabs(render);
  render();

  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((link) => {
    const view = link.dataset.nav as ViewName;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openTab(view, NAV_TITLES[view]);
    });
  });
}
