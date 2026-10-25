// Run: pnpm --filter mobile test (Node ≥ 23 type stripping; kept out of the app tsconfig, which has no Node types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncidentRecord, MetricBand, TelemetryTick } from '@/modules/safety-native';
import { CollectRecorder, labelAt, newSession, type CollectSession } from './session.ts';
import { toRecording } from './export.ts';
import {
  DEFAULT_SIM, UNSTEADY_METRICS, labelStats, personalBaseline, segmentWindows, simulateLabels, simulateWindows, sweep,
  type SimParams, type Win,
} from './analysis.ts';
import { shortcut } from './actions.ts';

const T0 = 1_761_400_000_000; // phone ms

function band(name: string, value: number, mean: number, sd: number, k = 2.5): MetricBand {
  const sdDistance = (value - mean) / sd;
  return { name, value, mean, sd, sdDistance, inBand: Math.abs(sdDistance) <= k };
}

type TickOpts = { seq: number; ts?: number[]; metricsT?: number; activity?: 'walking' | 'stationary'; gait?: Partial<Record<string, number>>; incidents?: IncidentRecord[] };
function tick(o: TickOpts): TelemetryTick {
  const ts = o.ts ?? [];
  const g = { cadence: 110, stride_cv: 0.05, regularity: 0.8, sway: 0.1, wobble: 20, ...o.gait };
  const bands = [
    band('cadence', g.cadence!, 110, 8), band('stride_cv', g.stride_cv!, 0.05, 0.01), band('regularity', g.regularity!, 0.8, 0.05),
    band('sway', g.sway!, 0.1, 0.02), band('wobble', g.wobble!, 20, 4),
  ];
  const mt = o.metricsT ?? T0;
  return {
    v: 2, t: ts.at(-1) ?? mt, seq: o.seq, user: 'u', accel: ts.map(() => 1), gyro: ts.map(() => 0), st: ts.at(-1) ?? 0, sampleHz: 50,
    incidents: o.incidents ?? [], incidentCount: 0, events: [],
    raw: ts.length ? { t: ts, a: ts.flatMap((t) => [t % 7 / 100, 0.01, -0.02]), g: ts.flatMap(() => [0, 0, -1]), r: ts.flatMap(() => [0.1, 0.2, 0.3]) } : undefined,
    metrics: {
      tMs: mt, placement: 'pocket', samplingFull: true, activity: o.activity ?? 'walking', bands, listening: false, context: [],
      baselineTrusted: true, baselineWalkDays: 7, evidence: '',
    },
    escalation: 'idle', listening: false, nightMode: false, battery: 80, activity: o.activity ?? 'walking', placement: 'pocket', samplingFull: true,
    collect: { allowed: true, on: true, startedMs: T0 - 500, untilMs: T0 + 180_000, label: null, demo: false },
  };
}
const range = (from: number, n: number, step = 20) => Array.from({ length: n }, (_, i) => from + i * step);
const session = (action: string | null = 'normal_walking'): CollectSession =>
  newSession({ id: 'abc123xyz', subjectId: 's', subjectName: 'Sam', participant: 'p01', notes: 'n', placement: 'pocket', createdAt: 0, action });

function rec(over: Partial<IncidentRecord>): IncidentRecord {
  return { id: 1, tMs: T0, kind: 'stumble', tier: 'context', summary: 's', sdDistance: 0, placement: 'pocket', rawJson: '{}', clearedMs: 0, acknowledged: false, sequenceId: 0, watched: false, ...over };
}

test('recorder dedupes replayed samples, counts frame and sample gaps', () => {
  const r = new CollectRecorder(session());
  r.push(tick({ seq: 1, ts: range(T0, 5) }));
  r.push(tick({ seq: 1, ts: range(T0, 5) })); // replay (late listener): nothing new
  r.push(tick({ seq: 2, ts: range(T0 + 100, 5) }));
  r.push(tick({ seq: 5, ts: range(T0 + 400, 5) })); // frames 3 and 4 lost: 300 ms hole in samples
  r.push(tick({ seq: 6, ts: [T0 + 480, T0 + 500, T0 + 520] })); // overlaps by one sample
  const s = r.session;
  assert.equal(s.motion.t.length, 17);
  assert.equal(new Set(s.motion.t).size, 17);
  assert.equal(s.frames, 4);
  assert.equal(s.frameGaps.length, 1);
  assert.equal(s.frameGaps[0].frames, 2);
  const gaps = r.sampleGaps();
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].t, T0 + 180);
  assert.equal(gaps[0].ms, 220);
  const st = r.stats();
  assert.equal(st.samples, 17);
  assert.equal(st.durationMs, 520);
  assert.equal(st.sampleGaps, 1);
  assert.equal(st.frameGaps, 1);
});

test('out-of-order samples are sorted for gaps and export', () => {
  const r = new CollectRecorder(session());
  r.push(tick({ seq: 1, ts: range(T0 + 100, 5) }));
  r.push(tick({ seq: 2, ts: range(T0, 5) })); // arrives late
  assert.equal(r.session.t0, T0);
  assert.equal(r.sampleGaps().length, 0);
  const out = toRecording(r.session);
  assert.deepEqual(out.motion.map((m) => m.t_ms), range(0, 10));
});

test('labels open at the first sample and switch at the newest phone sample time', () => {
  const r = new CollectRecorder(session('standing'));
  assert.equal(r.currentAction(), 'standing');
  r.setAction('normal_walking'); // before any sample: replaces the pending label
  r.push(tick({ seq: 1, ts: range(T0, 5) }));
  assert.deepEqual(r.session.actions, [{ label: 'normal_walking', start: T0, end: null }]);
  assert.deepEqual(r.session.placements, [{ label: 'in_pocket', start: T0, end: null }]);
  r.push(tick({ seq: 2, ts: range(T0 + 100, 5) }));
  assert.equal(r.setAction('normal_walking'), false, 'same label is a no-op');
  assert.equal(r.setAction('stumbling'), true);
  assert.equal(r.setAction('transition'), true); // no sample in between: relabels instead of a zero-length segment
  assert.deepEqual(r.session.actions, [{ label: 'normal_walking', start: T0, end: T0 + 180 }, { label: 'transition', start: T0 + 180, end: null }]);
  r.push(tick({ seq: 3, ts: range(T0 + 200, 5) }));
  r.setPlacement('in_hand');
  r.stop();
  assert.deepEqual(r.session.actions.at(-1), { label: 'transition', start: T0 + 180, end: T0 + 280 });
  assert.deepEqual(r.session.placements, [{ label: 'in_pocket', start: T0, end: T0 + 280 }, { label: 'in_hand', start: T0 + 280, end: T0 + 280 }]);
  assert.equal(labelAt(r.session.actions, T0 + 179), 'normal_walking');
  assert.equal(labelAt(r.session.actions, T0 + 180), 'transition');
  assert.equal(r.push(tick({ seq: 4, ts: range(T0 + 300, 5) })), 0, 'stopped: ignores ticks');
});

test('incidents during the session are kept and upserted; older ones are not', () => {
  const r = new CollectRecorder(session());
  r.push(tick({ seq: 1, ts: range(T0, 5), incidents: [rec({ id: 9, tMs: T0 - 60_000 }), rec({ id: 1, tMs: T0 + 50 })] }));
  r.push(tick({ seq: 2, ts: range(T0 + 100, 5), incidents: [rec({ id: 1, tMs: T0 + 50, clearedMs: T0 + 90 })] }));
  assert.equal(r.session.incidents.length, 1);
  assert.equal(r.session.incidents[0].clearedMs, T0 + 90);
});

test('export is a valid Recording with relative times, labels, context and extras', () => {
  const r = new CollectRecorder(session());
  r.push(tick({ seq: 1, ts: range(T0, 50), metricsT: T0 + 500 }));
  r.push(tick({ seq: 2, ts: range(T0 + 1000, 50), metricsT: T0 + 1500, incidents: [rec({ id: 3, tMs: T0 + 1200, kind: 'stumble' })] }));
  r.push(tick({ seq: 3, ts: range(T0 + 2000, 50), metricsT: T0 + 1500 })); // same state block: one snapshot
  r.setAction('stumbling');
  r.push(tick({ seq: 4, ts: range(T0 + 3000, 50), metricsT: T0 + 3500, activity: 'stationary' }));
  r.stop();
  const out = toRecording(r.session);
  assert.equal(out.motion.length, 200);
  assert.equal(out.motion[0].t_ms, 0);
  assert.deepEqual(Object.keys(out.motion[0]).sort(), ['ax', 'ay', 'az', 'gx', 'gy', 'gz', 'rx', 'ry', 'rz', 't_ms']);
  assert.equal(out.motion[1].rx, 0.1);
  assert.ok(out.motion.every((m, i) => i === 0 || m.t_ms > out.motion[i - 1].t_ms));
  assert.equal(out.context.length, 3);
  assert.deepEqual(out.context[0], { t_ms: 500, away_from_home: false, separated: false, hour_local: new Date(T0 + 500).getHours(), screen_on: false, activity: 'Walking', battery_pct: 80, speed_mps: -1 });
  assert.equal(out.context[2].activity, 'Stationary');
  assert.deepEqual(out.labels, [
    { label: 'in_pocket', t_start_ms: 0, t_end_ms: 3980 },
    { label: 'normal_walking', t_start_ms: 0, t_end_ms: 2980 },
    { label: 'stumbling', t_start_ms: 2980, t_end_ms: 3980 },
  ]);
  assert.equal(out.meta.scenario, 'mixed');
  assert.equal(out.meta.participant, 'p01');
  assert.equal(out.meta.placement, 'pocket');
  assert.equal(out.meta.t0_ms, T0);
  assert.equal(out.meta.demo_sensitivity, false);
  assert.ok(typeof out.meta.recorded_at === 'string');
  assert.equal(out.metrics.length, 3);
  assert.equal(out.metrics[2].label, 'stumbling');
  assert.equal(out.metrics[0].bands.stride_cv.mean, 0.05);
  assert.deepEqual(out.incidents.map((i) => [i.t_ms, i.kind, i.label]), [[1200, 'stumble', 'normal_walking']]);
  assert.deepEqual(out.gaps, [], 'frames back to back at 50 Hz: no gaps');
  // the recording must survive a JSON round trip unchanged (what tools/collect reads)
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});

test('the shortcuts map keys to actions and placements', () => {
  assert.deepEqual(shortcut('1'), { action: 'normal_walking' });
  assert.deepEqual(shortcut('H'), { placement: 'hand' });
  assert.equal(shortcut('z'), null);
});

// ---- rule simulator ---------------------------------------------------------------------------------------

const BASE = { stride_cv: { mean: 0.05, sd: 0.01, n: 100 }, regularity: { mean: 0.8, sd: 0.05, n: 100 }, sway: { mean: 0.1, sd: 0.02, n: 100 }, wobble: { mean: 20, sd: 4, n: 100 }, cadence: { mean: 110, sd: 8, n: 100 } };
/** One window per second from `t0` s; `off` marks windows with sway at +5 SD (and stride_cv too when `both`). */
function wins(spec: string, t0 = 0, both = false): Win[] {
  // spec chars: 'o' off walking, '.' in-band walking, '_' not walking
  return [...spec].map((c, i) => ({
    t: (t0 + i) * 1000,
    walking: c !== '_',
    placement: 'pocket',
    values: { stride_cv: c === 'o' && both ? 0.2 : 0.05, regularity: 0.8, sway: c === 'o' ? 0.2 : 0.1, wobble: 20, cadence: 110 },
    phone: {},
  }));
}
const P = (o: Partial<SimParams>): SimParams => ({ ...DEFAULT_SIM, metrics: [...UNSTEADY_METRICS], source: 'personal', persistS: 5, ...o });
const base = { pocket: { n: 100, stats: BASE } };

test('simulator: a run of P off windows fires once; an in-band window resets it', () => {
  assert.deepEqual(simulateWindows(wins('oooo'), P({}), base).fires, []);
  assert.deepEqual(simulateWindows(wins('ooooo'), P({}), base).fires, [4000]);
  assert.deepEqual(simulateWindows(wins('oooo.ooooo'), P({}), base).fires, [9000]);
  assert.deepEqual(simulateWindows(wins('oooooooooooo'), P({}), base).fires, [4000], 'stays open while it persists');
});

test('simulator: short pauses keep the run, a gap over 6 s resets it', () => {
  // 6 s of not walking between off windows: 7 s after the last off window = gap 6 + hop 1, still within
  assert.deepEqual(simulateWindows(wins('ooo______oo'), P({}), base).fires, [9000], 'the pause counts toward persistence, as in the engine');
  // 7 s of not walking: 8 s since the last off window > 7, the run restarts
  assert.deepEqual(simulateWindows(wins('ooo_______oo'), P({}), base).fires, []);
});

test('simulator: clears after clear_s of in-band walking and can fire again', () => {
  const w = wins(`ooooo${'.'.repeat(3)}ooooo`);
  assert.deepEqual(simulateWindows(w, P({ clearS: 3 }), base).fires, [4000, 12_000]);
  assert.deepEqual(simulateWindows(w, P({ clearS: 4 }), base).fires, [4000]);
});

test('simulator: metric choice, require-2 and k', () => {
  assert.deepEqual(simulateWindows(wins('ooooo'), P({ metrics: ['stride_cv'] }), base).fires, []);
  assert.deepEqual(simulateWindows(wins('ooooo'), P({ requireN: 2 }), base).fires, []);
  assert.deepEqual(simulateWindows(wins('ooooo', 0, true), P({ requireN: 2 }), base).fires, [4000]);
  assert.deepEqual(simulateWindows(wins('ooooo'), P({ k: 6 }), base).fires, [], 'sway at +5 SD is in a 6 SD band');
});

test('simulator: phone source uses the recorded band', () => {
  const w = wins('ooooo').map((x) => ({ ...x, phone: { sway: { value: 0.2, mean: 0.1, sd: 0.05, sdDistance: 2, inBand: true } } }));
  assert.deepEqual(simulateWindows(w, P({ source: 'phone' }), null).fires, [], '+2 SD on the phone band');
  assert.deepEqual(simulateWindows(w, P({ source: 'phone', k: 1.5 }), null).fires, [4000]);
});

/** A session from per-second windows: label segments in seconds. */
function fakeSession(id: string, segs: [string, number, number][], walk: (label: string, i: number) => Partial<Record<string, number>> | null): CollectSession {
  const s = newSession({ id, subjectId: 's', subjectName: 'S', participant: 'p', notes: '', placement: 'pocket', createdAt: 0 });
  s.status = 'stopped';
  s.t0 = T0;
  for (const [label, a, b] of segs) {
    s.actions.push({ label, start: T0 + a * 1000, end: T0 + b * 1000 });
    for (let i = a; i < b; i++) {
      const g = walk(label, i);
      const vals = { cadence: 110, stride_cv: 0.05, regularity: 0.8, sway: 0.1, wobble: 20, ...g };
      const bands: CollectSession['metrics'][number]['bands'] = {};
      for (const [k, v] of Object.entries(vals)) bands[k] = { value: v! + i * 1e-6, mean: 0, sd: 1, sdDistance: 0, inBand: true };
      s.metrics.push({ t: T0 + i * 1000 + 500, activity: g ? 'walking' : 'stationary', placement: 'pocket', samplingFull: true, trusted: true, evidence: '', battery: 50, bands });
    }
  }
  s.placements.push({ label: 'in_pocket', start: T0, end: T0 + segs.at(-1)![2] * 1000 });
  s.lastT = T0 + segs.at(-1)![2] * 1000;
  return s;
}

test('per-label stats, baseline and the simulator over a hand-made session', () => {
  // 90 s normal walking (sway alternates a little), 5 s transition, 40 s unsteady (sway way up), 20 s standing
  const s = fakeSession('x', [['normal_walking', 0, 90], ['transition', 90, 95], ['unsteady_walking', 95, 135], ['standing', 135, 155]], (label, i) =>
    label === 'standing' ? null : label === 'unsteady_walking' ? { sway: 0.4 } : { sway: i % 2 ? 0.11 : 0.09 });
  const segs = segmentWindows([s]);
  assert.deepEqual(segs.map((g) => [g.label, g.windows.length]), [['normal_walking', 90], ['unsteady_walking', 40], ['standing', 20]]);
  const stats = labelStats(segs);
  const nw = stats.find((x) => x.label === 'normal_walking')!;
  assert.equal(nw.seconds, 90);
  assert.equal(nw.walking, 90);
  assert.ok(Math.abs(nw.metrics.sway.median - 0.1) < 0.011);
  assert.equal(stats.find((x) => x.label === 'standing')!.walking, 0);
  const b = personalBaseline(segs);
  assert.equal(b.pocket.n, 90);
  assert.ok(Math.abs(b.pocket.stats.sway.mean - 0.1) < 1e-3);
  const sim = simulateLabels(segs, { ...DEFAULT_SIM, persistS: 35 }, b);
  const un = sim.find((x) => x.label === 'unsteady_walking')!;
  assert.equal(un.segmentsFired, 1);
  assert.equal(un.fires, 1);
  assert.equal(un.firstFireS, 34.5); // 35th window, at +0.5 s into its second
  assert.equal(sim.find((x) => x.label === 'normal_walking')!.fires, 0);
  assert.equal(sim[0].kind, 'unsteady');
  const grid = sweep(segs, b, DEFAULT_SIM, [2.5], [35, 45]);
  assert.equal(grid[0][0].detPct, 100);
  assert.equal(grid[0][0].faPerMin, 0);
  assert.equal(grid[0][1].detPct, 0, '40 s of unsteady walking never reaches 45 s');
});
