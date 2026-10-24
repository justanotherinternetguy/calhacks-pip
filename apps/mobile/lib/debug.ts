// Debug-only helpers: the inject-trace deep link and the local friend view are compiled out of release builds.
import { router } from 'expo-router';

export const DEBUG_ENABLED = __DEV__ || process.env.EXPO_PUBLIC_DEBUG === '1';

/** Trace names the e2e flows / demo use. Anything else is passed through to native by name. */
export const KNOWN_TRACES = ['checkin-dismiss', 'heads-up', 'unlock-map', 'snatch', 'manual-sos'] as const;

/** Pop every modal and land on the home tab; falls back to replace when nothing can be dismissed. */
export function goHome() {
  try { router.dismissTo('/home'); } catch { router.replace('/home'); }
}
