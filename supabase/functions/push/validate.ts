import type { PushInput } from "../_shared/push.ts";

export interface PushBody extends Partial<PushInput> {
  recipients?: string[];
}

export function validateBody(b: PushBody): string | null {
  if (!b || typeof b !== "object") return "json body required";
  if (!b.incidentId || typeof b.incidentId !== "string") return "incidentId required";
  if (!b.kind || typeof b.kind !== "string") return "kind required";
  if (!b.title || typeof b.title !== "string") return "title required";
  if (typeof b.body !== "string") return "body required";
  if (b.recipients !== undefined && !Array.isArray(b.recipients)) return "recipients must be an array";
  if (b.data !== undefined && (typeof b.data !== "object" || b.data === null)) return "data must be an object";
  return null;
}

/** Explicit recipients are clamped to the group; default is everyone but the caller. */
export function resolveRecipients(allowed: Set<string>, callerId: string, requested?: string[]): string[] {
  const base = requested && requested.length ? requested : [...allowed];
  return [...new Set(base.filter((r) => allowed.has(r) && r !== callerId))];
}
