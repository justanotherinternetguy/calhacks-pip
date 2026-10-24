// Wires SafetyNative <-> Supabase session <-> store. No detection logic here.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import type { Session } from '@supabase/supabase-js';
import { SafetyNative } from '@/modules/safety-native';
import { supabase } from './supabase';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './env';
import { fn, listMyGroups, getDevicesForUsers, getProfiles, getPresence, listIncidents, subscribe, upsertDevice, rpc } from './db';
import { useStore } from './store';
import type { Incident, IncidentEvent, Presence } from './types';

let configuredFor: string | null = null;
let subs: { remove(): void }[] = [];
let channels: { unsubscribe(): unknown }[] = [];

async function deviceId(): Promise<string> {
  if (Platform.OS === 'web') {
    let id = globalThis.localStorage?.getItem('safe.deviceId');
    if (!id) { id = crypto.randomUUID(); globalThis.localStorage?.setItem('safe.deviceId', id); }
    return id;
  }
  let id = await SecureStore.getItemAsync('safe.deviceId');
  if (!id) { id = crypto.randomUUID(); await SecureStore.setItemAsync('safe.deviceId', id); }
  return id;
}

async function modelConfigToml(): Promise<string> {
  try { return (await fn.config()).toml; } catch {}
  try {
    const { data } = await supabase.from('model_configs').select('toml').order('created_at', { ascending: false }).limit(1).maybeSingle();
    return data?.toml ?? '';
  } catch { return ''; }
}

/** Called on every auth state change. Configures native once per user, refreshes the token afterwards. */
export async function onAuthSession(session: Session | null) {
  const store = useStore.getState();
  store.set({ session });
  if (!session) { configuredFor = null; teardown(); store.reset(); return; }

  if (configuredFor === session.user.id) {
    await SafetyNative.setAccessToken(session.access_token);
    return;
  }
  configuredFor = session.user.id;
  const devId = await deviceId();
  await SafetyNative.configure({
    supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY, accessToken: session.access_token,
    userId: session.user.id, deviceId: devId, modelConfigToml: await modelConfigToml(),
  });
  try {
    const id = await SafetyNative.getIdentity();
    await upsertDevice({
      id: devId, user_id: session.user.id, platform: Platform.OS === 'ios' ? 'ios' : 'android',
      x25519_pub: id.x25519Pub, ed25519_pub: id.ed25519Pub,
    });
  } catch (e) { console.warn('device upsert failed', e); }
  wireEvents();
  await refreshAll();
  wireRealtime(session.user.id);
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
      if (e.level === 'resolved' || e.level === 'idle') s({ pendingCheck: null });
      void refreshIncidents();
    }),
    SafetyNative.addListener('sos', (e) => s({ sosActive: e.active })),
    SafetyNative.addListener('snatch', () => void refreshIncidents()),
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
  await supabase.auth.signOut();
}
