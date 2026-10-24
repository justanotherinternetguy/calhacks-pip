// Run: pnpm --filter mobile test (Node ≥ 23 type stripping; kept out of the app tsconfig, which has no Node types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncidentKind, IncidentRecord, IncidentTier } from '@/modules/safety-native';
import { buildTimeline, matchChains, timeBucket } from './incidentTimeline.ts';

const TIER: Record<IncidentKind, IncidentTier> = {
  phone_drop: 'watch', possible_fall: 'watch', fall_recovered: 'context', down_after_fall: 'danger', hard_impact: 'watch',
  unsteady_gait: 'watch', stumble: 'context', repeated_stumbles: 'watch', slowed_walk: 'watch',
  phone_left_behind: 'watch', grab: 'danger', separated: 'watch', stopped_on_way_home: 'watch', in_vehicle: 'context',
  battery_critical: 'context', check_in_missed: 'danger', typing_off: 'watch', scream_shout: 'watch', snoring_while_down: 'danger',
};
/** 23:00 local on the test day */
const T0 = new Date(2026, 9, 24, 23, 0, 0).getTime();
const S = 1000;

let nextId = 1;
/** kind at `at` seconds after T0; `cleared` seconds after T0 (omit = still active) */
function rec(kind: IncidentKind, at: number, cleared?: number, extra: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: nextId++, tMs: T0 + at * S, kind, tier: TIER[kind], summary: '', sdDistance: 0, placement: 'pocket', rawJson: '{}',
    clearedMs: cleared != null ? T0 + cleared * S : 0, acknowledged: false, sequenceId: 0, watched: false, ...extra,
  };
}
const names = (recs: IncidentRecord[], now: number) => matchChains(recs, T0 + now * S).map((m) => m.chain);

test('impact then scream within two minutes is violent_contact; five minutes apart is not', () => {
  assert.ok(names([rec('hard_impact', 0, 3), rec('scream_shout', 40)], 60).includes('violent_contact'));
  assert.ok(!names([rec('hard_impact', 0, 3), rec('scream_shout', 300)], 320).includes('violent_contact'));
});

test('order matters: scream then fall is scream_then_fall, not violent_contact', () => {
  const n = names([rec('scream_shout', 0), rec('possible_fall', 30)], 60);
  assert.ok(n.includes('scream_then_fall'));
  assert.ok(!n.includes('violent_contact'));
});

test('fall, down, missed check-in, snoring is a complete critical down_unresponsive', () => {
  const recs = [rec('possible_fall', 0), rec('down_after_fall', 18), rec('check_in_missed', 160), rec('snoring_while_down', 400)];
  const m = matchChains(recs, T0 + 420 * S).find((c) => c.chain === 'down_unresponsive');
  assert.ok(m);
  assert.equal(m.steps, '4/4');
  assert.equal(m.concern, 'critical');
  assert.deepEqual(m.gaps_s, [18, 142, 240]);
});

test('a part-way chain reports the next step and its window, then stalls when the window passes', () => {
  const recs = [rec('possible_fall', 0), rec('down_after_fall', 18)];
  const open = matchChains(recs, T0 + 100 * S).find((c) => c.chain === 'down_unresponsive');
  assert.ok(open && !open.complete);
  assert.deepEqual(open.next, { kinds: ['check_in_missed'], window_left_s: 900 - 82 });
  const late = matchChains(recs, T0 + 2000 * S).find((c) => c.chain === 'down_unresponsive');
  assert.ok(late?.stalled);
  assert.equal(late.next, undefined);
});

test('impaired, separated, then in a vehicle is led_away (high); the two-step subsets are folded into it', () => {
  const recs = [rec('unsteady_gait', 0), rec('slowed_walk', 120), rec('separated', 1500), rec('in_vehicle', 2400)];
  const ms = matchChains(recs, T0 + 2500 * S);
  const led = ms.find((c) => c.chain === 'led_away');
  assert.ok(led);
  assert.equal(led.steps, '3/3');
  assert.equal(led.concern, 'high');
  // latest impairment anchors the chain
  assert.equal(led.kinds[0], 'slowed_walk');
  // impaired → in_vehicle alone is contained in led_away: dropped
  assert.ok(!ms.some((c) => c.chain === 'impaired_then_moved'));
});

test('lone_drop needs ten quiet minutes either side', () => {
  assert.ok(!names([rec('phone_drop', 0)], 120).includes('lone_drop')); // too early to tell
  assert.ok(names([rec('phone_drop', 0)], 700).includes('lone_drop'));
  assert.ok(!names([rec('phone_drop', 0), rec('scream_shout', 200)], 900).includes('lone_drop'));
});

test('recovered_fall is withheld when a scream follows', () => {
  assert.ok(names([rec('possible_fall', 0, 20), rec('fall_recovered', 25, 25)], 60).includes('recovered_fall'));
  assert.ok(!names([rec('possible_fall', 0, 20), rec('fall_recovered', 25, 25), rec('scream_shout', 90)], 120).includes('recovered_fall'));
});

test('timeline: gaps, durations, bursts, overlaps, after_grab, trend', () => {
  const recs = [
    rec('unsteady_gait', 0, 600),
    rec('separated', 3000),
    rec('grab', 3100),
    rec('in_vehicle', 3200),
  ];
  const t = buildTimeline({ records: recs, nowMs: T0 + 3300 * S, escalation: 'snatch' });
  assert.equal(t.now.late_night, true);
  assert.deepEqual(t.incidents.map((i) => i.gap_s), [null, 3000, 100, 100]);
  assert.equal(t.incidents[0].lasted_s, 600);
  assert.equal(t.incidents[1].lasted_s, 300);
  assert.equal(t.incidents[3].after_grab, true);
  assert.equal(t.incidents[1].after_grab, undefined);
  assert.equal(t.bursts.length, 1);
  assert.deepEqual(t.bursts[0].kinds, ['separated', 'grab', 'in_vehicle']);
  assert.equal(t.bursts[0].worst_tier, 'danger');
  assert.deepEqual(t.overlaps.map((o) => o.kinds), [['separated', 'grab']]); // in_vehicle is context
  assert.equal(t.totals.unanswered_danger, 1);
  assert.equal(t.trend.last_15_min, 4); // separated 1 + grab 3
  assert.equal(t.trend.direction, 'rising');
  assert.ok(t.chains.some((c) => c.chain === 'grab_getaway'));
});

test('timeBucket moves with how long things stay open, then with calm', () => {
  const open = [rec('down_after_fall', 0)];
  assert.equal(timeBucket(open, T0 + 30 * S), 'a0');
  assert.equal(timeBucket(open, T0 + 130 * S), 'a2');
  assert.equal(timeBucket(open, T0 + 700 * S), 'a4');
  const done = [rec('separated', 0, 100)];
  assert.equal(timeBucket(done, T0 + 200 * S), 'c0');
  assert.equal(timeBucket(done, T0 + 2000 * S), 'c2');
  assert.equal(timeBucket([rec('in_vehicle', 0)], T0 + 50 * S), 'q');
});
