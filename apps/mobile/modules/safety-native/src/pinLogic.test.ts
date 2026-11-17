import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPin, signerKey, validKey } from './pinLogic.ts';

const k = (c: string) => btoa(c.repeat(32));
const A = { userId: 'u1', x25519Pub: k('a'), ed25519Pub: k('b'), verified: false };

test('placeholder keys are never pinned', () => {
  assert.equal(validKey(btoa('mock-x25519-u1')), false);
  assert.equal(applyPin({}, { ...A, x25519Pub: btoa('mock') }, 1).result.status, 'invalid');
});

test('first sight pins (trust on first use), a scan upgrades to verified', () => {
  const first = applyPin({}, A, 1);
  assert.equal(first.result.status, 'new');
  assert.equal(first.pins.u1.verified, false);
  const scanned = applyPin(first.pins, { ...A, verified: true }, 2);
  assert.equal(scanned.result.status, 'same');
  assert.equal(scanned.pins.u1.verified, true);
});

test('a swapped key is reported and NOT stored unless re-verified in person', () => {
  const { pins } = applyPin({}, { ...A, verified: true }, 1);
  const swapped = applyPin(pins, { ...A, ed25519Pub: k('z') }, 2);
  assert.equal(swapped.result.status, 'changed');
  assert.equal(swapped.pins.u1.ed25519Pub, k('b'), 'old pin kept');
  const reverified = applyPin(pins, { ...A, ed25519Pub: k('z'), verified: true, replace: true }, 3);
  assert.equal(reverified.pins.u1.ed25519Pub, k('z'));
});

test('signatures are checked against the pin', () => {
  const { pins } = applyPin({}, A, 1);
  assert.equal(signerKey(pins, 'u1', k('b')), k('b'));
  assert.throws(() => signerKey(pins, 'u1', k('z')));
  assert.equal(signerKey(pins, 'nobody', k('q')), k('q'), 'unpinned: the row key');
});
