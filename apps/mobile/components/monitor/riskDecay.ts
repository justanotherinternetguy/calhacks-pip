// The AI read's score eases on its own while things stay calm, without asking the model again. It decays from the
// last read with a half-life of HALF_LIFE_MIN calm minutes; each minute the phone reports normal walking (the
// person's usual gait, every unsteadiness metric in band) counts WALK_WEIGHT times. It holds while any Watch or
// Danger incident is active, a check-in is pending or an alert is running, and it never goes below the engine's
// floor. The next read (any new event) starts from the eased score: the prompt tells the model about it.
// Kept free of app imports so `node --test` can load it.
import type { Analysis, Driver, RiskLevel } from './riskAnalysis';

export const RISKS: RiskLevel[] = ['low', 'elevated', 'high', 'critical'];
/** Score band per level, inclusive. */
export const RISK_BAND: Record<RiskLevel, [number, number]> = { low: [0, 24], elevated: [25, 49], high: [50, 74], critical: [75, 100] };
export const levelOf = (score: number): RiskLevel => RISKS.find((l) => score <= RISK_BAND[l][1]) ?? 'critical';

/** Calm minutes for the score to halve. */
export const HALF_LIFE_MIN = 15;
/** A minute of normal walking counts this many calm minutes. */
export const WALK_WEIGHT = 3;

type Rec = { tMs: number; clearedMs: number; tier: string };

export type Easing = {
  /** the read's own score */
  from: number;
  /** the eased score now */
  score: number;
  risk: RiskLevel;
  /** calm minutes since the read (or since the last incident cleared, if later) */
  calmMin: number;
  /** of those, minutes of normal walking */
  walkMin: number;
  /** why it is not easing right now, if it is not */
  held: string | null;
};

/** Phone time things last changed: the newest Watch / Danger incident start or clear. */
export function lastChangeMs(records: Rec[]): number {
  let t = 0;
  for (const r of records) {
    if (r.tier === 'context') continue;
    t = Math.max(t, r.tMs, r.clearedMs);
  }
  return t;
}

/**
 * The eased score for a read made at `readAtMs` (phone clock). `walkS` = seconds of normal walking counted since
 * calm began (from the phone's `calmWalkS`). `floor` = the lowest level the engine's own state allows.
 */
export function easeRisk(a: { score: number; risk: RiskLevel }, o: {
  readAtMs: number;
  nowMs: number;
  records: Rec[];
  alertRunning: boolean;
  checkPending: boolean;
  walkS: number;
  floor?: RiskLevel | null;
}): Easing {
  const hold = (held: string): Easing => ({ from: a.score, score: a.score, risk: a.risk, calmMin: 0, walkMin: 0, held });
  if (o.alertRunning) return hold('an alert is running');
  if (o.checkPending) return hold('a check-in is pending');
  if (o.records.some((r) => r.tier !== 'context' && r.clearedMs === 0)) return hold('an incident is still active');
  const since = Math.max(o.readAtMs, lastChangeMs(o.records));
  const calmMin = Math.max(0, (o.nowMs - since) / 60_000);
  const walkMin = Math.min(calmMin, Math.max(0, o.walkS) / 60);
  const effective = calmMin + (WALK_WEIGHT - 1) * walkMin;
  let score = Math.round(a.score * 0.5 ** (effective / HALF_LIFE_MIN));
  if (o.floor) score = Math.max(score, RISK_BAND[o.floor][0]);
  score = Math.min(score, a.score);
  // the read's own level stays until the score has actually left its band
  const risk = score === a.score ? a.risk : levelOf(score);
  return { from: a.score, score, risk, calmMin, walkMin, held: null };
}

const minutes = (m: number) => (m < 1 ? 'under a minute' : `${Math.round(m)} min`);

/** The read as shown: the eased score and level, with the easing as one more "down" step in the reasoning. */
export function withEasing(a: Analysis, e: Easing): Analysis {
  const off = e.score - e.from;
  if (off >= 0) return a;
  const factor = `Calm for ${minutes(e.calmMin)}${e.walkMin >= 1 ? `, ${minutes(e.walkMin)} of it walking normally` : ''} since the read`;
  const step: Driver = { factor, ids: [], effect: 'down', points: off };
  return { ...a, score: e.score, risk: e.risk, trajectory: 'easing', drivers: [...a.drivers, step], ledger: a.ledger + off };
}
