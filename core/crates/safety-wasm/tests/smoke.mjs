// Node smoke test for the wasm build (run by `core/build-wasm.sh --test`).
// Usage: node smoke.mjs <dir containing a `--target nodejs` wasm-pack build>
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) { console.error('usage: node smoke.mjs <nodejs-pkg-dir>'); process.exit(2); }
const w = await import(pathToFileURL(path.join(path.resolve(dir), 'safety_wasm.js')).href);

const enc = (s) => new TextEncoder().encode(s);

// identity + fingerprint
const alice = w.generate_identity();
const bob = w.generate_identity();
for (const k of ['x25519Secret', 'x25519Public', 'ed25519Secret', 'ed25519Public']) {
  assert.ok(alice[k] instanceof Uint8Array && alice[k].length === 32, `${k} is a 32-byte Uint8Array`);
}
const fp = w.fingerprint('user-1', alice.x25519Public, alice.ed25519Public);
assert.match(fp, /^([0-9a-f]{4}-){7}[0-9a-f]{4}$/, 'fingerprint shape');
assert.equal(fp, w.fingerprint('user-1', alice.x25519Public, alice.ed25519Public), 'fingerprint deterministic');

// day/hour keys + shamir
const dayKey = w.new_day_key();
assert.equal(dayKey.length, 32);
const hourKey = w.derive_hour_key(dayKey, 490_123);
assert.equal(hourKey.length, 32);
assert.notDeepEqual(Array.from(hourKey), Array.from(w.derive_hour_key(dayKey, 490_124)), 'hour keys differ per hour');
const shares = w.split_day_key(dayKey, 2, 3);
assert.equal(shares.length, 3);
assert.ok(shares.every((s) => typeof s.index === 'number' && s.data instanceof Uint8Array && s.data.length === 32));
assert.deepEqual(Array.from(w.combine_shares([shares[0], shares[2]])), Array.from(dayKey), 'any 2 of 3 shares recover K_day');
assert.throws(() => w.combine_shares([shares[0]]), /./, 'single share fails');

// seal / open (share escrow + released key path), with the real AAD conventions
const aad = enc('hour|epoch-1|490123');
const sealed = w.seal_to(bob.x25519Public, alice.ed25519Secret, hourKey, aad);
const opened = w.open_sealed(bob.x25519Secret, alice.ed25519Public, sealed, aad);
assert.deepEqual(Array.from(opened), Array.from(hourKey), 'seal/open round-trip');
assert.throws(() => w.open_sealed(bob.x25519Secret, alice.ed25519Public, sealed, enc('hour|epoch-1|490124')), /signature|open/i, 'wrong aad rejected');
assert.throws(() => w.open_sealed(bob.x25519Secret, bob.ed25519Public, sealed, aad), /signature/i, 'wrong sender rejected');
assert.throws(() => w.open_sealed(alice.x25519Secret, alice.ed25519Public, sealed, aad), /./, 'wrong recipient rejected');
let msg = '';
try { w.seal_to(new Uint8Array(5), alice.ed25519Secret, hourKey, aad); } catch (e) { msg = e.message; }
assert.match(msg, /32 bytes/, 'errors surface as JS Error with message');

// approval envelope: [index u8] ++ share
const approval = new Uint8Array(1 + shares[1].data.length);
approval[0] = shares[1].index; approval.set(shares[1].data, 1);
const sealedApproval = w.seal_to(bob.x25519Public, alice.ed25519Secret, approval, enc('approval|subject|epoch-1'));
const got = w.open_sealed(bob.x25519Secret, alice.ed25519Public, sealedApproval, enc('approval|subject|epoch-1'));
assert.equal(got[0], shares[1].index);
assert.deepEqual(Array.from(w.combine_shares([shares[0], { index: got[0], data: got.slice(1) }])), Array.from(dayKey));

// location round-trip
const loc = { lat: 42.35051, lng: -71.10542, accuracyM: 12.5, tMs: 1_761_300_000_123 };
const blob = w.encrypt_location(hourKey, 'user-1', 'epoch-1', 1_761_300_000_123, loc);
assert.equal(blob.length, 68, 'blob is 68 bytes');
const dec = w.decrypt_location(hourKey, 'user-1', 'epoch-1', 1_761_300_000_123, blob);
assert.equal(dec.lat, loc.lat); assert.equal(dec.lng, loc.lng); assert.equal(dec.tMs, loc.tMs);
assert.ok(Math.abs(dec.accuracyM - loc.accuracyM) < 1e-6);
assert.throws(() => w.decrypt_location(hourKey, 'user-1', 'epoch-1', 1_761_300_000_124, blob), /./, 'wrong seq (aad) rejected');
assert.throws(() => w.decrypt_location(w.derive_hour_key(dayKey, 1), 'user-1', 'epoch-1', 1_761_300_000_123, blob), /./, 'wrong key rejected');
assert.throws(() => w.encrypt_location(hourKey, 'u', 'e', 1.5, loc), /integer/, 'non-integer seq rejected');

// proximity
const gk = new Uint8Array(32).fill(7);
const a = w.proximity_tokens(gk, 42.3505, -71.1054);
const b = w.proximity_tokens(gk, 42.3506, -71.1055);
const far = w.proximity_tokens(gk, 51.5, -0.12);
assert.equal(a.length, 9); assert.ok(a.every((t) => t instanceof Uint8Array && t.length === 16));
assert.equal(w.proximity_match(a, b), true);
assert.equal(w.proximity_match(a, far), false);

console.log('safety-wasm smoke: all checks passed');
