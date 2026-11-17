// Typed helpers for every table + RPC. RPC names/args follow supabase/migrations (backend agent);
// arg names are prefixed p_ by convention — adjust here if the migration differs.
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { SUPABASE_URL } from './env';
import type {
  AuditLog, CheckIn, Device, Group, GroupMember, Incident, IncidentEvent, IncidentEventKind, IncidentLevel, LiveKey, LocationBlob,
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
  // Oldest membership first: native runs escrow on the first group (EscrowManager.setGroups).
  const memberships = unwrap<GroupMember[]>(await supabase.from('group_members').select('*').eq('user_id', userId).order('created_at'));
  const ids = memberships.map((m) => m.group_id);
  const fetched = ids.length ? unwrap<Group[]>(await supabase.from('groups').select('*').in('id', ids)) : [];
  const groups = ids.map((id) => fetched.find((g) => g.id === id)).filter((g): g is Group => !!g);
  const members = ids.length ? unwrap<GroupMember[]>(await supabase.from('group_members').select('*').in('group_id', ids)) : [];
  return { memberships, groups, members };
}
export async function createGroup(g: { name: string; owner_id: Uuid; threshold_k?: number; campus_safety_number?: string | null }) {
  // The owner's own membership row comes from the groups_add_owner trigger (0002).
  return unwrap<Group>(await supabase.from('groups').insert(g).select().single());
}
export const updateGroup = async (id: Uuid, patch: Partial<Group>) => unwrap<Group>(await supabase.from('groups').update(patch).eq('id', id).select().single());
/** Leaving as the owner hands the group to the longest-standing member (leave_group, 0019). */
export const leaveGroup = async (group_id: Uuid) => unwrap(await supabase.rpc('leave_group', { p_group: group_id }));
/** The owner removes anyone; the inviter may undo their own invite for an hour (fingerprint did not match). */
export const removeMember = async (group_id: Uuid, user_id: Uuid) => unwrap(await supabase.rpc('remove_member', { p_group: group_id, p_user: user_id }));
/** A single-use, 10-minute invite token for the QR (only its hash is stored). Any active member may invite. */
export async function createInvite(group_id: Uuid): Promise<{ inviteId: Uuid; token: string; expiresAt: string }> {
  const rows = unwrap<{ invite_id: Uuid; token: string; expires_at: string }[]>(await supabase.rpc('create_group_invite', { p_group: group_id }));
  const r = rows[0];
  if (!r) throw new Error('Could not create an invite');
  return { inviteId: r.invite_id, token: r.token, expiresAt: r.expires_at };
}
/** Joins the group behind a scanned invite token; returns its id. */
export const redeemInvite = async (token: string) => unwrap<Uuid>(await supabase.rpc('redeem_group_invite', { p_token: token }));
export const getInvite = async (id: Uuid) =>
  unwrap<{ id: Uuid; used_by: Uuid | null; used_at: string | null; expires_at: string } | null>(
    await supabase.from('group_invites').select('id, used_by, used_at, expires_at').eq('id', id).maybeSingle());
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
/** A phone keeps one active escrow epoch (on its primary group), whichever group the incident is in. */
export const getActiveEpoch = async (user_id: Uuid) =>
  unwrap<{ id: Uuid; k: number; n: number } | null>(await supabase.from('epochs').select('id,k,n').match({ user_id, active: true }).order('created_at', { ascending: false }).limit(1).maybeSingle());
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
  openUnlockRequest: async (incident_id: Uuid) => unwrap<Uuid>(await supabase.rpc('open_unlock_request', { incident_id })),
  /** Deletes the subject's incidents (with their events, unlock requests and released keys) for good; returns how many. */
  purgeIncidents: async (subject: Uuid) => unwrap<number>(await supabase.rpc('purge_incidents', { subject })),
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
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* not JSON */ }
    throw new Error(msg || `${name}: ${res.status}`);
  }
  return res.json().catch(() => ({}));
}
export const fn = {
  push: (b: { incidentId: Uuid; kind: string; title: string; body: string; recipients?: Uuid[]; critical?: boolean; data?: Record<string, unknown> }) => callFn('push', b),
  unlock: (b: { incidentId: Uuid }) => callFn('unlock', b) as Promise<{ requestId: Uuid; k?: number }>,
  config: () => callFn('config') as Promise<{ version: string; toml: string }>,
  /** Friend check-ins (functions/checkin): ask → sticky "You okay?" on their phone; answer → tells the asker. */
  checkin: (b: { action: 'ask'; targetId: Uuid } | { action: 'answer'; checkInId: Uuid; status: 'ok' | 'help' } | { action: 'cancel'; checkInId: Uuid }) =>
    callFn('checkin', b) as Promise<{ checkIn: CheckIn; sent: number }>,
};

// ---- check-ins / live keys
/** Last 24 h of check-ins I can see (mine both ways, and my group-mates'). */
export const listCheckIns = async () =>
  unwrap<CheckIn[]>(await supabase.from('check_ins').select('*').gte('created_at', new Date(Date.now() - 24 * 3_600_000).toISOString())
    .order('created_at', { ascending: false }).limit(200));
export const getCheckIn = async (id: Uuid) => unwrap<CheckIn | null>(await supabase.from('check_ins').select('*').eq('id', id).maybeSingle());
export const listLiveKeysForMe = async (me: Uuid) =>
  unwrap<LiveKey[]>(await supabase.from('live_keys').select('*').eq('recipient_id', me).order('created_at', { ascending: false }).limit(200));

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
