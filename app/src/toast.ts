let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(message: string): void {
  const container = document.querySelector<HTMLDivElement>("#toast-container");
  if (!container) return;

  container.textContent = message;
  container.classList.add("visible");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    container.classList.remove("visible");
  }, 2500);
}
