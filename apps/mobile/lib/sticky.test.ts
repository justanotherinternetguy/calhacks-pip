import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stickyItems } from './sticky.ts';
import type { CheckIn, Incident } from './types';

const now = Date.parse('2026-11-12T01:00:00Z');
const ci = (o: Partial<CheckIn>): CheckIn => ({
  id: 'c1', asker_id: 'kai', target_id: 'me', group_id: 'g', status: 'pending', created_at: '2026-11-12T00:55:00Z',
  deadline_at: '2026-11-12T01:05:00Z', answered_at: null, incident_id: null, ...o,
});
const inc = (o: Partial<Incident>): Incident => ({
  id: 'i1', user_id: 'sam', group_id: 'g', level: 'sos', summary: null, opened_at: '2026-11-12T00:59:00Z', resolved_at: null, created_at: '', ...o,
});
const name = (id: string) => ({ kai: 'Kai', sam: 'Sam', me: 'Me' })[id] ?? 'Friend';

test('a question to me is sticky until answered; mine to a friend shows as waiting', () => {
  const items = stickyItems('me', [ci({}), ci({ id: 'c2', asker_id: 'me', target_id: 'sam' })], [], name, now);
  assert.deepEqual(items.map((i) => i.key), ['in:c1', 'out:c2']);
  assert.equal(items[0].title, 'Kai asks: you okay?');
  assert.equal(items[1].title, 'Waiting for Sam');
});

test('answered or cancelled check-ins close; a missed one stays answerable for a while', () => {
  assert.equal(stickyItems('me', [ci({ status: 'ok' }), ci({ id: 'c3', status: 'cancelled' })], [], name, now).length, 0);
  assert.equal(stickyItems('me', [ci({ status: 'missed' })], [], name, now)[0].key, 'in:c1');
  assert.equal(stickyItems('me', [ci({ status: 'missed' })], [], name, now + 3 * 3_600_000).length, 0);
});

test("friends' open alerts are sticky; mine, resolved and check-level ones are not", () => {
  const items = stickyItems('me', [], [
    inc({}), inc({ id: 'i2', user_id: 'me' }), inc({ id: 'i3', resolved_at: 'x' }), inc({ id: 'i4', level: 'check' }),
    inc({ id: 'i5', level: 'missed_check_in', summary: "didn't answer Kai's check-in" }),
  ], name, now);
  assert.deepEqual(items.map((i) => i.key), ['inc:i1', 'inc:i5']);
  assert.equal(items[0].title, 'Sam needs help');
  assert.equal(items[1].body, "Sam didn't answer Kai's check-in");
});
