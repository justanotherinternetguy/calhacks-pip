export interface UnlockStatus {
  requestId: string;
  status: string;
  approvals: number;
  threshold: number;
  fulfilled: boolean;
  remaining: number;
}

export function unlockStatus(requestId: string, status: string, approvals: number, threshold: number): UnlockStatus {
  const k = Math.max(2, threshold | 0);
  const fulfilled = status !== "denied" && approvals >= k;
  return {
    requestId,
    status: fulfilled && status === "open" ? "fulfilled" : status,
    approvals,
    threshold: k,
    fulfilled,
    remaining: Math.max(0, k - approvals),
  };
}

/** Map Postgres error codes raised by open_unlock_request() to HTTP. */
export function rpcErrorStatus(code: string | undefined): number {
  switch (code) {
    case "28000": return 401; // not authenticated
    case "42501": return 403; // not a member / subject
    case "P0002": return 404; // incident not found
    case "P0001": return 409; // wrong level / resolved
    default: return 500;
  }
}
