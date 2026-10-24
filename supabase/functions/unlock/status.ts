/** v1.1 §6 "Groups": fallback unlock needs the subject + at least two friends. */
export const MIN_UNLOCK_MEMBERS = 3;

export interface UnlockStatus {
  requestId: string;
  status: string;
  approvals: number;
  threshold: number;
  fulfilled: boolean;
  remaining: number;
  /** active group members, including the subject */
  members: number;
  /** false when the group is too small for a fallback unlock (members < 3) */
  enabled: boolean;
}

export function unlockStatus(
  requestId: string,
  status: string,
  approvals: number,
  threshold: number,
  members: number,
): UnlockStatus {
  const k = Math.max(2, threshold | 0);
  const m = Math.max(0, members | 0);
  const fulfilled = status !== "denied" && approvals >= k;
  return {
    requestId,
    status: fulfilled && status === "open" ? "fulfilled" : status,
    approvals,
    threshold: k,
    fulfilled,
    remaining: Math.max(0, k - approvals),
    members: m,
    enabled: m >= MIN_UNLOCK_MEMBERS,
  };
}

/** Map Postgres error codes raised by open_unlock_request() to HTTP. */
export function rpcErrorStatus(code: string | undefined): number {
  switch (code) {
    case "28000": return 401; // not authenticated
    case "42501": return 403; // not a member / subject
    case "P0002": return 404; // incident not found
    case "P0001": return 409; // wrong level / resolved / fewer than 3 active members
    default: return 500;
  }
}
