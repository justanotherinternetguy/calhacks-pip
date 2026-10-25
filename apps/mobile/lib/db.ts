// Typed helpers for every table + RPC. RPC names/args follow supabase/migrations (backend agent);
// arg names are prefixed p_ by convention — adjust here if the migration differs.
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { SUPABASE_URL } from './env';
import type {
  AuditLog, Device, Group, GroupMember, Incident, IncidentEvent, IncidentEventKind, IncidentLevel, LocationBlob,
  Presence, Profile, ReleasedKey, TableName, Tables, UnlockApproval, UnlockRequest, Uuid,
} from './types';

function unwrap<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

// ---- generic
export const from = <T extends TableName>(t: T) => supabase.from(t);

export async function selectAll<T extends TableName>(t: T, filter?: (q: any) => any): Promise<Tables[T][]> {
  let q: any = supabase.from(t).select('*');
  if (filter) q = filter(q);
  return unwrap<Tables[T][]>(await q);
}

// ---- profiles / devices
export const getMyProfile = async (userId: Uuid) => unwrap<Profile | null>(await supabase.from('profiles').select('*').eq('id', userId).maybeSingle());
export const upsertProfile = async (p: Partial<Profile> & { id: Uuid }) => unwrap<Profile>(await supabase.from('profiles').upsert(p).select().single());
export const getProfiles = async (ids: Uuid[]) => (ids.length ? unwrap<Profile[]>(await supabase.from('profiles').select('*').in('id', ids)) : []);

export async function upsertDevice(d: Partial<Device> & { id: Uuid; user_id: Uuid; platform: Device['platform'] }) {
  return unwrap<Device>(await supabase.from('devices').upsert(d).select().single());
}
/** Public keys of group-mates' devices. RLS lets a user read only their own `devices` row, so this goes through the
 *  `device_status` view (0002_rls.sql), which exposes keys + coarse status for anyone sharing a group. */
export type DeviceKeys = Pick<Device, 'id' | 'user_id' | 'x25519_pub' | 'ed25519_pub'>;
export const getDevicesForUsers = async (ids: Uuid[]): Promise<DeviceKeys[]> =>
  ids.length
    ? unwrap<{ device_id: Uuid; user_id: Uuid; x25519_pub: string | null; ed25519_pub: string | null }[]>(
        await supabase.from('device_status').select('device_id, user_id, x25519_pub, ed25519_pub').in('user_id', ids),
      ).map((d) => ({ id: d.device_id, user_id: d.user_id, x25519_pub: d.x25519_pub, ed25519_pub: d.ed25519_pub }))
    : [];

/** Which of these users have a phone registered (and so real sensors), from the same `device_status` view. */
export const getDevicePlatforms = async (ids: Uuid[]): Promise<{ user_id: Uuid; platform: Device['platform']; last_heartbeat: string | null }[]> =>
  ids.length ? unwrap(await supabase.from('device_status').select('user_id, platform, last_heartbeat').in('user_id', ids)) : [];

// ---- groups
export async function listMyGroups(userId: Uuid) {
  const memberships = unwrap<GroupMember[]>(await supabase.from('group_members').select('*').eq('user_id', userId));
  const ids = memberships.map((m) => m.group_id);
  const groups = ids.length ? unwrap<Group[]>(await supabase.from('groups').select('*').in('id', ids)) : [];
  const members = ids.length ? unwrap<GroupMember[]>(await supabase.from('group_members').select('*').in('group_id', ids)) : [];
  return { memberships, groups, members };
}
export async function createGroup(g: { name: string; owner_id: Uuid; threshold_k?: number; campus_safety_number?: string | null }) {
  const group = unwrap<Group>(await supabase.from('groups').insert(g).select().single());
  await supabase.from('group_members').insert({ group_id: group.id, user_id: g.owner_id, status: 'active', invited_by: g.owner_id });
  return group;
}
export const updateGroup = async (id: Uuid, patch: Partial<Group>) => unwrap<Group>(await supabase.from('groups').update(patch).eq('id', id).select().single());
export const inviteMember = async (group_id: Uuid, user_id: Uuid, invited_by: Uuid) =>
  unwrap<GroupMember>(await supabase.from('group_members').upsert({ group_id, user_id, status: 'invited', invited_by }).select().single());
export const leaveGroup = async (group_id: Uuid, user_id: Uuid) => unwrap(await supabase.from('group_members').delete().match({ group_id, user_id }));
export const getPresence = async (group_id: Uuid) => unwrap<Presence[]>(await supabase.from('presence').select('*').eq('group_id', group_id));

// ---- incidents
export async function listIncidents(groupIds: Uuid[], userId: Uuid) {
  if (!groupIds.length) return unwrap<Incident[]>(await supabase.from('incidents').select('*').eq('user_id', userId).order('opened_at', { ascending: false }));
  return unwrap<Incident[]>(await supabase.from('incidents').select('*').in('group_id', groupIds).order('opened_at', { ascending: false }).limit(100));
}
export const getIncident = async (id: Uuid) => unwrap<Incident>(await supabase.from('incidents').select('*').eq('id', id).single());
export const listIncidentEvents = async (incident_id: Uuid) =>
  unwrap<IncidentEvent[]>(await supabase.from('incident_events').select('*').eq('incident_id', incident_id).order('created_at'));
export const listAuditLog = async (subject_user_id: Uuid) =>
  unwrap<AuditLog[]>(await supabase.from('audit_log').select('*').eq('subject_user_id', subject_user_id).order('created_at', { ascending: false }).limit(100));

// ---- escrow tables (friend side)
export const listReleasedKeysForMe = async (incident_id: Uuid, recipient_user_id: Uuid) =>
  unwrap<ReleasedKey[]>(await supabase.from('released_keys').select('*').match({ incident_id, recipient_user_id }));
export const listLocationBlobs = async (user_id: Uuid, epoch_id: Uuid) =>
  unwrap<LocationBlob[]>(await supabase.from('location_blobs').select('*').match({ user_id, epoch_id }).order('seq'));
export const getActiveEpoch = async (user_id: Uuid, group_id: Uuid) =>
  unwrap<{ id: Uuid; k: number; n: number } | null>(await supabase.from('epochs').select('id,k,n').match({ user_id, group_id, active: true }).order('created_at', { ascending: false }).limit(1).maybeSingle());
export const listUnlockRequests = async (incident_id: Uuid) => unwrap<UnlockRequest[]>(await supabase.from('unlock_requests').select('*').eq('incident_id', incident_id));
export const getUnlockRequest = async (id: Uuid) => unwrap<UnlockRequest>(await supabase.from('unlock_requests').select('*').eq('id', id).single());
export const listUnlockApprovals = async (request_id: Uuid) => unwrap<UnlockApproval[]>(await supabase.from('unlock_approvals').select('*').eq('request_id', request_id));
export const insertUnlockApproval = async (a: Omit<UnlockApproval, 'id' | 'created_at'>) => unwrap<UnlockApproval>(await supabase.from('unlock_approvals').insert(a).select().single());

// ---- RPCs
export const rpc = {
  heartbeat: (a: { night_mode: boolean; battery_pct: number; status_level: string }) => supabase.rpc('heartbeat', a),
  openIncident: async (a: { group_id: Uuid; level: IncidentLevel; summary: string }) => unwrap<Uuid>(await supabase.rpc('open_incident', a)),
  resolveIncident: async (incident_id: Uuid) => unwrap(await supabase.rpc('resolve_incident', { incident_id })),
  addIncidentEvent: async (a: { incident_id: Uuid; kind: IncidentEventKind; payload?: Record<string, unknown> }) =>
    unwrap<Uuid>(await supabase.rpc('add_incident_event', { payload: {}, ...a })),
  acceptInvite: async (group_id: Uuid) => unwrap(await supabase.rpc('accept_invite', { group_id })),
  openUnlockRequest: async (incident_id: Uuid) => unwrap<Uuid>(await supabase.rpc('open_unlock_request', { incident_id })),
};

// ---- edge functions
/** `body` undefined = GET (the `config` function only answers GET). */
async function callFn(name: string, body?: unknown) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, body === undefined
    ? { method: 'GET', headers: { Authorization: `Bearer ${data.session?.access_token ?? ''}` } }
    : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` },
      body: JSON.stringify(body),
    });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
}
export const fn = {
  push: (b: { incidentId: Uuid; kind: string; title: string; body: string; recipients?: Uuid[]; critical?: boolean; data?: Record<string, unknown> }) => callFn('push', b),
  unlock: (b: { incidentId: Uuid }) => callFn('unlock', b) as Promise<{ requestId: Uuid; k?: number }>,
  config: () => callFn('config') as Promise<{ version: string; toml: string }>,
};

// ---- realtime
export function subscribe<T extends TableName>(
  table: T,
  filter: string | undefined,
  cb: (row: Tables[T], event: 'INSERT' | 'UPDATE' | 'DELETE') => void,
): RealtimeChannel {
  return supabase
    .channel(`rt:${table}:${filter ?? '*'}:${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table, filter }, (p) => {
      const row = (p.eventType === 'DELETE' ? p.old : p.new) as Tables[T];
      cb(row, p.eventType as 'INSERT' | 'UPDATE' | 'DELETE');
    })
    .subscribe();
}
