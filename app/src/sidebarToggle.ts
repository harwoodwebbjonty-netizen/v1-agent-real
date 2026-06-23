const STORAGE_KEY = "sidebarCollapsed";

export function initSidebarToggle(): void {
  const sidebar = document.querySelector<HTMLElement>(".app-sidebar")!;
  const toggleBtn = document.querySelector<HTMLButtonElement>("#sidebar-toggle-btn")!;

  function apply(collapsed: boolean): void {
    sidebar.classList.toggle("collapsed", collapsed);
    toggleBtn.textContent = collapsed ? "»" : "«";
    toggleBtn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }

  apply(localStorage.getItem(STORAGE_KEY) === "1");

  toggleBtn.addEventListener("click", () => {
    apply(!sidebar.classList.contains("collapsed"));
  });
}
