import { open } from "@tauri-apps/plugin-dialog";
import { readImageAsDataUrl, setUserAvatar } from "./api";
import { getCurrentUser, identify, subscribeAuth, updateLocalUser } from "./auth";
import { renderAvatarHtml, resizeImageDataUrl } from "./avatar";
import { getTeamMembers, refreshTeamMembers, subscribeTeam } from "./team";
import { escapeHtml } from "./utils";

const AVATAR_SIZE_PX = 128;

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
        void identify(row.dataset.name!);
        closePanel();
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
    await identify(name);
    newNameInput.value = "";
    closePanel();
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
