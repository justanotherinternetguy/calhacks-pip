import type { Session } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

/** Offline demo session: no backend configured (DEMO_MODE). Native + mock still run; DB calls fail soft. */
export const DEMO_FLAG = 'safe.demo';
export const DEMO_USER_ID = '00000000-0000-4000-8000-00000000d3a0';

export function makeDemoSession(): Session {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: 'demo-access-token',
    refresh_token: 'demo-refresh-token',
    token_type: 'bearer',
    expires_in: 365 * 24 * 3600,
    expires_at: now + 365 * 24 * 3600,
    user: {
      id: DEMO_USER_ID, aud: 'authenticated', role: 'authenticated', email: 'demo@pip.local',
      app_metadata: { provider: 'demo' }, user_metadata: { display_name: 'Demo' }, created_at: new Date(now * 1000).toISOString(),
    },
  } as Session;
}

export const hasDemoFlag = async () => { try { return (await SecureStore.getItemAsync(DEMO_FLAG)) === '1'; } catch { return false; } };
export const setDemoFlag = async (on: boolean) => { try { on ? await SecureStore.setItemAsync(DEMO_FLAG, '1') : await SecureStore.deleteItemAsync(DEMO_FLAG); } catch {} };
