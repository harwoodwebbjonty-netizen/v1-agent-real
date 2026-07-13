import { checkBackendHealth } from "./api";

const POLL_MS = 30_000;

/** Shows a fixed banner whenever the backend is unreachable, so "no data"
 * is never mistaken for "connected but empty". Polls /health in the
 * background and hides itself as soon as the connection comes back. */
export function initConnectionBanner(): void {
  const banner = document.createElement("div");
  banner.id = "connection-banner";
  banner.className = "connection-banner hidden";
  banner.innerHTML = `<span>Can't reach the server — data shown may be stale. Retrying…</span>`;
  document.body.appendChild(banner);

  let offline = false;

  async function poll(): Promise<void> {
    try {
      await checkBackendHealth();
      if (offline) {
        offline = false;
        banner.classList.add("hidden");
        // Reload views cheaply by letting the user act — a full auto-refresh
        // of every view is riskier than telling them we're back.
      }
    } catch {
      if (!offline) {
        offline = true;
        banner.classList.remove("hidden");
      }
    }
  }

  void poll();
  setInterval(() => void poll(), POLL_MS);
}
