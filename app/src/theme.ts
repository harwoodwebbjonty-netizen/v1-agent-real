const STORAGE_KEY = "theme";

/** The app is light-only now — the theme toggle was removed. This clears any
 * previously stored "dark" preference so nobody stays stuck in dark mode. */
export function initTheme(): void {
  localStorage.removeItem(STORAGE_KEY);
  document.documentElement.dataset.theme = "light";
}
