// QR payloads (CONTRACTS.md §6). Pure, so node --test runs it.
//   v2 invite:  { v: 2, k: 'invite', g: groupId, gn: groupName, t: token, u: inviterId, n: inviterName, x, e, fp }
//               single-use, 10 minutes; shown by any group member, scanned in person to join.
//   v1 person:  { v: 1, userId, fp, x, e } — "my code": scanned to verify a friend's keys (safety number).
// Both carry the shower's public keys and fingerprint. The scanner recomputes the fingerprint from the keys on its
// own device; the fingerprint on the shower's screen is what the two people compare.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/;

export type InviteQr = { kind: 'invite'; groupId: string; groupName: string; token: string; userId: string; name: string; x: string; e: string; fp: string };
export type PersonQr = { kind: 'person'; userId: string; x: string; e: string; fp: string };
export type ParsedQr = InviteQr | PersonQr;

export function inviteQr(i: Omit<InviteQr, 'kind'>): string {
  return JSON.stringify({ v: 2, k: 'invite', g: i.groupId, gn: i.groupName, t: i.token, u: i.userId, n: i.name, x: i.x, e: i.e, fp: i.fp });
}

export function personQr(p: Omit<PersonQr, 'kind'>): string {
  return JSON.stringify({ v: 1, userId: p.userId, fp: p.fp, x: p.x, e: p.e });
}

const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Throws a readable error for anything that is not a pip code, before any network call. */
export function parseQr(raw: string): ParsedQr {
  let q: Record<string, unknown>;
  try { q = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('Not a pip code'); }
  if (!q || typeof q !== 'object') throw new Error('Not a pip code');
  if (q.v === 2 && q.k === 'invite') {
    if (!str(q.g) || !UUID_RE.test(q.g) || !str(q.u) || !UUID_RE.test(q.u)) throw new Error('This invite code is damaged. Ask for a new one.');
    if (!str(q.t) || !TOKEN_RE.test(q.t)) throw new Error('This invite code is damaged. Ask for a new one.');
    if (!str(q.x) || !str(q.e) || !str(q.fp)) throw new Error('This invite code is incomplete. Ask for a new one.');
    return { kind: 'invite', groupId: q.g, groupName: str(q.gn, 80) ? q.gn : 'a group', token: q.t, userId: q.u, name: str(q.n, 80) ? q.n : 'A friend', x: q.x, e: q.e, fp: q.fp };
  }
  if (q.v === 1) {
    if (!str(q.userId) || !UUID_RE.test(q.userId)) {
      throw new Error('This code has no valid account id. On the other device, sign in, open Friends → My code, and scan again.');
    }
    if (!str(q.fp) || !str(q.x) || !str(q.e)) throw new Error('This pip code is incomplete');
    return { kind: 'person', userId: q.userId, x: q.x, e: q.e, fp: q.fp };
  }
  throw new Error('Not a pip code');
}

/** Seconds left on an invite, for the countdown under the QR. */
export const secondsLeft = (expiresAtIso: string, nowMs: number) => Math.max(0, Math.round((Date.parse(expiresAtIso) - nowMs) / 1000));
