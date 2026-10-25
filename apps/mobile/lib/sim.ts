// Simulated friends. Everyone except a phone with real sensors gets made-up monitoring data: three invented friends
// (Kayla, Dev, Maya) plus any real account that has no phone registered (e.g. someone signed in on a laptop).
//
// Each simulated person follows a scripted 30-minute story that loops on the wall clock, so every device shows the
// same thing at the same moment. The output is an ordinary TelemetryTick (the shape the Android phone streams), so
// the map, the friend log and the full monitor console all read it without knowing it is simulated.
import type { Activity, EscalationLevel, IncidentKind, IncidentRecord, IncidentTier, MetricBand, TelemetryTick } from '@/modules/safety-native';
import type { TelemetryConnection } from './telemetry';

export const SIM_PREFIX = 'sim:';
export const isSimId = (id: string | null | undefined) => !!id && id.startsWith(SIM_PREFIX);

const CYCLE_S = 30 * 60;
const TICK_MS = 100;
const SAMPLE_HZ = 50;

type Motion = 'stationary' | 'walking' | 'unsteady' | 'dancing' | 'fall' | 'vehicle';
type Seg<T> = [atS: number, value: T];
type ScriptRecord = { at: number; kind: IncidentKind; tier: IncidentTier; summary: string; clearAt?: number; ack?: boolean; seq?: number };
type Script = {
  /** shifts the story so the friends are not all in the same chapter at once */
  offsetS: number;
  night: Seg<boolean>[];
  motion: Seg<Motion>[];
  escalation: Seg<EscalationLevel>[];
  checks: { from: number; to: number; summary: string }[];
  records: ScriptRecord[];
  /** [atS, metres east, metres north] of the group's meeting point; linear in between */
  path: [number, number, number][];
  battery: [number, number];
};

export type SimFriend = { id: string; name: string; phone: string | null };
export const SIM_FRIENDS: SimFriend[] = [
  { id: 'sim:kayla', name: 'Kayla', phone: null },
  { id: 'sim:dev', name: 'Dev', phone: null },
  { id: 'sim:maya', name: 'Maya', phone: null },
];

const SCRIPTS: Record<string, Script> = {
  // Wanders off, walks unsteadily, misses a check-in, falls; Dev reaches her after ~11 minutes.
  'sim:kayla': {
    offsetS: 0,
    night: [[0, true]],
    motion: [[0, 'dancing'], [300, 'walking'], [480, 'unsteady'], [560, 'walking'], [640, 'stationary'], [820, 'fall'], [823, 'stationary'], [1500, 'walking'], [1700, 'dancing']],
    escalation: [[0, 'idle'], [640, 'check'], [760, 'heads_up'], [880, 'unlocked'], [1500, 'resolved'], [1530, 'idle']],
    checks: [{ from: 640, to: 760, summary: 'Unsteady walking' }],
    records: [
      { at: 330, kind: 'separated', tier: 'watch', summary: 'Walked away from the group', clearAt: 1650 },
      { at: 500, kind: 'unsteady_gait', tier: 'watch', summary: 'Unsteady walk for 40 sec', clearAt: 560 },
      { at: 760, kind: 'check_in_missed', tier: 'watch', summary: 'Didn’t answer “You okay?”', clearAt: 1500, seq: 1 },
      { at: 820, kind: 'possible_fall', tier: 'danger', summary: 'Hard landing after a free fall', clearAt: 1500, seq: 1 },
      { at: 880, kind: 'down_after_fall', tier: 'danger', summary: 'No movement since the fall', clearAt: 1500, seq: 1 },
      { at: 1500, kind: 'fall_recovered', tier: 'context', summary: 'Up and walking · Dev is with her', clearAt: 1500 },
    ],
    path: [[0, 25, 15], [300, 25, 15], [420, -110, 95], [560, -220, 160], [640, -250, 185], [1500, -250, 185], [1700, 20, 20], [1800, 25, 15]],
    battery: [64, 51],
  },
  // Out with the group, a wobbly stretch and a stumble, answers his check-in, then takes a car home.
  'sim:dev': {
    offsetS: 900,
    night: [[0, true], [1560, false]],
    motion: [[0, 'walking'], [380, 'unsteady'], [520, 'walking'], [700, 'unsteady'], [760, 'stationary'], [860, 'walking'], [1200, 'vehicle'], [1560, 'stationary']],
    escalation: [[0, 'idle'], [770, 'check'], [835, 'idle']],
    checks: [{ from: 770, to: 890, summary: 'Stumbled while walking' }],
    records: [
      { at: 400, kind: 'unsteady_gait', tier: 'watch', summary: 'Weaving for about a minute', clearAt: 520 },
      { at: 720, kind: 'stumble', tier: 'watch', summary: 'Stumbled, caught himself', clearAt: 835, ack: true, seq: 1 },
      { at: 1210, kind: 'in_vehicle', tier: 'context', summary: 'Got in a car', clearAt: 1560 },
    ],
    path: [[0, 180, -40], [380, 230, 30], [700, 260, 90], [860, 250, 60], [1200, 160, -20], [1560, 1400, -900], [1800, 1400, -900]],
    battery: [38, 27],
  },
  // Leaves for another bar, comes back, walks home.
  'sim:maya': {
    offsetS: 1500,
    night: [[0, true], [1620, false]],
    motion: [[0, 'dancing'], [240, 'walking'], [560, 'dancing'], [960, 'walking'], [1240, 'dancing'], [1380, 'walking'], [1620, 'stationary']],
    escalation: [[0, 'idle']],
    checks: [],
    records: [
      { at: 260, kind: 'separated', tier: 'watch', summary: 'Left the group', clearAt: 1200 },
      { at: 1400, kind: 'slowed_walk', tier: 'context', summary: 'Walking slower than usual', clearAt: 1500 },
    ],
    path: [[0, -40, -30], [240, -40, -30], [560, -60, -420], [960, -60, -420], [1240, -30, -40], [1380, -30, -40], [1620, -600, -700], [1800, -600, -700]],
    battery: [81, 74],
  },
};

/** A real account without sensors: out with the group, nothing happening. */
function calmScript(id: string): Script {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const dx = (h % 80) - 40, dy = ((h >> 8) % 80) - 40;
  return {
    offsetS: h % CYCLE_S,
    night: [[0, true]],
    motion: [[0, 'dancing'], [600, 'stationary'], [900, 'dancing'], [1500, 'walking'], [1620, 'dancing']],
    escalation: [[0, 'idle']],
    checks: [],
    records: [],
    path: [[0, dx, dy], [1500, dx, dy], [1620, dx + 30, dy - 20], [1800, dx, dy]],
    battery: [72, 66],
  };
}
const scriptFor = (id: string) => SCRIPTS[id] ?? calmScript(id);

// ---- where the story happens -------------------------------------------------------------------------

export type LatLng = { lat: number; lng: number };
export const DEFAULT_ANCHOR: LatLng = { lat: 42.3505, lng: -71.1054 };
let anchor: LatLng = DEFAULT_ANCHOR;
/** The group's meeting point; simulated people are placed around it. Snapped to ~200 m so every device agrees. */
export function setSimAnchor(p: LatLng | null) {
  const next = p ? { lat: Math.round(p.lat * 500) / 500, lng: Math.round(p.lng * 500) / 500 } : DEFAULT_ANCHOR;
  anchor = next;
}
export const simAnchor = () => anchor;
export const offsetLatLng = (base: LatLng, eastM: number, northM: number): LatLng => ({
  lat: base.lat + northM / 111_320,
  lng: base.lng + eastM / (111_320 * Math.cos((base.lat * Math.PI) / 180)),
});

// ---- the state at a moment -----------------------------------------------------------------------------

const at = <T,>(segs: Seg<T>[], s: number): T => {
  let v = segs[0][1];
  for (const [t, x] of segs) if (t <= s) v = x;
  return v;
};
const segStart = <T,>(segs: Seg<T>[], s: number): number => {
  let from = 0;
  for (const [t] of segs) if (t <= s) from = t;
  return from;
};
function pathAt(path: Script['path'], s: number): [number, number] {
  for (let i = 1; i < path.length; i++) {
    const [t1, x1, y1] = path[i];
    const [t0, x0, y0] = path[i - 1];
    if (s <= t1) {
      const f = t1 === t0 ? 1 : (s - t0) / (t1 - t0);
      return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
    }
  }
  const last = path[path.length - 1];
  return [last[1], last[2]];
}

/** Where a script is right now: cycle number, seconds into the cycle, and when the cycle started. */
function phaseOf(script: Script, nowMs: number) {
  const total = nowMs / 1000 + script.offsetS;
  const cycle = Math.floor(total / CYCLE_S);
  const s = total - cycle * CYCLE_S;
  return { cycle, s, startMs: nowMs - s * 1000 };
}

function recordsAt(script: Script, cycle: number, s: number, startMs: number): IncidentRecord[] {
  return script.records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.at <= s)
    .map(({ r, i }) => ({
      id: (cycle % 1000) * 100 + i + 1,
      tMs: startMs + r.at * 1000,
      kind: r.kind,
      tier: r.tier,
      summary: r.summary,
      sdDistance: r.tier === 'danger' ? 6.2 : r.tier === 'watch' ? 3.1 : 0.4,
      placement: 'pocket' as const,
      rawJson: '{}',
      clearedMs: r.clearAt != null && r.clearAt <= s ? startMs + r.clearAt * 1000 : 0,
      acknowledged: !!r.ack && r.clearAt != null && r.clearAt <= s,
      sequenceId: r.seq ? (cycle % 100) * 10 + r.seq : 0,
      watched: false,
    }));
}

const BASE_BANDS: Omit<MetricBand, 'value' | 'sdDistance' | 'inBand'>[] = [
  { name: 'cadence', mean: 108, sd: 6 },
  { name: 'stride_cv', mean: 0.045, sd: 0.012 },
  { name: 'regularity', mean: 0.82, sd: 0.05 },
  { name: 'sway', mean: 0.11, sd: 0.025 },
  { name: 'wobble', mean: 0.06, sd: 0.015 },
  { name: 'jerk', mean: 3.2, sd: 0.9 },
  { name: 'rotation', mean: 42, sd: 12 },
  { name: 'peak_g', mean: 1.6, sd: 0.25 },
];
const BAND_SHIFT: Partial<Record<Motion, Record<string, number>>> = {
  unsteady: { cadence: -2.2, stride_cv: 3.4, regularity: -2.9, sway: 3.1, wobble: 2.7 },
  fall: { peak_g: 9.5, jerk: 6.8, rotation: 4.1 },
  dancing: { jerk: 1.6, rotation: 1.9, peak_g: 1.2 },
};

function bands(motion: Motion, jitter: () => number): MetricBand[] {
  const shift = BAND_SHIFT[motion] ?? {};
  return BASE_BANDS.map((b) => {
    const sdDistance = (shift[b.name] ?? 0) + jitter() * 0.6;
    return { ...b, value: b.mean + sdDistance * b.sd, sdDistance, inBand: Math.abs(sdDistance) <= 2.5 };
  });
}

const ACTIVITY: Record<Motion, Activity> = { stationary: 'stationary', walking: 'walking', unsteady: 'walking', dancing: 'stationary', fall: 'stationary', vehicle: 'vehicle' };

/** |a| (g) and |ω| (rad/s) for one sample `t` seconds into the current motion. */
function sample(motion: Motion, t: number, rnd: () => number): [number, number] {
  const n = (k: number) => rnd() * k;
  const TAU = Math.PI * 2;
  switch (motion) {
    case 'walking': return [1 + 0.28 * Math.sin(TAU * 1.9 * t) + 0.08 * Math.sin(TAU * 3.8 * t + 1) + n(0.04), Math.abs(0.9 + 0.5 * Math.sin(TAU * 0.95 * t) + n(0.08))];
    case 'unsteady': return [1 + (0.3 + 0.18 * Math.sin(TAU * 0.3 * t)) * Math.sin(TAU * 1.45 * t) + n(0.14), Math.abs(1.5 + 0.9 * Math.sin(TAU * 0.6 * t) + n(0.35))];
    case 'dancing': return [Math.max(0.2, 1 + 0.55 * Math.sin(TAU * 2.1 * t) * Math.abs(Math.sin(TAU * 0.23 * t)) + n(0.16)), Math.abs(1.8 + n(0.7))];
    case 'vehicle': return [1 + 0.04 * Math.sin(TAU * 0.35 * t) + n(0.04), Math.abs(0.12 + n(0.06))];
    case 'fall':
      if (t < 0.45) return [0.18 + n(0.05), 3.5 + n(0.6)];
      if (t < 0.6) return [4.3 + n(0.4), 6.2 + n(1)];
      if (t < 1.4) return [1 + 0.6 * Math.exp(-(t - 0.6) * 4) * Math.sin(TAU * 4 * t), 1.2 * Math.exp(-(t - 0.6) * 3)];
      return [1 + n(0.01), Math.abs(n(0.02))];
    default: return [1 + n(0.008), Math.abs(n(0.02))];
  }
}

/** Seeded so a person looks the same on every device within a tick (and noise stays cheap). */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return ((x >>> 0) / 4294967295) * 2 - 1;
  };
}

/** Full simulated state for `id` at `nowMs` (no waveform). Also used by the friends feed for a quick read. */
export function simState(id: string, nowMs: number) {
  const script = scriptFor(id);
  const { cycle, s, startMs } = phaseOf(script, nowMs);
  const motion = at(script.motion, s);
  const escalation = at(script.escalation, s);
  const check = script.checks.find((c) => c.from <= s && s < c.to && escalation === 'check');
  const [dx, dy] = pathAt(script.path, s);
  const loc = offsetLatLng(anchor, dx, dy);
  const nightMode = at(script.night, s);
  const records = recordsAt(script, cycle, s, startMs);
  const battery = Math.round(script.battery[0] + (script.battery[1] - script.battery[0]) * (s / CYCLE_S));
  return { script, cycle, s, startMs, motion, motionStartS: segStart(script.motion, s), escalation, check, loc, nightMode, records, battery };
}

/**
 * Same contract as subscribeTelemetry: ticks at 10 Hz (5 samples each), status updates, returns an unsubscribe.
 * Emits the engine events a real phone would on transitions, and `incident_log_cleared` when the story loops.
 */
export function subscribeSimulated(
  id: string,
  onTick: (tick: TelemetryTick, receivedAtMs: number) => void,
  onStatus: (s: TelemetryConnection) => void,
): () => void {
  let seq = 0;
  let prev: { cycle: number; escalation: EscalationLevel; ids: Set<number>; cleared: Set<number> } | null = null;
  const status: TelemetryConnection = { state: 'live', subscribedAt: Date.now(), lastTickAt: null, latencyMs: 40, rttMs: null, ticksPerSec: 10, attempts: 0, nextRetryAt: null, error: null };
  onStatus({ ...status });

  const emit = () => {
    const now = Date.now();
    const st = simState(id, now);
    const rnd = rng(Math.floor(now / TICK_MS) ^ (id.length * 2654435761));
    const per = (SAMPLE_HZ * TICK_MS) / 1000;
    const accel: number[] = [], gyro: number[] = [];
    for (let i = per - 1; i >= 0; i--) {
      const tIn = st.s - st.motionStartS - i / SAMPLE_HZ;
      const [a, g] = sample(st.motion, Math.max(0, tIn), rnd);
      accel.push(Math.round(a * 10_000) / 10_000);
      gyro.push(Math.round(g * 10_000) / 10_000);
    }

    const events: string[] = [];
    const ids = new Set(st.records.map((r) => r.id));
    const cleared = new Set(st.records.filter((r) => r.clearedMs > 0).map((r) => r.id));
    if (prev) {
      if (prev.cycle !== st.cycle) events.push('incident_log_cleared');
      for (const r of st.records) if (!prev.ids.has(r.id)) events.push('signal_incident');
      for (const r of cleared) if (!prev.cleared.has(r)) events.push('incident_cleared');
      if (prev.escalation !== st.escalation) {
        events.push(({ check: 'check_requested', heads_up: 'heads_up', unlocked: 'unlock_location', snatch: 'snatch_detected', resolved: 'resolved', idle: 'resolved' } as const)[st.escalation]);
      }
    }
    prev = { cycle: st.cycle, escalation: st.escalation, ids, cleared };

    const activeWatch = st.records.some((r) => r.clearedMs === 0 && r.tier !== 'context');
    const listening = st.escalation !== 'idle' || activeWatch;
    const activity = ACTIVITY[st.motion];
    const tick: TelemetryTick = {
      v: 2, t: now, seq: ++seq, user: id, accel, gyro, st: now, sampleHz: SAMPLE_HZ,
      incidents: st.records, incidentCount: st.records.length, events,
      escalation: st.escalation, listening, nightMode: st.nightMode, battery: st.battery, activity, placement: 'pocket', samplingFull: true,
      metrics: {
        tMs: now, placement: 'pocket', samplingFull: true, activity, bands: bands(st.motion, rnd), listening,
        context: st.nightMode ? ['away from home late'] : [], baselineTrusted: true, baselineWalkDays: 9,
        evidence: st.motion === 'unsteady' ? 'gait outside baseline: stride variability and sway high' : st.motion === 'fall' ? 'free fall then impact' : `${activity} · within baseline`,
      },
      loc: { ...st.loc, acc: 12, t: now },
    };
    if (st.check) Object.assign(tick, { checkPending: true, checkDeadlineMs: st.startMs + st.check.to * 1000, checkSummary: st.check.summary });
    status.lastTickAt = now;
    onTick(tick, now);
  };

  emit();
  const timer = setInterval(emit, TICK_MS);
  const statusTimer = setInterval(() => onStatus({ ...status }), 5_000);
  return () => { clearInterval(timer); clearInterval(statusTimer); };
}
