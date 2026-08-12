import {
  getCurrentSession,
  identify as apiIdentify,
  logout as apiLogout,
  registerSessionExpiredHandler,
  type UserInfo,
} from "./api";
import { showToast } from "./toast";

let currentUser: UserInfo | null = null;
const listeners = new Set<() => void>();
const sessionExpiredListeners = new Set<() => void>();

export function getCurrentUser(): UserInfo | null {
  return currentUser;
}

export function isAdmin(): boolean {
  return currentUser?.role === "admin";
}

/** True if the current user's role grants `permission` (admin always does). */
export function hasPermission(permission: string): boolean {
  if (!currentUser) return false;
  if (currentUser.role === "admin") return true;
  return (currentUser.permissions ?? []).includes(permission);
}

export function subscribeAuth(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setCurrentUser(user: UserInfo | null): void {
  currentUser = user;
  listeners.forEach((fn) => fn());
}

export async function initAuth(): Promise<void> {
  currentUser = await getCurrentSession();
  listeners.forEach((fn) => fn());
}

/** Name + password sign-in: a new name creates a member profile with that
 * password, an existing name must supply the matching password. The first-ever
 * account on a fresh deployment also needs the admin bootstrap token. */
export async function identify(name: string, password: string, bootstrapToken = ""): Promise<void> {
  const user = await apiIdentify(name, password, bootstrapToken);
  setCurrentUser(user);
}

export async function logout(): Promise<void> {
  await apiLogout();
  setCurrentUser(null);
}

/** Views (e.g. the identity switcher) subscribe to be notified specifically
 * when a session dies mid-use, as opposed to every ordinary auth change
 * `subscribeAuth` also fires for — so they can prompt re-sign-in rather than
 * just quietly re-rendering to a signed-out state. */
export function subscribeSessionExpired(fn: () => void): () => void {
  sessionExpiredListeners.add(fn);
  return () => sessionExpiredListeners.delete(fn);
}

/** Called (via api.ts's registerSessionExpiredHandler) the moment any backend
 * call comes back with a dead session token. Signs the app out locally right
 * away — every view already gates on getCurrentUser() — and best-effort tells
 * the backend too, without waiting on or surfacing a failure from that call
 * since the token is already known-dead either way. */
function handleSessionExpired(): void {
  if (currentUser === null) return; // already signed out — avoid duplicate toasts
  setCurrentUser(null);
  void apiLogout().catch(() => {
    /* token is already dead server-side; local state is what matters */
  });
  showToast("Your session expired — please sign in again.");
  sessionExpiredListeners.forEach((fn) => fn());
}

registerSessionExpiredHandler(handleSessionExpired);

/**
 * Keeps the cached session in sync when the signed-in user's own record
 * changes elsewhere (e.g. someone edits their role/name from the Team
 * panel). Without this, `isAdmin()` would keep returning a stale answer
 * until the next identify/logout — and since the backend always checks the
 * live role, that mismatch surfaces as a confusing 403 on the next action.
 */
export function updateLocalUser(updated: UserInfo): void {
  if (currentUser && currentUser.id === updated.id) {
    setCurrentUser(updated);
  }
}
