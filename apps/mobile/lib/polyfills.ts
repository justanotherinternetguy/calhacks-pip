/**
 * Hermes has no global `crypto`. Some deps (supabase-js, uuid helpers) call crypto.getRandomValues/randomUUID
 * for request/correlation ids. Nothing security-relevant runs in JS (all real crypto is in the Rust core),
 * so a Math.random-backed shim is acceptable here. Replace with expo-crypto / react-native-get-random-values
 * if JS-side randomness ever becomes security-relevant.
 */
import { uuidv4 } from './uuid';

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown; randomUUID?: unknown } };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = <T extends ArrayBufferView | null>(arr: T): T => {
    if (arr) {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
    }
    return arr;
  };
}
if (typeof g.crypto.randomUUID !== 'function') g.crypto.randomUUID = uuidv4;
