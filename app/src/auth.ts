import { getCurrentSession, identify as apiIdentify, logout as apiLogout, type UserInfo } from "./api";

let currentUser: UserInfo | null = null;
const listeners = new Set<() => void>();

export function getCurrentUser(): UserInfo | null {
  return currentUser;
}

export function isAdmin(): boolean {
  return currentUser?.role === "admin";
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

/** No passwords — typing an existing name signs in as that person, a new name creates a profile. */
export async function identify(name: string): Promise<void> {
  const user = await apiIdentify(name);
  setCurrentUser(user);
}

export async function logout(): Promise<void> {
  await apiLogout();
  setCurrentUser(null);
}

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
