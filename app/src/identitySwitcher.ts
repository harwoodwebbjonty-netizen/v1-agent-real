import { open } from "@tauri-apps/plugin-dialog";
import { getUserNames, readImageAsDataUrl, setUserAvatar, type UserName } from "./api";
import { getCurrentUser, identify, subscribeAuth, updateLocalUser } from "./auth";
import { renderAvatarHtml, resizeImageDataUrl } from "./avatar";
import { refreshTeamMembers } from "./team";
import { escapeHtml } from "./utils";

const AVATAR_SIZE_PX = 128;
const MIN_PASSWORD_LENGTH = 8;

// Pre-auth login picker — sourced from the slim PUBLIC /users/names endpoint
// (names + avatars only), not the authenticated team roster.
let pickerNames: UserName[] = [];

/** Modal password prompt used both for switching to an existing profile and
 * for creating a new one. Resolves with the entered password, or null on
 * cancel. `signIn` runs inside the modal so a wrong password can show its
 * error and let the user retry without reopening. */
function promptPasswordAndSignIn(name: string, isNew: boolean, isFirstAccount: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "conflict-modal-overlay";
    overlay.innerHTML = `
      <div class="conflict-modal">
        <div class="conflict-modal-title">${isNew ? `Create profile — ${escapeHtml(name)}` : `Sign in as ${escapeHtml(name)}`}</div>
        <div class="conflict-modal-desc" style="margin-bottom:12px">${
          isNew
            ? `Choose a password for this profile (minimum ${MIN_PASSWORD_LENGTH} characters). You'll need it every time you sign in.`
            : "Enter this profile's password. If you've forgotten it, ask an admin to reset it for you."
        }</div>
        <input id="idsw-password" type="password" class="search-input" placeholder="Password"
          autocomplete="${isNew ? "new-password" : "current-password"}" style="width:100%;margin-bottom:8px" />
        ${
          isFirstAccount && isNew
            ? `<input id="idsw-bootstrap" type="password" class="search-input" placeholder="Admin setup token (first account only)"
                 style="width:100%;margin-bottom:8px" />`
            : ""
        }
        <p id="idsw-error" style="color:var(--danger,#e53);font-size:0.82rem;min-height:1.2em;margin-bottom:8px"></p>
        <div class="conflict-modal-actions">
          <button id="idsw-submit" class="btn btn-primary">${isNew ? "Create & sign in" : "Sign in"}</button>
          <button id="idsw-cancel" class="btn btn-ghost">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector<HTMLInputElement>("#idsw-password")!;
    const bootstrapInput = overlay.querySelector<HTMLInputElement>("#idsw-bootstrap");
    const errorEl = overlay.querySelector<HTMLParagraphElement>("#idsw-error")!;
    const submitBtn = overlay.querySelector<HTMLButtonElement>("#idsw-submit")!;
    setTimeout(() => input.focus(), 40);

    const cleanup = (ok: boolean) => { overlay.remove(); resolve(ok); };
    overlay.querySelector("#idsw-cancel")!.addEventListener("click", () => cleanup(false));

    const submit = async () => {
      const password = input.value;
      if (password.length < MIN_PASSWORD_LENGTH) {
        errorEl.textContent = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
        return;
      }
      submitBtn.disabled = true;
      try {
        await identify(name, password, bootstrapInput?.value ?? "");
        cleanup(true);
      } catch (err) {
        errorEl.textContent = String(err);
        submitBtn.disabled = false;
        input.select();
      }
    };
    submitBtn.addEventListener("click", () => void submit());
    overlay.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
  });
}

export function initIdentitySwitcher(): void {
  const trigger = document.querySelector<HTMLButtonElement>("#identity-trigger")!;
  const triggerAvatar = document.querySelector<HTMLSpanElement>("#identity-trigger-avatar")!;
  const triggerLabel = document.querySelector<HTMLSpanElement>("#identity-trigger-label")!;
  const panel = document.querySelector<HTMLDivElement>("#identity-panel")!;
  const panelList = document.querySelector<HTMLUListElement>("#identity-panel-list")!;
  const newNameInput = document.querySelector<HTMLInputElement>("#identity-new-name")!;
  const joinBtn = document.querySelector<HTMLButtonElement>("#identity-join-btn")!;
  const changePhotoBtn = document.querySelector<HTMLButtonElement>("#identity-change-photo-btn")!;

  function closePanel(): void {
    panel.classList.add("hidden");
  }

  function renderTrigger(): void {
    const current = getCurrentUser();
    triggerAvatar.innerHTML = current ? renderAvatarHtml(current, "avatar-sm") : "";
    triggerLabel.textContent = current ? current.name : "Who are you?";
    changePhotoBtn.classList.toggle("hidden", !current);
  }

  function renderPanelList(): void {
    const current = getCurrentUser();
    panelList.innerHTML = pickerNames
      .map(
        (m) => `
        <li class="identity-panel-row ${current?.name === m.name ? "active" : ""}" data-name="${escapeHtml(m.name)}">
          ${renderAvatarHtml(m, "avatar-sm")}
          <span>${escapeHtml(m.name)}</span>
        </li>
      `
      )
      .join("");

    panelList.querySelectorAll<HTMLLIElement>(".identity-panel-row").forEach((row) => {
      row.addEventListener("click", () => {
        const name = row.dataset.name!;
        if (getCurrentUser()?.name === name) { closePanel(); return; }
        closePanel();
        void promptPasswordAndSignIn(name, false, false);
      });
    });
  }

  async function refreshPicker(): Promise<void> {
    try { pickerNames = await getUserNames(); } catch { /* offline — leave as-is */ }
    renderPanelList();
  }

  subscribeAuth(() => {
    renderTrigger();
    void refreshPicker();
  });
  void refreshPicker();
  renderTrigger();

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    panel.classList.toggle("hidden");
  });

  panel.addEventListener("click", (event) => event.stopPropagation());

  document.addEventListener("click", () => closePanel());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });

  async function join(): Promise<void> {
    const name = newNameInput.value.trim();
    if (name.length === 0) return;
    closePanel();
    // Existing name → sign-in prompt; new name → create-profile prompt.
    const isNew = !pickerNames.some((m) => m.name === name);
    const isFirstAccount = pickerNames.length === 0;
    const ok = await promptPasswordAndSignIn(name, isNew, isFirstAccount);
    if (ok) newNameInput.value = "";
  }
  joinBtn.addEventListener("click", () => void join());
  newNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void join();
  });

  changePhotoBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    const current = getCurrentUser();
    if (!current) return;

    const path = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (typeof path !== "string") return;

    try {
      const rawDataUrl = await readImageAsDataUrl(path);
      const resized = await resizeImageDataUrl(rawDataUrl, AVATAR_SIZE_PX);
      const updated = await setUserAvatar(current.id, resized);
      updateLocalUser(updated);
      await Promise.all([refreshTeamMembers(), refreshPicker()]);
    } catch (err) {
      console.error("Failed to set avatar:", err);
    }
  });
}
