import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import type { Status } from '@/modules/safety-native';
import type { Group, GroupMember, Incident, IncidentEvent, Presence, Profile, Uuid } from './types';

export type PendingCheck = { phrase: string; deadlineMs: number } | null;
export type SnatchAlert = { summary: string; lat?: number; lng?: number; atMs: number } | null;

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
  set: (patch: Partial<State>) => void;
  upsertIncident: (i: Incident) => void;
  addEvent: (e: IncidentEvent) => void;
  reset: () => void;
};

const initial = {
  session: null, profile: null, onboarded: false, status: null, pendingCheck: null, snatch: null, sosActive: false,
  groups: [], members: [], presence: {}, profiles: {}, incidents: [], events: {},
};

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
  reset: () => set(initial),
}));

export const useUserId = () => useStore((s) => s.session?.user.id ?? null);
export const activeIncidents = (incidents: Incident[]) => incidents.filter((i) => !i.resolved_at && i.level !== 'resolved');
