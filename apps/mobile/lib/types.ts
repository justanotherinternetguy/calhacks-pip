// Row types for every table in docs/CONTRACTS.md §3.
export type Uuid = string;
export type Platform = 'ios' | 'android';
export type MemberStatus = 'invited' | 'active';
export type IncidentLevel = 'check' | 'heads_up' | 'unlocked' | 'snatch' | 'offline' | 'battery_dying' | 'sos' | 'resolved';
export type IncidentEventKind =
  | 'nudge' | 'heads_up' | 'release' | 'ring' | 'en_route' | 'called_911' | 'called_campus' | 'found' | 'resolved'
  | 'unlock_requested' | 'unlock_approved' | 'phone_offline' | 'battery_dying';
export type UnlockStatus = 'open' | 'fulfilled' | 'denied';

export type Profile = { id: Uuid; display_name: string | null; phone: string | null; created_at: string };
export type Device = {
  id: Uuid; user_id: Uuid; platform: Platform; push_token: string | null; push_kind: 'apns' | 'fcm' | null;
  x25519_pub: string | null; ed25519_pub: string | null; last_heartbeat: string | null; night_mode: boolean;
  battery_pct: number | null; risk_band: number; status_level: string; created_at: string;
};
export type Group = { id: Uuid; name: string; owner_id: Uuid; threshold_k: number; campus_safety_number: string | null; created_at: string };
export type GroupMember = { group_id: Uuid; user_id: Uuid; status: MemberStatus; invited_by: Uuid | null; created_at: string };
export type Epoch = { id: Uuid; user_id: Uuid; group_id: Uuid; day: string; k: number; n: number; active: boolean; created_at: string };
export type KeyShare = { id: Uuid; epoch_id: Uuid; recipient_user_id: Uuid; share_index: number; sealed: string; sender_ed25519_pub: string; created_at: string };
export type LocationBlob = { id: Uuid; user_id: Uuid; epoch_id: Uuid; hour_index: number; seq: number; ciphertext: string; created_at: string };
export type ProximityToken = { id: Uuid; user_id: Uuid; group_id: Uuid; tokens: string[]; created_at: string };
export type Presence = { group_id: Uuid; user_id: Uuid; together: boolean; updated_at: string };
export type Incident = {
  id: Uuid; user_id: Uuid; group_id: Uuid; level: IncidentLevel; summary: string | null;
  opened_at: string; resolved_at: string | null; created_at: string;
};
export type IncidentEvent = { id: Uuid; incident_id: Uuid; actor_id: Uuid | null; kind: IncidentEventKind; payload: Record<string, unknown> | null; created_at: string };
export type ReleasedKey = {
  id: Uuid; incident_id: Uuid; subject_user_id: Uuid; recipient_user_id: Uuid; epoch_id: Uuid; hour_index: number;
  sealed: string; sender_ed25519_pub: string; created_at: string;
};
export type UnlockRequest = { id: Uuid; incident_id: Uuid; requester_id: Uuid; epoch_id: Uuid; status: UnlockStatus; created_at: string };
export type UnlockApproval = { id: Uuid; request_id: Uuid; approver_id: Uuid; sealed_share: string; approver_ed25519_pub: string; created_at: string };
export type AuditLog = { id: Uuid; subject_user_id: Uuid; actor_id: Uuid | null; kind: string; payload: Record<string, unknown> | null; created_at: string };
export type ModelConfig = { version: string; toml: string; signature: string; created_at: string };

export type Tables = {
  profiles: Profile; devices: Device; groups: Group; group_members: GroupMember; epochs: Epoch; key_shares: KeyShare;
  location_blobs: LocationBlob; proximity_tokens: ProximityToken; presence: Presence; incidents: Incident;
  incident_events: IncidentEvent; released_keys: ReleasedKey; unlock_requests: UnlockRequest; unlock_approvals: UnlockApproval;
  audit_log: AuditLog; model_configs: ModelConfig;
};
export type TableName = keyof Tables;
