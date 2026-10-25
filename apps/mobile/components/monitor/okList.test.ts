// Run: pnpm --filter mobile test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addConfirmation } from './okList.ts';

test('confirmations stay sorted and merge reports of the same moment', () => {
  let l = addConfirmation([], { atMs: 10_000, how: 'tapped' });
  l = addConfirmation(l, { atMs: 2_000, how: 'check_in' });
  assert.deepEqual(l.map((c) => c.atMs), [2_000, 10_000]);
  // an "I'm okay" right after an answered check-in is the same confirmation
  assert.equal(addConfirmation(l, { atMs: 4_000, how: 'tapped' }), l);
  // a check-in answer upgrades a tap logged a moment earlier
  const up = addConfirmation(l, { atMs: 12_000, how: 'check_in' });
  assert.deepEqual(up.map((c) => [c.atMs, c.how]), [[2_000, 'check_in'], [10_000, 'check_in']]);
  // the same report twice is a no-op
  assert.equal(addConfirmation(up, { atMs: 10_500, how: 'check_in' }), up);
});
