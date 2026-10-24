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

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: Platform.OS === 'web' ? webStorage : secureStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});

if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
