import { open } from "@tauri-apps/plugin-dialog";
import { readImageAsDataUrl, setUserAvatar } from "./api";
import { getCurrentUser, identify, subscribeAuth, updateLocalUser } from "./auth";
import { renderAvatarHtml, resizeImageDataUrl } from "./avatar";
import { getTeamMembers, refreshTeamMembers, subscribeTeam } from "./team";
import { escapeHtml } from "./utils";

const AVATAR_SIZE_PX = 128;

/** Modal password prompt used both for switching to an existing profile and
 * for creating a new one. Resolves with the entered password, or null on
 * cancel. `signIn` runs inside the modal so a wrong password can show its
 * error and let the user retry without reopening. */
function promptPasswordAndSignIn(name: string, isNew: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "conflict-modal-overlay";
    overlay.innerHTML = `
      <div class="conflict-modal">
        <div class="conflict-modal-title">${isNew ? `Create profile — ${escapeHtml(name)}` : `Sign in as ${escapeHtml(name)}`}</div>
        <div class="conflict-modal-desc" style="margin-bottom:12px">${
          isNew
            ? "Choose a password for this profile (minimum 4 characters). You'll need it every time you sign in."
            : "Enter this profile's password. If it was created before passwords existed, whatever you type now becomes its password."
        }</div>
        <input id="idsw-password" type="password" class="search-input" placeholder="Password"
          autocomplete="current-password" style="width:100%;margin-bottom:8px" />
        <p id="idsw-error" style="color:var(--danger,#e53);font-size:0.82rem;min-height:1.2em;margin-bottom:8px"></p>
        <div class="conflict-modal-actions">
          <button id="idsw-submit" class="btn btn-primary">${isNew ? "Create & sign in" : "Sign in"}</button>
          <button id="idsw-cancel" class="btn btn-ghost">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector<HTMLInputElement>("#idsw-password")!;
    const errorEl = overlay.querySelector<HTMLParagraphElement>("#idsw-error")!;
    const submitBtn = overlay.querySelector<HTMLButtonElement>("#idsw-submit")!;
    setTimeout(() => input.focus(), 40);

    const cleanup = (ok: boolean) => { overlay.remove(); resolve(ok); };
    overlay.querySelector("#idsw-cancel")!.addEventListener("click", () => cleanup(false));

    const submit = async () => {
      const password = input.value;
      if (password.length < 4) { errorEl.textContent = "Password must be at least 4 characters."; return; }
      submitBtn.disabled = true;
      try {
        await identify(name, password);
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
    const members = getTeamMembers();
    const current = getCurrentUser();
    panelList.innerHTML = members
      .map(
        (m) => `
        <li class="identity-panel-row ${current?.id === m.id ? "active" : ""}" data-name="${escapeHtml(m.name)}">
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
        void promptPasswordAndSignIn(name, false);
      });
    });
  }

  subscribeTeam(renderPanelList);
  subscribeAuth(() => {
    renderTrigger();
    renderPanelList();
  });
  void refreshTeamMembers();
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
    const isNew = !getTeamMembers().some((m) => m.name === name);
    const ok = await promptPasswordAndSignIn(name, isNew);
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
      await refreshTeamMembers();
    } catch (err) {
      console.error("Failed to set avatar:", err);
    }
  });
}
