const DEFAULT_CONTACT_STATUS_KEY = "defaultContactStatus";
const COMPACT_ROWS_KEY = "compactRows";

export function getDefaultContactStatus(): string {
  return localStorage.getItem(DEFAULT_CONTACT_STATUS_KEY) || "New";
}

export function setDefaultContactStatus(value: string): void {
  localStorage.setItem(DEFAULT_CONTACT_STATUS_KEY, value);
}

export function getCompactRows(): boolean {
  return localStorage.getItem(COMPACT_ROWS_KEY) === "true";
}

export function setCompactRows(value: boolean): void {
  localStorage.setItem(COMPACT_ROWS_KEY, String(value));
}
