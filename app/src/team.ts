import { listTeamMembers, type UserInfo } from "./api";

let members: UserInfo[] = [];
const listeners = new Set<() => void>();

export function getTeamMembers(): UserInfo[] {
  return members;
}

export function subscribeTeam(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshTeamMembers(): Promise<void> {
  members = await listTeamMembers();
  listeners.forEach((fn) => fn());
}
