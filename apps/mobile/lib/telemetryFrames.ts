// Pure parsing / merging of what arrives on the telemetry channel (CONTRACTS §7). No imports beyond types, so it can be
// unit-tested with plain Node (see tools or run `tsc` + node on the compiled file).
//
// Two payload shapes exist on the wire:
//   v1 `TelemetryTick`  — one complete tick per message (older phones, 4 Hz).
//   v2 `TelemetryFrame` — 10 Hz: raw samples + events + incident deltas every frame, the engine `state` block only when
//                         it changed or at least once a second. `FrameMerger` folds frames into complete ticks for the UI.
//
// Older phone builds still send extra fields (`hmm`, `pDanger`, `riskBand`, `metrics.activeIds`) and records without
// tier / clearedMs: the guards only require what every generation shares (`metrics.bands`, `escalation`), extra
// fields are ignored, and `normState` / `normIncident` fill the v2 fields with defaults.
import type { IncidentRecord, LiveMetrics, TelemetryFrame, TelemetryState, TelemetryTick } from '@/modules/safety-native';

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function isState(s: unknown): s is TelemetryState {
  if (!s || typeof s !== 'object') return false;
  const t = s as Partial<TelemetryState>;
  return !!t.metrics && Array.isArray(t.metrics.bands) && typeof t.escalation === 'string';
}

/** Fill the v2 state fields an older phone does not send (listening, metrics.listening / context). */
function normState(s: TelemetryState): TelemetryState {
  const listening = typeof s.listening === 'boolean' ? s.listening : false;
  const m: Partial<LiveMetrics> = s.metrics;
  const metrics: LiveMetrics = {
    ...s.metrics,
    listening: typeof m.listening === 'boolean' ? m.listening : listening,
    context: Array.isArray(m.context) ? m.context : [],
  };
  return { ...s, listening, metrics };
}

/**
 * Fill v2 record fields. A record from an older phone has no clearing rule, so it is shown as a logged moment
 * (cleared at its own time) rather than one that never clears.
 */
export function normIncident(r: IncidentRecord): IncidentRecord {
  const p: Partial<IncidentRecord> = r;
  return {
    ...r,
    tier: p.tier === 'context' || p.tier === 'watch' || p.tier === 'danger' ? p.tier : 'watch',
    clearedMs: isNum(p.clearedMs) ? p.clearedMs : r.tMs,
    acknowledged: p.acknowledged === true,
  };
}

/** Runtime guard for a v1 tick. */
export function isTelemetryTick(p: unknown): p is TelemetryTick {
  if (!p || typeof p !== 'object') return false;
  const t = p as Partial<TelemetryTick>;
  return t.v === 1 && isNum(t.t) && isNum(t.seq) && Array.isArray(t.accel) && Array.isArray(t.gyro)
    && Array.isArray(t.incidents) && Array.isArray(t.events) && isState(t);
}

/** Runtime guard for a v2 frame (with or without a `state` block). */
export function isTelemetryFrame(p: unknown): p is TelemetryFrame {
  if (!p || typeof p !== 'object') return false;
  const f = p as Partial<TelemetryFrame>;
  return f.v === 2 && isNum(f.t) && isNum(f.seq) && Array.isArray(f.accel) && Array.isArray(f.gyro)
    && Array.isArray(f.incidents) && Array.isArray(f.events) && (f.state === undefined || isState(f.state));
}

/**
 * Folds the stream into complete ticks. A v1 tick passes straight through; a v2 frame is merged with the newest
 * `state` seen on this subscription and is dropped (returns null) until the first state block arrived — at most a
 * second after joining. `reset()` on resubscribe so a stale state never dresses up a new stream.
 */
export class FrameMerger {
  private state: TelemetryState | null = null;
  /** Frames dropped for lack of a state block (diagnostics). */
  dropped = 0;

  reset() { this.state = null; this.dropped = 0; }

  merge(p: unknown): TelemetryTick | null {
    if (isTelemetryTick(p)) {
      this.state = normState(pickState(p));
      return {
        ...p,
        ...this.state,
        st: isNum((p as { st?: unknown }).st) && (p as { st: number }).st > 0 ? (p as { st: number }).st : p.t,
        incidents: p.incidents.map(normIncident),
      };
    }
    if (!isTelemetryFrame(p)) return null;
    if (p.state) this.state = normState(p.state);
    const s = this.state;
    if (!s) { this.dropped++; return null; }
    const tick: TelemetryTick = {
      ...s,
      v: 2,
      t: p.t,
      seq: p.seq,
      user: p.user,
      accel: p.accel,
      gyro: p.gyro,
      st: isNum(p.st) && p.st > 0 ? p.st : p.t,
      sampleHz: isNum(p.sampleHz) ? p.sampleHz : 0,
      incidents: p.incidents.map(normIncident),
      incidentCount: isNum(p.incidentCount) ? p.incidentCount : 0,
      events: p.events,
    };
    if (isNum(p.rttMs)) tick.rttMs = p.rttMs;
    return tick;
  }
}

function pickState(t: TelemetryTick): TelemetryState {
  const s: TelemetryState = {
    metrics: t.metrics, escalation: t.escalation, listening: t.listening, nightMode: t.nightMode,
    battery: t.battery, activity: t.activity, placement: t.placement, samplingFull: t.samplingFull,
  };
  if (t.checkPending !== undefined) s.checkPending = t.checkPending;
  if (t.checkSummary !== undefined) s.checkSummary = t.checkSummary;
  if (t.checkPhrase !== undefined) s.checkPhrase = t.checkPhrase;
  if (t.checkDeadlineMs !== undefined) s.checkDeadlineMs = t.checkDeadlineMs;
  return s;
}

/**
 * Phone-clock timestamps for the samples of one tick: the newest is `st`, the others spaced by the measured rate
 * (newest last, like `accel`). Falls back to 50 Hz when the phone reported no rate.
 */
export function sampleTimes(n: number, st: number, sampleHz: number): Float64Array {
  const dt = 1000 / (sampleHz > 0 ? sampleHz : 50);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = st - (n - 1 - i) * dt;
  return out;
}
