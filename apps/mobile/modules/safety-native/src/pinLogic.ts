// Key-pinning rules shared by the web module and its tests (the Android twin is KeyPins.kt). Pure: no I/O,
// type imports only, so `node --test` runs it.
import type { KeyPin, PinInput, PinResult } from './SafetyNative.types';

/** X25519 / Ed25519 public keys are 32 bytes; placeholders from the mock / Expo Go are never pinned. */
export function validKey(b64: string): boolean {
  try { return atob(b64.trim()).length === 32; } catch { return false; }
}

/**
 * new → pinned as given · same → upgraded to verified when `verified` · changed → left alone unless the user
 * re-verified in person (`replace && verified`), then replaced. Returns the next map (or the same one).
 */
export function applyPin(pins: Record<string, KeyPin>, p: PinInput, nowMs: number): { pins: Record<string, KeyPin>; result: PinResult } {
  const cur = pins[p.userId] ?? null;
  if (!validKey(p.x25519Pub) || !validKey(p.ed25519Pub)) return { pins, result: { status: 'invalid', pin: cur } };
  const make = (verified: boolean): KeyPin => ({ userId: p.userId, x25519Pub: p.x25519Pub, ed25519Pub: p.ed25519Pub, verified, pinnedAtMs: nowMs });
  if (!cur) {
    const pin = make(p.verified);
    return { pins: { ...pins, [p.userId]: pin }, result: { status: 'new', pin } };
  }
  if (cur.x25519Pub === p.x25519Pub && cur.ed25519Pub === p.ed25519Pub) {
    if (!p.verified || cur.verified) return { pins, result: { status: 'same', pin: cur } };
    const pin = make(true);
    return { pins: { ...pins, [p.userId]: pin }, result: { status: 'same', pin } };
  }
  if (p.replace && p.verified) {
    const pin = make(true);
    return { pins: { ...pins, [p.userId]: pin }, result: { status: 'changed', pin } };
  }
  return { pins, result: { status: 'changed', pin: cur } };
}

/** The Ed25519 key to check `userId`'s signature with: the pin when there is one (a mismatch throws), else the row's. */
export function signerKey(pins: Record<string, KeyPin>, userId: string, rowKeyB64: string): string {
  const pin = pins[userId];
  if (!pin) return rowKeyB64;
  if (pin.ed25519Pub !== rowKeyB64) throw new Error(`The signing key for ${userId.slice(0, 8)} does not match the key you verified`);
  return pin.ed25519Pub;
}
