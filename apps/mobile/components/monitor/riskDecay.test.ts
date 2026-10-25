// Run: pnpm --filter mobile test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easeRisk, HALF_LIFE_MIN, withEasing } from './riskDecay.ts';
import type { Analysis } from './riskAnalysis';

const MIN = 60_000;
const read = { score: 60, risk: 'high' as const };
const cleared = (tMs: number, clearedMs: number, tier = 'watch') => ({ tMs, clearedMs, tier });
const base = { readAtMs: 0, records: [cleared(-5 * MIN, -1 * MIN)], alertRunning: false, checkPending: false, walkS: 0 };

test('halves every HALF_LIFE_MIN calm minutes and changes level with the score', () => {
  const e = easeRisk(read, { ...base, nowMs: HALF_LIFE_MIN * MIN });
  assert.equal(e.score, 30);
  assert.equal(e.risk, 'elevated');
  assert.equal(e.held, null);
  assert.equal(easeRisk(read, { ...base, nowMs: 3 * HALF_LIFE_MIN * MIN }).risk, 'low');
  assert.equal(easeRisk(read, { ...base, nowMs: 10 }).score, 60, 'nothing to ease yet');
});

test('normal walking eases faster than sitting still', () => {
  const still = easeRisk(read, { ...base, nowMs: 10 * MIN });
  const walked = easeRisk(read, { ...base, nowMs: 10 * MIN, walkS: 10 * 60 });
  assert.ok(walked.score < still.score, `${walked.score} vs ${still.score}`);
  assert.equal(walked.walkMin, 10);
  // walking can't count for more time than has passed
  assert.equal(easeRisk(read, { ...base, nowMs: 2 * MIN, walkS: 600 }).walkMin, 2);
});

test('holds while anything is open, and calm starts when the last incident cleared', () => {
  const open = easeRisk(read, { ...base, nowMs: 30 * MIN, records: [cleared(-5 * MIN, 0)] });
  assert.equal(open.score, 60);
  assert.equal(open.held, 'an incident is still active');
  assert.equal(easeRisk(read, { ...base, nowMs: 30 * MIN, alertRunning: true }).held, 'an alert is running');
  assert.equal(easeRisk(read, { ...base, nowMs: 30 * MIN, checkPending: true }).score, 60);
  // an open context-tier incident (a vehicle, a low battery) does not hold it
  assert.ok(easeRisk(read, { ...base, nowMs: 30 * MIN, records: [...base.records, cleared(0, 0, 'context')] }).score < 60);
  // cleared 20 min after the read: only the 10 min since count
  assert.equal(easeRisk(read, { ...base, nowMs: 30 * MIN, records: [cleared(5 * MIN, 20 * MIN)] }).calmMin, 10);
});

test('never below the engine floor; shows as a down step in the reasoning', () => {
  assert.equal(easeRisk(read, { ...base, nowMs: 120 * MIN, floor: 'elevated' }).score, 25);
  const a = { ...read, trajectory: 'steady', drivers: [], ledger: 60 } as unknown as Analysis;
  const shown = withEasing(a, easeRisk(read, { ...base, nowMs: HALF_LIFE_MIN * MIN, walkS: 120 }));
  assert.equal(shown.trajectory, 'easing');
  const step = shown.drivers.at(-1)!;
  assert.equal(step.effect, 'down');
  assert.equal(shown.ledger, a.ledger + step.points);
  assert.match(step.factor, /walking normally/);
  assert.equal(withEasing(a, easeRisk(read, { ...base, nowMs: 10 })), a, 'unchanged read stays the same object');
});
