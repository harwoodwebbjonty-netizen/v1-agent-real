import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export async function initUpdater(): Promise<void> {
  let update: Update | null;
  try {
    update = await check();
  } catch {
    // Offline, endpoint unreachable, etc. — never block or alarm the user
    // over a background check; they can keep using the app as-is.
    return;
  }
  if (!update) return;

  const banner = document.querySelector<HTMLDivElement>("#update-banner")!;
  const label = document.querySelector<HTMLSpanElement>("#update-banner-label")!;
  const installBtn = document.querySelector<HTMLButtonElement>("#update-banner-install-btn")!;
  const dismissBtn = document.querySelector<HTMLButtonElement>("#update-banner-dismiss-btn")!;

  label.textContent = `Version ${update.version} is available.`;
  banner.classList.remove("hidden");

  dismissBtn.addEventListener("click", () => banner.classList.add("hidden"));

  installBtn.addEventListener("click", () => {
    void (async () => {
      installBtn.disabled = true;
      installBtn.textContent = "Installing...";
      try {
        await update!.downloadAndInstall();
        await relaunch();
      } catch (err) {
        label.textContent = `Update failed: ${err}`;
        installBtn.disabled = false;
        installBtn.textContent = "Restart & Update";
      }
    })();
  });
}
