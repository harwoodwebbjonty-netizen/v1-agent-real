import { sendHeartbeat, type UserInfo } from "./api";
import { renderAvatarHtml } from "./avatar";
import { getCurrentUser, subscribeAuth } from "./auth";
import { getTeamMembers, refreshTeamMembers, subscribeTeam } from "./team";
import { escapeHtml } from "./utils";

const HEARTBEAT_INTERVAL_MS = 45_000;
const ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;

let intervalId: ReturnType<typeof setInterval> | null = null;

function isActive(user: UserInfo): boolean {
  if (!user.last_seen_at) return false;
  return Date.now() - new Date(user.last_seen_at).getTime() < ACTIVE_THRESHOLD_MS;
}

async function tick(): Promise<void> {
  if (!getCurrentUser()) return;
  await sendHeartbeat().catch(() => {
    // Offline/unreachable — never block the app over a background ping.
  });
  await refreshTeamMembers().catch(() => {});
}

export function initPresence(): void {
  const bar = document.querySelector<HTMLDivElement>("#active-users-bar")!;

  function render(): void {
    const active = getTeamMembers().filter(isActive);
    if (active.length === 0) {
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    bar.innerHTML = active
      .map((u) => `<span class="active-user-avatar" title="${escapeHtml(u.name)} — active now">${renderAvatarHtml(u, "avatar-sm")}</span>`)
      .join("");
  }

  subscribeTeam(render);
  subscribeAuth(() => {
    if (getCurrentUser() && !intervalId) {
      void tick();
      intervalId = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    } else if (!getCurrentUser() && intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      render();
    }
  });

  render();
}
