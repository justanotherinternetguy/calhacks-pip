import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteQr, parseQr, personQr } from './qr.ts';

const G = '11111111-1111-1111-1111-111111111111';
const U = '00000000-0000-0000-0000-00000000000a';
const T = 'ab'.repeat(32);

test('invite codes round-trip', () => {
  const raw = inviteQr({ groupId: G, groupName: 'Saturday crew', token: T, userId: U, name: 'Sam', x: 'eA==', e: 'ZQ==', fp: '1234-abcd' });
  assert.deepEqual(parseQr(raw), { kind: 'invite', groupId: G, groupName: 'Saturday crew', token: T, userId: U, name: 'Sam', x: 'eA==', e: 'ZQ==', fp: '1234-abcd' });
});

test('personal codes round-trip (and the v1 format from older builds still reads)', () => {
  assert.deepEqual(parseQr(personQr({ userId: U, x: 'eA==', e: 'ZQ==', fp: 'f' })), { kind: 'person', userId: U, x: 'eA==', e: 'ZQ==', fp: 'f' });
  assert.equal(parseQr(JSON.stringify({ v: 1, userId: U, fp: 'f', x: 'x', e: 'e' })).kind, 'person');
});

test('anything else is refused before a network call', () => {
  assert.throws(() => parseQr('https://example.com'), /Not a pip code/);
  assert.throws(() => parseQr(JSON.stringify({ v: 2, k: 'invite', g: G, u: U, t: 'short', x: 'x', e: 'e', fp: 'f' })), /damaged/);
  assert.throws(() => parseQr(JSON.stringify({ v: 1, userId: 'bob', fp: 'f', x: 'x', e: 'e' })), /no valid account id/);
  assert.throws(() => parseQr(JSON.stringify({ v: 3 })), /Not a pip code/);
});
