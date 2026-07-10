import { isAdmin, subscribeAuth } from "../auth";
import { openTab, type ViewName } from "../tabs";

const NAV_TITLES: Record<ViewName, string> = {
  "action-centre": "Today",
  "activity-feed": "Activity Feed",
  "ai-prospecting": "AI Prospecting",
  dashboard: "Leads",
  "call-queue": "Call Queue",
  "opportunity-workspace": "Opportunities",
  "cold-call-lists": "Cold Call Lists",
  "sales-intelligence": "AI Sales Intelligence",
  "email-writer": "AI Email Writer",
  sequences: "Sequences",
  outreach: "Outreach",
  "win-back": "Win-back",
  calendar: "Calendar",
  analytics: "Analytics",
  settings: "Settings",
};

const PIN_STORE_KEY = "settings_pin_hash";
const PIN_SESSION_KEY = "settings_session_ok";

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function showPinModal(mode: "set" | "enter", storedHash?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "conflict-modal-overlay";
    overlay.innerHTML = `
      <div class="conflict-modal">
        <div class="conflict-modal-title">${mode === "set" ? "Set a Settings PIN" : "Settings PIN"}</div>
        <div class="conflict-modal-desc" style="margin-bottom:12px">${
          mode === "set"
            ? "Choose a PIN — you'll need it every time you open Settings."
            : "Enter your PIN to access Settings."
        }</div>
        <input id="pin-input" type="password" class="search-input" placeholder="PIN"
          autocomplete="new-password" style="width:100%;margin-bottom:8px" />
        ${mode === "set" ? `<input id="pin-confirm" type="password" class="search-input"
          placeholder="Confirm PIN" autocomplete="new-password" style="width:100%;margin-bottom:8px" />` : ""}
        <p id="pin-error" style="color:var(--danger,#e53);font-size:0.82rem;min-height:1.2em;margin-bottom:8px"></p>
        <div class="conflict-modal-actions">
          <button id="pin-submit" class="btn btn-primary">${mode === "set" ? "Set PIN" : "Unlock"}</button>
          <button id="pin-cancel" class="btn btn-ghost">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const pinInput = overlay.querySelector<HTMLInputElement>("#pin-input")!;
    const errorEl = overlay.querySelector<HTMLParagraphElement>("#pin-error")!;
    setTimeout(() => pinInput.focus(), 40);

    const cleanup = (ok: boolean) => { overlay.remove(); resolve(ok); };

    overlay.querySelector("#pin-cancel")!.addEventListener("click", () => cleanup(false));

    const submit = async () => {
      const pin = pinInput.value;
      if (!pin) { errorEl.textContent = "Enter a PIN."; return; }

      if (mode === "set") {
        const confirm = overlay.querySelector<HTMLInputElement>("#pin-confirm")!.value;
        if (pin !== confirm) { errorEl.textContent = "PINs don't match — try again."; return; }
        localStorage.setItem(PIN_STORE_KEY, await sha256(pin));
        cleanup(true);
      } else {
        const hash = await sha256(pin);
        if (hash !== storedHash) {
          errorEl.textContent = "Incorrect PIN.";
          pinInput.value = "";
          pinInput.focus();
        } else {
          cleanup(true);
        }
      }
    };

    overlay.querySelector("#pin-submit")!.addEventListener("click", () => void submit());
    overlay.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
  });
}

async function openSettingsWithPin(): Promise<void> {
  // Already unlocked this session
  if (sessionStorage.getItem(PIN_SESSION_KEY) === "1") {
    openTab("settings", "Settings");
    return;
  }

  const stored = localStorage.getItem(PIN_STORE_KEY);
  let ok: boolean;

  if (!stored) {
    // First time — let them set a PIN
    ok = await showPinModal("set");
  } else {
    ok = await showPinModal("enter", stored);
  }

  if (ok) {
    sessionStorage.setItem(PIN_SESSION_KEY, "1");
    openTab("settings", "Settings");
  }
}

export function initTabBar(): void {
  const settingsLink = document.querySelector<HTMLAnchorElement>("#settings-nav-link");

  // Auth loads async after initTabBar runs, so subscribe to changes rather
  // than checking isAdmin() once at startup (it would always be false then).
  function updateSettingsVisibility(): void {
    if (settingsLink) settingsLink.style.display = isAdmin() ? "" : "none";
  }
  subscribeAuth(updateSettingsVisibility);
  updateSettingsVisibility();

  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((link) => {
    const view = link.dataset.nav as ViewName;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      if (view === "settings") {
        void openSettingsWithPin();
      } else {
        openTab(view, NAV_TITLES[view]);
      }
    });
  });
}
