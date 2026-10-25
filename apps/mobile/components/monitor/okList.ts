// Pure list logic for the monitor's "Confirmed OK" log (okConfirmations.ts). Type imports only, so node --test runs it.
import type { OkConfirmation } from './riskAnalysis';

const MAX = 50;
/** Two reports closer than this are the same confirmation (an answered check-in can also send "I'm okay"). */
export const SAME_MS = 5_000;

/** `list` plus `c`, oldest first, deduped within SAME_MS (a check-in answer wins over a tap), capped. */
export function addConfirmation(list: OkConfirmation[], c: OkConfirmation): OkConfirmation[] {
  const near = list.findIndex((x) => Math.abs(x.atMs - c.atMs) < SAME_MS);
  if (near >= 0) {
    if (list[near].how === 'check_in' || c.how === list[near].how) return list;
    const next = [...list];
    next[near] = { ...c, atMs: Math.min(c.atMs, list[near].atMs) };
    return next;
  }
  return [...list, c].sort((a, b) => a.atMs - b.atMs).slice(-MAX);
}

