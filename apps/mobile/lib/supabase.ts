import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './env';

// SecureStore caps values at ~2 KB on iOS; the session JSON is bigger, so chunk it.
const CHUNK = 1800;
const secureStorage = {
  async getItem(key: string) {
    const count = Number(await SecureStore.getItemAsync(`${key}.n`));
    if (!count) return null;
    const parts = await Promise.all(Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(`${key}.${i}`)));
    return parts.join('');
  },
  async setItem(key: string, value: string) {
    const n = Math.ceil(value.length / CHUNK);
    await Promise.all(Array.from({ length: n }, (_, i) => SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK))));
    await SecureStore.setItemAsync(`${key}.n`, String(n));
  },
  async removeItem(key: string) {
    const count = Number(await SecureStore.getItemAsync(`${key}.n`));
    await Promise.all(Array.from({ length: count }, (_, i) => SecureStore.deleteItemAsync(`${key}.${i}`)));
    await SecureStore.deleteItemAsync(`${key}.n`);
  },
};

const webStorage = {
  getItem: async (k: string) => globalThis.localStorage?.getItem(k) ?? null,
  setItem: async (k: string, v: string) => globalThis.localStorage?.setItem(k, v),
  removeItem: async (k: string) => globalThis.localStorage?.removeItem(k),
};

const authStorage = Platform.OS === 'web' ? webStorage : secureStorage;
/** supabase-js's own storage key for the persisted session (`sb-<project ref>-auth-token`). */
const AUTH_STORAGE_KEY = `sb-${(() => { try { return new URL(SUPABASE_URL).hostname.split('.')[0]; } catch { return 'local'; } })()}-auth-token`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: authStorage,
    storageKey: AUTH_STORAGE_KEY,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});

/**
 * The persisted session as supabase-js stored it, read WITHOUT going through `auth.getSession()` (which would try to
 * refresh an expired session with a refresh token native may already have rotated). Used by `adoptNativeSession`.
 */
export async function readStoredSession(): Promise<{ access_token: string; refresh_token: string; user?: { id: string } } | null> {
  try {
    const raw = await authStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as { access_token?: unknown; refresh_token?: unknown; user?: { id: string } };
    return typeof s.access_token === 'string' && typeof s.refresh_token === 'string' ? (s as { access_token: string; refresh_token: string; user?: { id: string } }) : null;
  } catch { return null; }
}

/** `exp` (unix ms) of a JWT, or 0 when it is not one. */
export function jwtExpMs(jwt: string): number {
  try {
    const b64 = jwt.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
    if (!b64) return 0;
    const exp = (JSON.parse(atob(b64)) as { exp?: number }).exp;
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch { return 0; }
}

if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
