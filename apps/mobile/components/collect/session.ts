// One labelled data-collection session on /collect, and the recorder that fills it from telemetry ticks.
//
// The phone streams 10 Hz frames; while a collection session runs each frame carries `raw` (≈5 samples of 50 Hz
// motion) and the engine's 1 Hz `state` block (live metrics and bands). The recorder keeps the samples in columns,
// deduped by phone time, one snapshot per new state block, the incident records the engine opened during the
// session, and the operator's action and placement segments. Every time here is phone unix ms: the laptop clock
// differs from the phone's, so label boundaries are set at the newest phone sample time, never at Date.now().
//
// Pure (type imports only) so `node --test` can run it.
import type { Activity, IncidentRecord, Placement, TelemetryTick } from '@/modules/safety-native';

export const SESSION_VERSION = 1;
/** A jump between consecutive samples larger than this is a gap (50 Hz = 20 ms per sample). */
export const GAP_MS = 60;
/** Laptop-side keepalive: `collect_start` is re-sent this often while recording. */
export const KEEPALIVE_MS = 60_000;
/** How long each `collect_start` keeps the phone collecting without another keepalive. */
export const KEEPALIVE_MINUTES = 3;

export type Segment = { label: string; start: number; end: number | null };
export type MotionColumns = {
  t: number[];
  ax: number[]; ay: number[]; az: number[];
  gx: number[]; gy: number[]; gz: number[];
  rx: number[]; ry: number[]; rz: number[];
};
export type BandSnap = { value: number; mean: number; sd: number; sdDistance: number; inBand: boolean };
/** One engine state block (≈1 Hz). `t` is `metrics.tMs` (phone ms). */
export type MetricSnap = {
  t: number;
  activity: Activity;
  placement: Placement;
  samplingFull: boolean;
  trusted: boolean;
  evidence: string;
  battery: number;
  bands: Record<string, BandSnap>;
};
/** `samples`: a jump in phone sample time. `frames`: telemetry frames missing by `seq`. `t` = phone ms before the gap. */
export type Gap = { kind: 'samples' | 'frames'; t: number; ms: number; frames?: number };

export type CollectSession = {
  version: typeof SESSION_VERSION;
  id: string;
  subjectId: string;
  subjectName: string;
  participant: string;
  notes: string;
  /** placement at the start (the placement track holds changes) */
  placement: string;
  device: string;
  /** laptop ms */
  createdAt: number;
  updatedAt: number;
  status: 'recording' | 'stopped';
  /** the phone ran demo-sensitivity thresholds (null = phone did not say) */
  demo: boolean | null;
  /** phone ms of the first / newest sample (null until one arrived) */
  t0: number | null;
  lastT: number | null;
  motion: MotionColumns;
  actions: Segment[];
  placements: Segment[];
  /** labels picked before the first sample arrived; they open at that sample */
  pendingAction: string | null;
  pendingPlacement: string | null;
  metrics: MetricSnap[];
  incidents: IncidentRecord[];
  frameGaps: Gap[];
  frames: number;
};

export type SessionInit = {
  id: string; subjectId: string; subjectName: string; participant: string; notes: string;
  placement: string; device?: string; createdAt: number; action?: string | null;
};

const emptyMotion = (): MotionColumns => ({ t: [], ax: [], ay: [], az: [], gx: [], gy: [], gz: [], rx: [], ry: [], rz: [] });

export function newSession(init: SessionInit): CollectSession {
  return {
    version: SESSION_VERSION,
    id: init.id,
    subjectId: init.subjectId,
    subjectName: init.subjectName,
    participant: init.participant,
    notes: init.notes,
    placement: init.placement,
    device: init.device ?? 'android',
    createdAt: init.createdAt,
    updatedAt: init.createdAt,
    status: 'recording',
    demo: null,
    t0: null,
    lastT: null,
    motion: emptyMotion(),
    actions: [],
    placements: [],
    pendingAction: init.action ?? null,
    pendingPlacement: `in_${init.placement}`,
    metrics: [],
    incidents: [],
    frameGaps: [],
    frames: 0,
  };
}

/** The label of the segment that covers phone time `t` (segments are [start, end); an open one runs on). */
export function labelAt(segments: Segment[], t: number): string | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (t >= s.start && (s.end == null || t < s.end)) return s.label;
  }
  return null;
}

/** Segments with an end: an open one ends at `endAt` (the newest sample). Zero-length ones are dropped. */
export function closedSegments(segments: Segment[], endAt: number | null): { label: string; start: number; end: number }[] {
  const out: { label: string; start: number; end: number }[] = [];
  for (const s of segments) {
    const end = s.end ?? endAt ?? s.start;
    if (end > s.start) out.push({ label: s.label, start: s.start, end });
  }
  return out;
}

/** Sample-time gaps over sorted times. */
export function findSampleGaps(sortedT: ArrayLike<number>, gapMs = GAP_MS): Gap[] {
  const out: Gap[] = [];
  for (let i = 1; i < sortedT.length; i++) {
    const d = sortedT[i] - sortedT[i - 1];
    if (d > gapMs) out.push({ kind: 'samples', t: sortedT[i - 1], ms: d });
  }
  return out;
}

/** Indices of the motion rows in time order (stable; dedupe happened on the way in). */
export function sortedOrder(t: number[]): number[] {
  const idx = t.map((_, i) => i);
  let sorted = true;
  for (let i = 1; i < t.length; i++) if (t[i] < t[i - 1]) { sorted = false; break; }
  if (!sorted) idx.sort((a, b) => t[a] - t[b] || a - b);
  return idx;
}

export const incidentKey = (r: Pick<IncidentRecord, 'id' | 'tMs'>) => `${r.id}:${r.tMs}`;

export type RecorderStats = {
  samples: number;
  durationMs: number;
  hz: number;
  sampleGaps: number;
  frameGaps: number;
  /** phone ms lost to sample gaps (beyond one normal sample interval each) */
  lostMs: number;
  frames: number;
  snapshots: number;
};

/**
 * Accumulates ticks into a CollectSession. Mutates the session it holds (no copies on the 10 Hz path);
 * `session` is what gets saved.
 */
export class CollectRecorder {
  readonly session: CollectSession;
  private seen = new Set<number>();
  private lastSeq: number | null = null;
  private lastMetricT: number | null = null;
  private incidentIdx = new Map<string, number>();
  private gapCache: { n: number; gaps: Gap[] } | null = null;
  /** local ms the newest sample arrived (for a smooth phone-time estimate between frames) */
  lastSampleAt = 0;

  constructor(session: CollectSession) {
    this.session = session;
    for (const t of session.motion.t) this.seen.add(t);
    session.incidents.forEach((r, i) => this.incidentIdx.set(incidentKey(r), i));
    this.lastMetricT = session.metrics.at(-1)?.t ?? null;
  }

  get recording() { return this.session.status === 'recording'; }

  /** The session start in phone time: the first sample, else what the phone reports. */
  private startPhone(tick: TelemetryTick): number | null {
    if (this.session.t0 != null) return this.session.t0;
    const c = tick.collect;
    return c && c.on && c.startedMs > 0 ? c.startedMs : null;
  }

  /** Fold one tick in. Returns the number of new samples. Ignored once stopped. */
  push(tick: TelemetryTick, receivedAt = Date.now()): number {
    const s = this.session;
    if (s.status !== 'recording') return 0;
    // frames by seq. A replayed tick (same seq, e.g. a late listener joining the hub) is not a new frame, and its
    // samples are deduped below anyway. A lower seq means the phone's publisher restarted: count from there.
    if (this.lastSeq == null || tick.seq !== this.lastSeq) {
      if (this.lastSeq != null && tick.seq > this.lastSeq + 1) {
        const missing = tick.seq - this.lastSeq - 1;
        s.frameGaps.push({ kind: 'frames', t: s.lastT ?? tick.st, ms: missing * 100, frames: missing });
      }
      s.frames += 1;
      this.lastSeq = tick.seq;
    }
    if (tick.collect) s.demo = tick.collect.demo;

    let added = 0;
    const raw = tick.raw;
    if (raw && Array.isArray(raw.t)) {
      const m = s.motion;
      for (let i = 0; i < raw.t.length; i++) {
        const t = raw.t[i];
        if (typeof t !== 'number' || !Number.isFinite(t) || this.seen.has(t)) continue;
        this.seen.add(t);
        const v = (arr: number[] | undefined, k: number) => {
          const x = arr?.[i * 3 + k];
          return typeof x === 'number' && Number.isFinite(x) ? x : 0;
        };
        m.t.push(t);
        m.ax.push(v(raw.a, 0)); m.ay.push(v(raw.a, 1)); m.az.push(v(raw.a, 2));
        m.gx.push(v(raw.g, 0)); m.gy.push(v(raw.g, 1)); m.gz.push(v(raw.g, 2));
        m.rx.push(v(raw.r, 0)); m.ry.push(v(raw.r, 1)); m.rz.push(v(raw.r, 2));
        if (s.t0 == null || t < s.t0) s.t0 = t;
        if (s.lastT == null || t > s.lastT) s.lastT = t;
        added++;
      }
      if (added) {
        this.lastSampleAt = receivedAt;
        this.openPending();
      }
    }

    // one snapshot per new state block (every merged tick repeats the newest one)
    const mt = tick.metrics?.tMs;
    if (typeof mt === 'number' && mt !== this.lastMetricT && (s.t0 == null || mt >= s.t0 - 2_000)) {
      this.lastMetricT = mt;
      const bands: Record<string, BandSnap> = {};
      for (const b of tick.metrics.bands) bands[b.name] = { value: b.value, mean: b.mean, sd: b.sd, sdDistance: b.sdDistance, inBand: b.inBand };
      s.metrics.push({
        t: mt, activity: tick.metrics.activity, placement: tick.metrics.placement, samplingFull: tick.metrics.samplingFull,
        trusted: tick.metrics.baselineTrusted, evidence: tick.metrics.evidence ?? '', battery: tick.battery, bands,
      });
    }

    // incidents the engine opened during the session (upsert: records are re-sent when they clear)
    const start = this.startPhone(tick);
    if (start != null) {
      for (const r of tick.incidents) {
        if (r.tMs < start) continue;
        const k = incidentKey(r);
        const at = this.incidentIdx.get(k);
        if (at == null) { this.incidentIdx.set(k, s.incidents.length); s.incidents.push(r); } else s.incidents[at] = r;
      }
    }
    if (added || tick.incidents.length) s.updatedAt = receivedAt;
    return added;
  }

  /** Open the labels picked before the first sample, at that sample. */
  private openPending() {
    const s = this.session;
    if (s.t0 == null) return;
    if (s.pendingAction) { s.actions.push({ label: s.pendingAction, start: s.t0, end: null }); s.pendingAction = null; }
    if (s.pendingPlacement) { s.placements.push({ label: s.pendingPlacement, start: s.t0, end: null }); s.pendingPlacement = null; }
  }

  private switchTo(track: 'actions' | 'placements', label: string): boolean {
    const s = this.session;
    if (s.status !== 'recording') return false;
    const pendingKey = track === 'actions' ? 'pendingAction' : 'pendingPlacement';
    if (s.lastT == null) {
      if (s[pendingKey] === label) return false;
      s[pendingKey] = label;
      return true;
    }
    const segs = s[track];
    const open = segs.at(-1);
    if (open && open.end == null) {
      if (open.label === label) return false;
      if (open.start >= s.lastT) {
        // nothing recorded under the open one yet: relabel it instead of leaving a zero-length segment
        open.label = label;
        const prev = segs.at(-2);
        if (prev && prev.end === open.start && prev.label === label) { segs.pop(); prev.end = null; }
        return true;
      }
      open.end = s.lastT;
    }
    segs.push({ label, start: s.lastT, end: null });
    return true;
  }

  /** The action happening now. Closes the open action at the newest sample time. Returns false when nothing changed. */
  setAction(label: string): boolean { return this.switchTo('actions', label); }
  setPlacement(label: string): boolean { return this.switchTo('placements', label); }

  /** The open action (or the pending one before the first sample). */
  currentAction(): string | null {
    const s = this.session;
    if (s.pendingAction) return s.pendingAction;
    const open = s.actions.at(-1);
    return open && open.end == null ? open.label : null;
  }
  currentActionStart(): number | null {
    const open = this.session.actions.at(-1);
    return open && open.end == null ? open.start : null;
  }
  currentPlacement(): string | null {
    const s = this.session;
    if (s.pendingPlacement) return s.pendingPlacement;
    const open = s.placements.at(-1);
    return open && open.end == null ? open.label : null;
  }

  /** End the session: open segments close at the newest sample. */
  stop(now = Date.now()) {
    const s = this.session;
    if (s.status !== 'recording') return;
    for (const segs of [s.actions, s.placements]) {
      const open = segs.at(-1);
      if (open && open.end == null) open.end = Math.max(open.start, s.lastT ?? open.start);
    }
    s.pendingAction = null;
    s.pendingPlacement = null;
    s.status = 'stopped';
    s.updatedAt = now;
  }

  /** Sample gaps, recomputed only when samples were added. */
  sampleGaps(): Gap[] {
    const t = this.session.motion.t;
    if (this.gapCache && this.gapCache.n === t.length) return this.gapCache.gaps;
    const order = sortedOrder(t);
    const gaps = findSampleGaps(order.map((i) => t[i]));
    this.gapCache = { n: t.length, gaps };
    return gaps;
  }

  stats(): RecorderStats {
    return sessionStats(this.session, this.sampleGaps());
  }

  /** Phone time now, estimated from the newest sample and how long ago it arrived. */
  phoneNow(localNow = Date.now()): number | null {
    const t = this.session.lastT;
    return t == null ? null : t + Math.max(0, Math.min(5_000, localNow - this.lastSampleAt));
  }
}

export function sessionStats(s: CollectSession, gaps?: Gap[]): RecorderStats {
  const n = s.motion.t.length;
  const durationMs = s.t0 != null && s.lastT != null ? s.lastT - s.t0 : 0;
  const g = gaps ?? findSampleGaps(sortedOrder(s.motion.t).map((i) => s.motion.t[i]));
  const lostMs = g.reduce((acc, x) => acc + Math.max(0, x.ms - 20), 0);
  return {
    samples: n,
    durationMs,
    hz: durationMs > 0 ? ((n - 1) * 1000) / durationMs : 0,
    sampleGaps: g.length,
    frameGaps: s.frameGaps.length,
    lostMs,
    frames: s.frames,
    snapshots: s.metrics.length,
  };
}

const statsCache = new WeakMap<CollectSession, { n: number; g: number; stats: RecorderStats }>();
/** sessionStats, cached per session object until it gains samples or frame gaps (the sessions list redraws at 2 Hz). */
export function cachedSessionStats(s: CollectSession): RecorderStats {
  const c = statsCache.get(s);
  if (c && c.n === s.motion.t.length && c.g === s.frameGaps.length) return c.stats;
  const stats = sessionStats(s);
  statsCache.set(s, { n: s.motion.t.length, g: s.frameGaps.length, stats });
  return stats;
}
