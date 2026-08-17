import { listCustomFields, type CustomField } from "./api";

let fields: CustomField[] = [];
const listeners = new Set<() => void>();

export function getCustomFields(): CustomField[] {
  return fields;
}

export function subscribeCustomFields(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshCustomFields(): Promise<void> {
  fields = await listCustomFields();
  listeners.forEach((fn) => fn());
}
