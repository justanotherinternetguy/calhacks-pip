// Request shapes + push copy for /functions/v1/checkin. Pure, unit-tested.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CheckInRequest =
  | { action: "ask"; targetId: string }
  | { action: "answer"; checkInId: string; status: "ok" | "help" }
  | { action: "cancel"; checkInId: string };

export interface CheckInRow {
  id: string;
  asker_id: string;
  target_id: string;
  group_id: string;
  status: "pending" | "ok" | "help" | "missed" | "cancelled";
  created_at: string;
  deadline_at: string;
  answered_at: string | null;
  incident_id: string | null;
}

/** Parses the body or returns an error string. */
export function parseRequest(b: unknown): CheckInRequest | string {
  if (!b || typeof b !== "object") return "json body required";
  const o = b as Record<string, unknown>;
  switch (o.action) {
    case "ask":
      return typeof o.targetId === "string" && UUID_RE.test(o.targetId) ? { action: "ask", targetId: o.targetId } : "targetId required";
    case "answer":
      if (typeof o.checkInId !== "string" || !UUID_RE.test(o.checkInId)) return "checkInId required";
      if (o.status !== "ok" && o.status !== "help") return "status must be ok or help";
      return { action: "answer", checkInId: o.checkInId, status: o.status };
    case "cancel":
      return typeof o.checkInId === "string" && UUID_RE.test(o.checkInId) ? { action: "cancel", checkInId: o.checkInId } : "checkInId required";
    default:
      return "action must be ask, answer or cancel";
  }
}

const who = (name: string | null | undefined) => (name && name.trim() ? name.trim() : "A friend");

/** What the target sees: a sticky "You okay?" with I'm OK / I need help. */
export function askMessage(askerName: string | null | undefined, deadlineAt: string) {
  return {
    title: `${who(askerName)} asks: you okay?`,
    body: "Tap I'm OK to let them know. If you don't answer, your group gets an alert.",
    data: { deadlineMs: String(Date.parse(deadlineAt)) },
  };
}

/** What the asker sees once the target answered. "help" is critical. */
export function answerMessage(targetName: string | null | undefined, status: "ok" | "help") {
  const name = who(targetName);
  return status === "ok"
    ? { title: `${name} is okay`, body: `${name} answered your check-in.`, critical: false }
    : { title: `${name} needs help`, body: `${name} answered your check-in with "I need help". Their location is shared with the group.`, critical: true };
}

/** Postgres error → HTTP status: the RPCs raise these codes on purpose. */
export function statusForPgCode(code: string | undefined): number {
  switch (code) {
    case "28000": return 401;
    case "42501": return 403;
    case "P0002": return 404;
    case "P0001": return 409;
    case "22023": return 400;
    default: return 500;
  }
}
