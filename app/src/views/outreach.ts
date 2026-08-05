export function initOutreach(): void {
  const container = document.querySelector<HTMLDivElement>("#view-outreach")!;
  const subViews = ["email-writer", "list-campaign", "sequences"] as const;

  container.querySelectorAll<HTMLButtonElement>(".sub-view-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.sub!;
      container.querySelectorAll(".sub-view-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      subViews.forEach((id) => {
        const el = document.getElementById(`view-${id}`)!;
        el.style.display = id === target ? "" : "none";
      });
    });
  });
}
