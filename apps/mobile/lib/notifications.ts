// Incoming-push handling. On Android, pip's pushes are data-only and native posts them itself as sticky
// notifications (PipMessagingService → FriendAlerts), so they never reach these listeners there; this file covers
// iOS / other builds and taps: foreground display, ringing on a friend's 'ring', deep-linking to the incident or
// the friend check-in.
import * as Notifications from 'expo-notifications';
import { AndroidAudioContentType, AndroidAudioUsage, AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { SafetyNative } from '@/modules/safety-native';
import { refreshCheckInsAndSticky, refreshIncidents } from './native';

/** Must equal FCM_CHANNEL in supabase/functions/_shared/push.ts and AlertManager.CH_ALARM on Android. */
export const PUSH_CHANNEL_ID = 'alarm';
/** How long a remote 'ring' sounds the alarm (seconds). */
export const RING_SECONDS = 30;
/** Pushes that open the incident screen. */
const INCIDENT_KINDS = new Set(['heads_up', 'unlocked', 'snatch', 'offline', 'battery_dying', 'sos', 'missed_check_in', 'check', 'release', 'unlock_requested']);
/** Friend check-in pushes (functions/checkin); the request one opens the answer screen. */
const CHECKIN_KINDS = new Set(['checkin_request', 'checkin_answered', 'checkin_cancelled']);

export type PushData = { kind?: string; incidentId?: string; checkInId?: string; route?: string; critical?: string } & Record<string, unknown>;

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/**
 * FCM delivers `message.data` as a flat string map; expo-notifications surfaces it as
 * `content.data` (newer builds) and/or `trigger.remoteMessage.data`, and older builds
 * wrapped it as `{ body: '<json>' }`. APNs custom keys land in `content.data` directly.
 */
export function extractPushData(n: Notifications.Notification): PushData {
  const content = (n.request.content.data ?? {}) as Record<string, unknown>;
  const trig = n.request.trigger as { remoteMessage?: { data?: Record<string, string> } } | null | undefined;
  const remote = trig?.remoteMessage?.data ?? {};
  const out: Record<string, unknown> = { ...remote, ...content };
  if (typeof out.body === 'string' && out.body.trim().startsWith('{')) {
    try { Object.assign(out, JSON.parse(out.body)); } catch { /* plain text body */ }
  }
  return out as PushData;
}

export function routeFor(data: PushData): string | null {
  if (typeof data.route === 'string' && data.route.startsWith('/')) return data.route;
  if (data.kind && INCIDENT_KINDS.has(data.kind) && typeof data.incidentId === 'string' && data.incidentId) return `/incident/${data.incidentId}`;
  if (data.kind && CHECKIN_KINDS.has(data.kind) && typeof data.checkInId === 'string' && data.checkInId) return `/checkin/${data.checkInId}`;
  return null;
}

let lastRing: { incidentId: string; atMs: number } | null = null;

/** Sound the native alarm once per incident per RING_SECONDS, so a foreground receipt + tap don't double-ring. */
function ringIfNeeded(data: PushData) {
  if (data.kind !== 'ring') return;
  const id = data.incidentId ?? '';
  const now = Date.now();
  if (lastRing && lastRing.incidentId === id && now - lastRing.atMs < RING_SECONDS * 1000) return;
  lastRing = { incidentId: id, atMs: now };
  SafetyNative.ringAlarm(RING_SECONDS).catch((e) => console.warn('ringAlarm failed', e));
}

/**
 * Common reaction to a push. `interaction` is true when the user tapped the notification
 * (always navigate); on a silent foreground receipt we still ring and jump to the incident
 * because these are safety alerts, but we leave non-incident pushes (e.g. 'nudge') alone.
 */
export function handlePush(data: PushData, interaction: boolean) {
  ringIfNeeded(data);
  if (data.kind && CHECKIN_KINDS.has(data.kind)) void refreshCheckInsAndSticky().catch(() => {});
  else if (data.kind && data.kind !== 'ring') void refreshIncidents().catch(() => {});
  const route = routeFor(data);
  if (!route) return;
  if (interaction || (data.kind && (INCIDENT_KINDS.has(data.kind) || data.kind === 'checkin_request'))) {
    try { router.push(route as never); } catch (e) { console.warn('push route failed', route, e); }
  }
}

/**
 * Android: the native AlertManager creates the 'alarm' channel on module init. If it isn't
 * there (fresh install before native ran, or a build without the module) create an
 * equivalent one so FCM messages with channel_id='alarm' are not silently dropped.
 */
async function ensureAlarmChannel() {
  if (Platform.OS !== 'android') return;
  try {
    if (await Notifications.getNotificationChannelAsync(PUSH_CHANNEL_ID)) return;
    await Notifications.setNotificationChannelAsync(PUSH_CHANNEL_ID, {
      name: 'Friend alarm',
      description: 'Rings loudly when a friend tries to reach you',
      importance: AndroidImportance.MAX,
      bypassDnd: true,
      enableVibrate: true,
      vibrationPattern: [0, 500, 250, 500],
      lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
      sound: 'default',
      audioAttributes: { usage: AndroidAudioUsage.ALARM, contentType: AndroidAudioContentType.SONIFICATION },
    });
  } catch (e) { console.warn('alarm channel', e); }
  // Pre-push builds created a 'safe-alerts' channel nothing posts to any more.
  Notifications.deleteNotificationChannelAsync('safe-alerts').catch(() => {});
}

export function initNotifications() {
  if (Platform.OS === 'web') return () => {};
  const received = Notifications.addNotificationReceivedListener((n) => handlePush(extractPushData(n), false));
  const responded = Notifications.addNotificationResponseReceivedListener((r) => handlePush(extractPushData(r.notification), true));
  // Cold start from a tapped notification.
  Notifications.getLastNotificationResponseAsync()
    .then((r) => r && handlePush(extractPushData(r.notification), true))
    .catch(() => {});
  void ensureAlarmChannel();
  return () => { received.remove(); responded.remove(); };
}
