// Push-token registration. Stores the *native* token (FCM on Android, APNs on iOS)
// on this user's `devices` row so supabase/functions/push can reach the phone
// directly — we do not use Expo's push service. Everything here is fail-soft:
// a missing google-services.json or a denied permission only logs a warning.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { DEMO_MODE } from './env';
import { upsertDevice } from './db';

export type PushKind = 'fcm' | 'apns';

let tokenSub: { remove(): void } | null = null;

/** Human-readable reason a token could not be fetched, so the warning tells the dev what to set up. */
function explain(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (Platform.OS === 'android' && /Firebase|google-services|FCM|getToken|DEFAULT/i.test(msg)) {
    return `${msg} — Android needs apps/mobile/google-services.json (see docs/PUSH_SETUP.md) and a rebuild (expo prebuild + gradle).`;
  }
  if (Platform.OS === 'ios' && /aps-environment|entitlement|simulator|not supported/i.test(msg)) {
    return `${msg} — iOS push needs a real device and the Push Notifications capability/APNs key (see docs/PUSH_SETUP.md).`;
  }
  return msg;
}

async function ensurePermission(): Promise<boolean> {
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted || cur.status === 'granted') return true;
  if (!cur.canAskAgain && cur.status === 'denied') return false;
  const req = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false, allowCriticalAlerts: true },
  });
  return req.granted || req.status === 'granted';
}

async function saveToken(userId: string, deviceId: string, token: string, kind: PushKind) {
  await upsertDevice({
    id: deviceId, user_id: userId, platform: Platform.OS === 'ios' ? 'ios' : 'android',
    push_token: token, push_kind: kind,
  });
}

/**
 * Request notification permission, fetch the native device push token and PATCH it
 * onto `devices(id = deviceId)`. Also re-saves the token whenever the OS rotates it.
 * No-op on web and in offline demo mode. Never throws.
 */
export async function registerPushToken(userId: string, deviceId: string): Promise<{ token: string; kind: PushKind } | null> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return null;
  if (DEMO_MODE) { console.warn('push: skipped — no EXPO_PUBLIC_SUPABASE_URL (offline demo mode)'); return null; }
  const kind: PushKind = Platform.OS === 'ios' ? 'apns' : 'fcm';
  try {
    if (!(await ensurePermission())) {
      console.warn('push: notification permission not granted; friends cannot ring this phone');
      return null;
    }
    const t = await Notifications.getDevicePushTokenAsync();
    const token = typeof t.data === 'string' ? t.data : null;
    if (!token) { console.warn('push: unexpected token payload', t); return null; }
    await saveToken(userId, deviceId, token, kind);
    console.log(`push: ${kind} token registered for device ${deviceId.slice(0, 8)}`);

    tokenSub?.remove();
    tokenSub = Notifications.addPushTokenListener((next) => {
      if (typeof next.data !== 'string' || next.data === token) return;
      saveToken(userId, deviceId, next.data, kind).catch((e) => console.warn('push: token refresh save failed', e));
    });
    return { token, kind };
  } catch (e) {
    console.warn(`push: token registration failed (${kind}): ${explain(e)}`);
    return null;
  }
}

/** Stop following token rotations (sign-out). */
export function unregisterPushToken() {
  tokenSub?.remove();
  tokenSub = null;
}
