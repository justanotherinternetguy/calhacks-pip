// Wires SafetyNative <-> Supabase session <-> store. No detection logic here.
import { uuidv4 } from '@/lib/uuid';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import type { Session } from '@supabase/supabase-js';
import { SafetyNative } from '@/modules/safety-native';
import { jwtExpMs, readStoredSession, supabase } from './supabase';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './env';
import { setDemoFlag } from './demo';
import { registerPushToken, unregisterPushToken } from './push';
import { fn, listMyGroups, getDevicesForUsers, getProfiles, getPresence, listIncidents, subscribe, upsertDevice, rpc } from './db';
import { readDashboardEnabled, useStore } from './store';
import type { Incident, IncidentEvent, Presence } from './types';

let configuredFor: string | null = null;
let dashboardPrefLoaded = false;
let subs: { remove(): void }[] = [];
let channels: { unsubscribe(): unknown }[] = [];

async function deviceId(userId: string): Promise<string> {
  // Per-user key: devices.user_id is unique and RLS only lets a user update their own row, so a device id
  // left behind by a previous (e.g. anonymous) user on this phone must not be reused.
  const key = `safe.deviceId.${userId}`;
  if (Platform.OS === 'web') {
    let id = globalThis.localStorage?.getItem(key);
    if (!id) { id = uuidv4(); globalThis.localStorage?.setItem(key, id); }
    return id;
  }
  let id = await SecureStore.getItemAsync(key);
  if (!id) { id = uuidv4(); await SecureStore.setItemAsync(key, id); }
  return id;
}

async function modelConfigToml(): Promise<string> {
  try { return (await fn.config()).toml; } catch {}
  try {
    const { data } = await supabase.from('model_configs').select('toml').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data?.toml ?? '';
  } catch { return ''; }
}

/** Only a real Supabase session (JWT) is worth refreshing natively; the offline demo session is not. */
const refreshTokenFor = (session: Session) => (jwtExpMs(session.access_token) ? session.refresh_token : undefined);

/**
 * Startup, before `supabase.auth.getSession()`: if native holds a newer JWT pair than the one supabase-js persisted
 * (its SessionKeeper rotated it while JS was asleep), install native's pair. Otherwise supabase-js would try to
 * refresh with a refresh token the server has already rotated and sign the user out.
 */
export async function adoptNativeSession() {
  if (Platform.OS === 'web' || SafetyNative.isMock) return;
  let ns: Awaited<ReturnType<typeof SafetyNative.getSession>> = null;
  try { ns = await SafetyNative.getSession(); } catch { return; }
  if (!ns) return;
  const stored = await readStoredSession();
  if (stored && stored.user && stored.user.id !== ns.userId) return;            // a different account signed in on JS: leave it alone
  if (stored && stored.refresh_token === ns.refreshToken) return;              // in sync
  if (stored && jwtExpMs(stored.access_token) >= jwtExpMs(ns.accessToken)) return; // JS's pair is at least as new
  console.log('native: adopting the session native refreshed while JS was asleep');
  const { error } = await supabase.auth.setSession({ access_token: ns.accessToken, refresh_token: ns.refreshToken });
  if (error) console.warn('adoptNativeSession', error.message);
}

/** Called on every auth state change. Configures native once per user, refreshes the token afterwards. */
export async function onAuthSession(session: Session | null) {
  const store = useStore.getState();
  store.set({ session });
  if (!dashboardPrefLoaded) { dashboardPrefLoaded = true; readDashboardEnabled().then((on) => useStore.getState().set({ dashboardEnabled: on })).catch(() => {}); }
  if (!session) {
    if (configuredFor) await SafetyNative.clearSession().catch(() => {});
    configuredFor = null; unregisterPushToken(); teardown(); store.reset(); return;
  }

  if (configuredFor === session.user.id) {
    const refreshToken = refreshTokenFor(session);
    if (refreshToken) await SafetyNative.setSession({ accessToken: session.access_token, refreshToken });
    else await SafetyNative.setAccessToken(session.access_token);
    return;
  }
  configuredFor = session.user.id;
  console.log(`native: configuring for user ${session.user.id.slice(0, 8)}`);
  const devId = await deviceId(session.user.id);
  await SafetyNative.configure({
    supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY, accessToken: session.access_token, refreshToken: refreshTokenFor(session),
    userId: session.user.id, deviceId: devId, modelConfigToml: await modelConfigToml(),
  });
  try {
    const id = await SafetyNative.getIdentity();
    await upsertDevice({
      id: devId, user_id: session.user.id, platform: Platform.OS === 'ios' ? 'ios' : 'android',
      x25519_pub: id.x25519Pub, ed25519_pub: id.ed25519Pub,
    });
  } catch (e) { console.warn('device upsert failed', e); }
  // Push token (FCM/APNs) onto the same devices row so friends' 'ring' / heads-up pushes reach this phone. Fail-soft.
  void registerPushToken(session.user.id, devId);
  wireEvents();
  try { await refreshAll(); } catch (e) { console.warn('refreshAll failed (offline/demo?)', e); }
  try { wireRealtime(session.user.id); } catch (e) { console.warn('realtime failed', e); }
}

function wireEvents() {
  teardownEvents();
  const s = useStore.getState().set;
  subs = [
    SafetyNative.addListener('statusChanged', (status) => s({ status })),
    SafetyNative.addListener('checkRequested', (c) => {
      s({ pendingCheck: c });
      router.push({ pathname: '/check-in', params: { phrase: c.phrase, deadline: String(c.deadlineMs) } });
    }),
    SafetyNative.addListener('escalation', (e) => {
      // Anything past 'check' closes the check-in modal (the screen watches pendingCheck); resolved clears a snatch too.
      if (e.level !== 'check') s({ pendingCheck: null });
      if (e.level === 'resolved' || e.level === 'idle') s({ snatch: null, callOption: null });
      void refreshIncidents();
    }),
    SafetyNative.addListener('sos', (e) => s({ sosActive: e.active })),
    SafetyNative.addListener('snatch', (e) => {
      s({ snatch: { ...e, atMs: Date.now() }, pendingCheck: null });
      router.push('/snatch');
      void refreshIncidents();
    }),
    // §6 live signals: ring of the last 50 engine records + the call-option flag, for the home tab / dashboard.
    SafetyNative.addListener('signalIncident', (r) => useStore.getState().pushSignal(r)),
    SafetyNative.addListener('callOption', (e) => s({ callOption: { summary: e.summary, atMs: Date.now() } })),
    // Native rotated the JWT pair (SessionKeeper): adopt it, or supabase-js would later refresh with a dead token.
    // setSession fires TOKEN_REFRESHED → onAuthSession → SafetyNative.setSession(same pair), which native ignores.
    SafetyNative.addListener('sessionRefreshed', (ns) => {
      if (ns.userId !== useStore.getState().session?.user.id) return;
      void supabase.auth.setSession({ access_token: ns.accessToken, refresh_token: ns.refreshToken }).then(({ error }) => { if (error) console.warn('sessionRefreshed', error.message); });
    }),
  ];
  SafetyNative.getStatus().then((status) => s({ status })).catch(() => {});
}

export async function refreshAll() {
  const userId = useStore.getState().session?.user.id;
  if (!userId) return;
  try {
    const { groups, members } = await listMyGroups(userId);
    const userIds = [...new Set(members.map((m) => m.user_id))];
    const [profiles, presences] = await Promise.all([getProfiles(userIds), Promise.all(groups.map((g) => getPresence(g.id).catch(() => [] as Presence[])))]);
    useStore.getState().set({
      groups, members,
      profiles: Object.fromEntries(profiles.map((p) => [p.id, p])),
      presence: Object.fromEntries(groups.map((g, i) => [g.id, presences[i]])),
    });
    await pushGroupsToNative(userId);
  } catch (e) { console.warn('refreshAll', e); }
  await refreshIncidents();
}

/** Hands each active group's member keys to native (drives day-key rotation + share upload). */
async function pushGroupsToNative(userId: string) {
  const { groups, members } = useStore.getState();
  for (const g of groups) {
    const active = members.filter((m) => m.group_id === g.id && m.status === 'active' && m.user_id !== userId);
    const devices = await getDevicesForUsers(active.map((m) => m.user_id));
    await SafetyNative.setGroup({
      groupId: g.id, thresholdK: g.threshold_k,
      members: devices.filter((d) => d.x25519_pub && d.ed25519_pub).map((d) => ({ userId: d.user_id, deviceId: d.id, x25519Pub: d.x25519_pub!, ed25519Pub: d.ed25519_pub! })),
    }).catch((e) => console.warn('setGroup', e));
  }
}

export async function refreshIncidents() {
  const { session, groups } = useStore.getState();
  if (!session) return;
  try { useStore.getState().set({ incidents: await listIncidents(groups.map((g) => g.id), session.user.id) }); } catch (e) { console.warn('incidents', e); }
}

function wireRealtime(userId: string) {
  teardownRealtime();
  const st = useStore.getState();
  channels = [
    subscribe('incidents', undefined, (row: Incident) => st.upsertIncident(row)),
    subscribe('incident_events', undefined, (row: IncidentEvent, ev) => ev === 'INSERT' && st.addEvent(row)),
    subscribe('presence', undefined, (row: Presence) =>
      useStore.setState((s) => ({ presence: { ...s.presence, [row.group_id]: [row, ...(s.presence[row.group_id] ?? []).filter((p) => p.user_id !== row.user_id)] } }))),
    subscribe('group_members', `user_id=eq.${userId}`, () => void refreshAll()),
    subscribe('unlock_requests', undefined, (row) => {
      // approver flow: someone asked to unlock a subject's location while their phone is offline
      if (row.requester_id !== userId && row.status === 'open') router.push(`/unlock-approve/${row.id}`);
    }),
  ];
}

function teardownEvents() { subs.forEach((s) => s.remove()); subs = []; }
function teardownRealtime() { channels.forEach((c) => c.unsubscribe()); channels = []; }
function teardown() { teardownEvents(); teardownRealtime(); }

/** Manual SOS from the home button: native does escalation + push; we mirror an incident row for friends' UI. */
export async function sos() {
  await SafetyNative.triggerSos();
  const { groups } = useStore.getState();
  for (const g of groups) {
    try { await rpc.openIncident({ group_id: g.id, level: 'sos', summary: 'Manual SOS' }); } catch (e) { console.warn('openIncident', e); }
  }
}

export async function signOut() {
  await SafetyNative.setNightMode('off').catch(() => {});
  await setDemoFlag(false);
  await supabase.auth.signOut().catch(() => {});
  await onAuthSession(null); // also clears an offline demo session
}
