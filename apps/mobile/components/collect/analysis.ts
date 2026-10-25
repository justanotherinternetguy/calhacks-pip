// Offline calibration over recorded sessions: per-label gait statistics, a personal baseline from normal walking, and
// a replay of the unsteady-walking rule with other thresholds. Advisory only: it reads what the phone's engine already
// computed (the per-second metric bands) and never runs on live data. Detection stays in Rust.
//
// The rule simulator mirrors core/crates/safety-core:
//   engine.rs `gait_incidents` → `Bands::unsteady_out` (signal/live.rs; model-v1 `incidents.unsteady_metrics` picks which: regularity, sway, wobble since v6. UNSTEADY_SIDE: stride_cv, sway, wobble above
//   the band, regularity below it) → `DriftTracker::push_walking` (signal/drift.rs). Only full-rate walking gait
//   windows are fed. A window with an unsteady metric out of band extends the run; persistence is
//   (last − first) + hop seconds and opens at ≥ persist_s. An in-band walking window resets the run. A walking window
//   that comes more than gap_s + hop after the last out-of-band one resets it first. Once open, the incident clears
//   after clear_s seconds of in-band walking and can then open again.
//
// Where it is approximate:
//   - It works on the ≈1 Hz state snapshots the phone streamed, not on every gait window. The engine hops 1 s, so this
//     is close, but a dropped frame loses a window, and a snapshot that repeats the previous gait window (same values)
//     is skipped as a duplicate.
//   - "Walking" is the phone's live `activity == walking` at full rate. The engine also requires the OS activity not to
//     be stationary or vehicle, which the stream does not carry.
//   - Each labelled segment is replayed on its own (state reset at its start), like `tools/collect export --split`.
//     On the phone a run can carry across a label change.
//   - "Require N metrics off" is not an engine option (the engine fires on any one metric); it is here to explore.
//
// Pure (type imports + local .ts modules) so `node --test` can run it.
import { STEADY_WALK_LABELS, TRANSITION, UNSTEADY_LABELS, placementFromLabel } from './actions.ts';
import { closedSegments, labelAt, type BandSnap, type CollectSession } from './session.ts';

export const GAIT_METRICS = ['stride_cv', 'regularity', 'sway', 'wobble', 'cadence'] as const;
export type GaitMetric = (typeof GAIT_METRICS)[number];
export const UNSTEADY_METRICS = ['stride_cv', 'regularity', 'sway', 'wobble'] as const;
export type UnsteadyMetric = (typeof UNSTEADY_METRICS)[number];
/** +1 = above the band is unsteady, −1 = below (signal/live.rs UNSTEADY_SIDE). */
export const UNSTEADY_SIDE: Record<UnsteadyMetric, 1 | -1> = { stride_cv: 1, regularity: -1, sway: 1, wobble: 1 };
/** A personal baseline is shaky below this many normal-walking windows. */
export const MIN_BASELINE_WINDOWS = 60;

export type Win = {
  t: number;
  walking: boolean;
  /** operator placement if set, else the phone's guess */
  placement: string;
  values: Partial<Record<GaitMetric, number>>;
  phone: Partial<Record<GaitMetric, BandSnap>>;
};
export type SegmentWindows = {
  sessionId: string;
  label: string;
  start: number;
  end: number;
  windows: Win[];
  incidents: { t: number; kind: string }[];
};

const gaitKey = (b: Record<string, BandSnap>) => GAIT_METRICS.map((m) => b[m]?.value ?? 'x').join('|');

/** The windows of every labelled action segment (transition segments left out). */
export function segmentWindows(sessions: CollectSession[]): SegmentWindows[] {
  const out: SegmentWindows[] = [];
  for (const s of sessions) {
    const snaps = [...s.metrics].sort((a, b) => a.t - b.t);
    const wins: Win[] = [];
    let prevWalkKey: string | null = null;
    for (const snap of snaps) {
      const walking = snap.activity === 'walking' && snap.samplingFull;
      if (walking) {
        // the same gait window repeated by a faster state block: count it once
        const key = gaitKey(snap.bands);
        if (key === prevWalkKey) continue;
        prevWalkKey = key;
      } else prevWalkKey = null;
      const values: Win['values'] = {};
      const phone: Win['phone'] = {};
      for (const m of GAIT_METRICS) {
        const b = snap.bands[m];
        if (!b) continue;
        phone[m] = b;
        // wobble needs the gyro; 0 means it was not measured
        if (m === 'wobble' && b.value === 0) continue;
        values[m] = b.value;
      }
      wins.push({ t: snap.t, walking, placement: placementFromLabel(labelAt(s.placements, snap.t)) ?? snap.placement, values, phone });
    }
    for (const g of closedSegments(s.actions, s.lastT)) {
      if (g.label === TRANSITION) continue;
      out.push({
        sessionId: s.id, label: g.label, start: g.start, end: g.end,
        windows: wins.filter((w) => w.t >= g.start && w.t < g.end),
        incidents: s.incidents.filter((r) => r.tMs >= g.start && r.tMs < g.end).map((r) => ({ t: r.tMs, kind: r.kind })),
      });
    }
  }
  return out;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function meanSd(xs: number[]): { mean: number; sd: number; n: number } {
  const n = xs.length;
  if (!n) return { mean: NaN, sd: NaN, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, sd: Math.sqrt(v), n };
}

/** The phone's own verdict for a window: an unsteady metric out of band on the concerning side. */
export function phoneOff(w: Win, m: UnsteadyMetric): boolean {
  const b = w.phone[m];
  return !!b && !b.inBand && Math.sign(b.sdDistance) === UNSTEADY_SIDE[m];
}

export type MetricSummary = { n: number; p10: number; median: number; p90: number; oobPct: number | null };
export type LabelStats = {
  label: string;
  segments: number;
  seconds: number;
  windows: number;
  walking: number;
  metrics: Record<GaitMetric, MetricSummary>;
  /** walking windows with any unsteady metric out of band under the phone's config */
  oobPct: number | null;
  incidents: Record<string, number>;
};

export function labelStats(segs: SegmentWindows[]): LabelStats[] {
  const by = new Map<string, SegmentWindows[]>();
  for (const g of segs) by.set(g.label, [...(by.get(g.label) ?? []), g]);
  const out: LabelStats[] = [];
  for (const [label, list] of by) {
    const walk = list.flatMap((g) => g.windows.filter((w) => w.walking));
    const metrics = {} as Record<GaitMetric, MetricSummary>;
    for (const m of GAIT_METRICS) {
      const xs = walk.map((w) => w.values[m]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
      const oob = m === 'cadence' ? null : walk.length ? (100 * walk.filter((w) => phoneOff(w, m)).length) / walk.length : null;
      metrics[m] = { n: xs.length, p10: quantile(xs, 0.1), median: quantile(xs, 0.5), p90: quantile(xs, 0.9), oobPct: oob };
    }
    const incidents: Record<string, number> = {};
    for (const g of list) for (const r of g.incidents) incidents[r.kind] = (incidents[r.kind] ?? 0) + 1;
    out.push({
      label,
      segments: list.length,
      seconds: list.reduce((a, g) => a + (g.end - g.start) / 1000, 0),
      windows: list.reduce((a, g) => a + g.windows.length, 0),
      walking: walk.length,
      metrics,
      oobPct: walk.length ? (100 * walk.filter((w) => UNSTEADY_METRICS.some((m) => phoneOff(w, m))).length) / walk.length : null,
      incidents,
    });
  }
  return out.sort((a, b) => b.seconds - a.seconds);
}

export type BaselineStats = Record<GaitMetric, { mean: number; sd: number; n: number }>;
/** Per placement: mean and SD of each metric over normal-walking windows. */
export type PersonalBaseline = Record<string, { n: number; stats: BaselineStats }>;

export function personalBaseline(segs: SegmentWindows[], label = 'normal_walking'): PersonalBaseline {
  const by = new Map<string, Win[]>();
  for (const g of segs) {
    if (g.label !== label) continue;
    for (const w of g.windows) if (w.walking) by.set(w.placement, [...(by.get(w.placement) ?? []), w]);
  }
  const out: PersonalBaseline = {};
  for (const [placement, ws] of by) {
    const stats = {} as BaselineStats;
    for (const m of GAIT_METRICS) stats[m] = meanSd(ws.map((w) => w.values[m]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)));
    out[placement] = { n: ws.length, stats };
  }
  return out;
}

export type SimParams = {
  /** band half-width in SD */
  k: number;
  /** seconds of out-of-band walking before it opens (unsteady_persist_s) */
  persistS: number;
  /** drift_gap_s */
  gapS: number;
  /** gait.hop_s */
  hopS: number;
  /** unsteady_clear_s */
  clearS: number;
  metrics: UnsteadyMetric[];
  /** metrics that must be off in the same window (the engine uses 1) */
  requireN: number;
  /** band centre and width: the phone's recorded band, or the personal baseline from normal walking */
  source: 'phone' | 'personal';
};
export const DEFAULT_SIM: SimParams = {
  k: 2.5, persistS: 35, gapS: 6, hopS: 1, clearS: 120, metrics: ['regularity', 'sway', 'wobble'], requireN: 1, source: 'personal',
};

type Band = { mean: number; sd: number };
function bandFor(w: Win, m: UnsteadyMetric, p: SimParams, base: PersonalBaseline | null): Band | null {
  if (p.source === 'personal') {
    const s = base?.[w.placement]?.stats[m];
    if (s && s.n >= 2 && Number.isFinite(s.mean) && Number.isFinite(s.sd)) return s;
  }
  const b = w.phone[m];
  return b ? { mean: b.mean, sd: b.sd } : null;
}

/** How many of the chosen metrics are off on the unsteady side in this window. */
export function offCount(w: Win, p: SimParams, base: PersonalBaseline | null): number {
  let n = 0;
  for (const m of p.metrics) {
    const v = w.values[m];
    const b = bandFor(w, m, p, base);
    if (v == null || !b) continue;
    const sd = Math.max(b.sd, 1e-6);
    if (UNSTEADY_SIDE[m] > 0 ? v > b.mean + p.k * sd : v < b.mean - p.k * sd) n++;
  }
  return n;
}

export type SimRun = { fires: number[]; walkingWindows: number; offWindows: number };

/** Replay the DriftTracker over time-sorted windows (non-walking ones are skipped, as in the engine). */
export function simulateWindows(windows: Win[], p: SimParams, base: PersonalBaseline | null): SimRun {
  let first: number | null = null;
  let last: number | null = null;
  let active = false;
  let inband = 0;
  const fires: number[] = [];
  let walkingWindows = 0;
  let offWindows = 0;
  for (const w of windows) {
    if (!w.walking) continue;
    walkingWindows++;
    if (last != null && (w.t - last) / 1000 > p.gapS + p.hopS) { first = null; last = null; }
    const off = offCount(w, p, base) >= Math.max(1, p.requireN);
    if (!off) {
      first = null; last = null;
      if (active) {
        inband += p.hopS;
        if (inband + 1e-3 >= p.clearS) { active = false; inband = 0; }
      }
      continue;
    }
    offWindows++;
    inband = 0;
    if (first == null) first = w.t;
    last = w.t;
    if (!active && (last - first) / 1000 + p.hopS + 1e-3 >= p.persistS) {
      active = true;
      fires.push(w.t);
    }
  }
  return { fires, walkingWindows, offWindows };
}

export type LabelSim = {
  label: string;
  segments: number;
  segmentsFired: number;
  fires: number;
  walkingS: number;
  firesPerMin: number | null;
  /** median seconds from segment start to its first fire, over segments that fired */
  firstFireS: number | null;
  offPct: number | null;
  kind: 'steady' | 'unsteady' | 'other';
};

const median = (xs: number[]) => (xs.length ? quantile([...xs].sort((a, b) => a - b), 0.5) : null);
export const labelKind = (label: string): LabelSim['kind'] =>
  STEADY_WALK_LABELS.includes(label) ? 'steady' : UNSTEADY_LABELS.includes(label) ? 'unsteady' : 'other';

export function simulateLabels(segs: SegmentWindows[], p: SimParams, base: PersonalBaseline | null): LabelSim[] {
  const by = new Map<string, { segs: number; fired: number; fires: number; walk: number; off: number; first: number[] }>();
  for (const g of segs) {
    const r = simulateWindows(g.windows, p, base);
    const e = by.get(g.label) ?? { segs: 0, fired: 0, fires: 0, walk: 0, off: 0, first: [] };
    e.segs++;
    e.fires += r.fires.length;
    e.walk += r.walkingWindows;
    e.off += r.offWindows;
    if (r.fires.length) { e.fired++; e.first.push((r.fires[0] - g.start) / 1000); }
    by.set(g.label, e);
  }
  return [...by.entries()].map(([label, e]) => {
    const walkingS = e.walk * p.hopS;
    return {
      label, segments: e.segs, segmentsFired: e.fired, fires: e.fires, walkingS,
      firesPerMin: walkingS > 0 ? e.fires / (walkingS / 60) : null,
      firstFireS: median(e.first),
      offPct: e.walk ? (100 * e.off) / e.walk : null,
      kind: labelKind(label),
    };
  }).sort((a, b) => (a.kind === b.kind ? b.walkingS - a.walkingS : a.kind === 'unsteady' ? -1 : b.kind === 'unsteady' ? 1 : a.kind === 'steady' ? -1 : 1));
}

export type SweepCell = {
  k: number; persistS: number;
  /** false alarms per minute of steady walking, and the share of steady segments with one */
  faPerMin: number | null; faSegPct: number | null;
  /** share of unsteady / stumbling segments that fired, and the median time to fire */
  detPct: number | null; detFirstS: number | null;
};
export const SWEEP_K = [2, 2.5, 3, 3.5, 4];
export const SWEEP_P = [10, 15, 20, 30, 35, 45];

export function sweep(segs: SegmentWindows[], base: PersonalBaseline | null, p: SimParams, ks = SWEEP_K, ps = SWEEP_P): SweepCell[][] {
  return ks.map((k) => ps.map((persistS) => {
    const rows = simulateLabels(segs, { ...p, k, persistS }, base);
    const steady = rows.filter((r) => r.kind === 'steady');
    const unsteady = rows.filter((r) => r.kind === 'unsteady');
    const sum = (rs: LabelSim[], f: (r: LabelSim) => number) => rs.reduce((a, r) => a + f(r), 0);
    const steadyS = sum(steady, (r) => r.walkingS);
    const steadySegs = sum(steady, (r) => r.segments);
    const unsteadySegs = sum(unsteady, (r) => r.segments);
    const firsts = unsteady.map((r) => r.firstFireS).filter((x): x is number => x != null);
    return {
      k, persistS,
      faPerMin: steadyS > 0 ? sum(steady, (r) => r.fires) / (steadyS / 60) : null,
      faSegPct: steadySegs ? (100 * sum(steady, (r) => r.segmentsFired)) / steadySegs : null,
      detPct: unsteadySegs ? (100 * sum(unsteady, (r) => r.segmentsFired)) / unsteadySegs : null,
      detFirstS: median(firsts),
    };
  }));
}
