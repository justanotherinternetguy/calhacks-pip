import { create } from 'zustand';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { Session } from '@supabase/supabase-js';
import type { Status } from '@/modules/safety-native';
import type { Group, GroupMember, Incident, IncidentEvent, Presence, Profile, Uuid } from './types';

export type PendingCheck = { phrase: string; deadlineMs: number } | null;
export type SnatchAlert = { summary: string; lat?: number; lng?: number; atMs: number } | null;
/** §6: the engine said 10 min passed with no response — friends get the one-tap call option. */
export type CallOption = { summary: string; atMs: number } | null;

type State = {
  session: Session | null;
  profile: Profile | null;
  onboarded: boolean;
  status: Status | null;
  pendingCheck: PendingCheck;
  snatch: SnatchAlert;
  sosActive: boolean;
  groups: Group[];
  members: GroupMember[];
  presence: Record<Uuid, Presence[]>;
  profiles: Record<Uuid, Profile>;
  incidents: Incident[];
  events: Record<Uuid, IncidentEvent[]>;
  // §6 call option (native 'callOption'); personal dashboard preference
  callOption: CallOption;
  dashboardEnabled: boolean;
  set: (patch: Partial<State>) => void;
  upsertIncident: (i: Incident) => void;
  addEvent: (e: IncidentEvent) => void;
  reset: () => void;
};

const initial = {
  session: null, profile: null, onboarded: false, status: null, pendingCheck: null, snatch: null, sosActive: false,
  groups: [], members: [], presence: {}, profiles: {}, incidents: [], events: {},
  callOption: null, dashboardEnabled: false,
};

/**
 * Stable fallback for selectors: zustand v5 compares selector results with Object.is, so `s.events[id] ?? []`
 * would return a fresh array every render and loop ("Maximum update depth exceeded") until the first event arrives.
 */
export const NO_EVENTS: readonly IncidentEvent[] = [];

export const useStore = create<State>((set) => ({
  ...initial,
  set: (patch) => set(patch),
  upsertIncident: (i) =>
    set((s) => ({ incidents: [i, ...s.incidents.filter((x) => x.id !== i.id)].sort((a, b) => b.opened_at.localeCompare(a.opened_at)) })),
  addEvent: (e) =>
    set((s) => {
      const list = s.events[e.incident_id] ?? [];
      if (list.some((x) => x.id === e.id)) return s;
      return { events: { ...s.events, [e.incident_id]: [...list, e].sort((a, b) => a.created_at.localeCompare(b.created_at)) } };
    }),
  // dashboardEnabled is a device preference, not session state: keep it across sign-out.
  reset: () => set((s) => ({ ...initial, dashboardEnabled: s.dashboardEnabled })),
}));

export const useUserId = () => useStore((s) => s.session?.user.id ?? null);
export const activeIncidents = (incidents: Incident[]) => incidents.filter((i) => !i.resolved_at && i.level !== 'resolved');

// ---- §6 personal dashboard preference (off by default; SecureStore on device, localStorage on web)
export const DASHBOARD_KEY = 'safe.dashboardEnabled';
export async function readDashboardEnabled(): Promise<boolean> {
  try {
    const v = Platform.OS === 'web' ? globalThis.localStorage?.getItem(DASHBOARD_KEY) : await SecureStore.getItemAsync(DASHBOARD_KEY);
    return v === '1';
  } catch { return false; }
}
export async function writeDashboardEnabled(on: boolean) {
  useStore.getState().set({ dashboardEnabled: on });
  try {
    if (Platform.OS === 'web') globalThis.localStorage?.setItem(DASHBOARD_KEY, on ? '1' : '0');
    else await SecureStore.setItemAsync(DASHBOARD_KEY, on ? '1' : '0');
  } catch (e) { console.warn('dashboardEnabled persist failed', e); }
}
/** Fallback unlock (§6 Groups): a group needs at least this many active members before k friends can rebuild a day key. */
export const MIN_MEMBERS_FOR_FALLBACK = 3;
export const DEFAULT_THRESHOLD_K = 2;
