# Interface contracts (all agents code against these)

## 1. Rust FFI (uniffi proc-macros, crate `safety-ffi`, namespace `safety`)

Generated bindings expose module `safety` (Swift: `import safety`; Kotlin: `uniffi.safety.*`).

### engine.rs (owned by detection work; thin mirror of `safety_core::Engine`)
```rust
#[derive(uniffi::Record)] pub struct MotionSample { pub t_ms: u64, pub ax: f32, pub ay: f32, pub az: f32, pub gx: f32, pub gy: f32, pub gz: f32 }
// ax..az = user acceleration (g, gravity removed) in device frame; gx..gz = gravity unit vector in device frame. 50 Hz.
#[derive(uniffi::Enum)] pub enum Activity { Unknown, Stationary, Walking, Running, Vehicle }
#[derive(uniffi::Enum)] pub enum Placement { Unknown, Pocket, Hand, Bag }
#[derive(uniffi::Record)] pub struct Context { pub t_ms: u64, pub away_from_home: bool, pub separated: bool, pub hour_local: u8, pub screen_on: bool, pub activity: Activity, pub battery_pct: u8, pub speed_mps: f32 /* -1 = unknown */ }
#[derive(uniffi::Record)] pub struct AudioScores { pub t_ms: u64, pub scream: f32, pub shout: f32, pub glass: f32 } // raw YAMNet probs; engine does background subtraction
#[derive(uniffi::Record)] pub struct TypingSample { pub phrase: String, pub typed: String, pub key_times_ms: Vec<u64>, pub backspaces: u32, pub duration_ms: u64 }
#[derive(uniffi::Record)] pub struct TypingVerdict { pub accepted: bool, pub z_score: f32, pub reason: String }
#[derive(uniffi::Enum)] pub enum UserAction { DismissOk, DismissWrongPhrase, NeedHelp, ManualSos, BiometricDismiss, FriendMarkedSafe, CheckTimeout }
#[derive(uniffi::Enum)] pub enum HmmState { Normal, Impaired, Incident, Unresponsive }
#[derive(uniffi::Enum)] pub enum EscalationLevel { Idle, Check, HeadsUp, Unlocked, Snatch, Resolved }
#[derive(uniffi::Record)] pub struct Snapshot { pub p_danger: f32, pub hmm_state: HmmState, pub escalation: EscalationLevel, pub risk_band: u8 /*0..3*/, pub evidence: String, pub baseline_seconds: u32, pub placement: Placement, pub night_mode: bool }
#[derive(uniffi::Enum)] pub enum EngineEvent {
  CheckRequested { phrase: String, deadline_ms: u64 },
  HeadsUp { summary: String },
  UnlockLocation { summary: String },
  SnatchDetected { summary: String },
  Resolved,
  RiskBandChanged { band: u8 },
  BatteryDying,
  LocationIntervalChanged { seconds: u32 },
}
#[derive(Debug, thiserror::Error, uniffi::Error)] pub enum EngineError { #[error("config: {msg}")] Config { msg: String }, #[error("baseline: {msg}")] Baseline { msg: String } }

#[derive(uniffi::Object)] pub struct SafetyEngine { /* Mutex<safety_core::Engine> */ }
#[uniffi::export] impl SafetyEngine {
  #[uniffi::constructor] pub fn new(config_toml: String, baseline_blob: Option<Vec<u8>>, now_ms: u64) -> Result<Arc<Self>, EngineError>;
  pub fn push_motion(&self, samples: Vec<MotionSample>);
  pub fn push_context(&self, ctx: Context);
  pub fn push_audio(&self, s: AudioScores);
  pub fn push_typing(&self, s: TypingSample, now_ms: u64) -> TypingVerdict;
  pub fn push_action(&self, a: UserAction, now_ms: u64);
  pub fn set_night_mode(&self, active: bool, now_ms: u64);
  pub fn set_learning(&self, enabled: bool);          // opportunistic baseline learning on/off
  pub fn tick(&self, now_ms: u64) -> Vec<EngineEvent>; // call every ~1 s in night mode; HMM step runs internally once/min + on impact
  pub fn snapshot(&self) -> Snapshot;
  pub fn export_baseline(&self) -> Vec<u8>;            // opaque, store encrypted on device
}
```
`safety_core::Engine` has the identical method set with plain Rust types of the same names (no uniffi derives). `tick` drives everything; motion/context/audio pushes only buffer.

### crypto.rs (owned by crypto work; thin mirror of `safety_crypto`)
```rust
#[derive(uniffi::Record)] pub struct Identity { pub x25519_secret: Vec<u8>, pub x25519_public: Vec<u8>, pub ed25519_secret: Vec<u8>, pub ed25519_public: Vec<u8> }
#[derive(uniffi::Record)] pub struct Share { pub index: u8, pub data: Vec<u8> }
#[derive(uniffi::Record)] pub struct Location { pub lat: f64, pub lng: f64, pub accuracy_m: f32, pub t_ms: u64 }
#[derive(Debug, thiserror::Error, uniffi::Error)] pub enum CryptoError { #[error("{msg}")] Failed { msg: String } }

#[uniffi::export] fn generate_identity() -> Identity;
#[uniffi::export] fn fingerprint(user_id: String, x25519_public: Vec<u8>, ed25519_public: Vec<u8>) -> String; // "ab12-cd34-..." 8 groups
#[uniffi::export] fn new_day_key() -> Vec<u8>;                                   // 32 random bytes
#[uniffi::export] fn derive_hour_key(day_key: Vec<u8>, hour_index: u32) -> Vec<u8>; // HKDF-SHA256, info = "safe/hour/{hour_index}"
#[uniffi::export] fn split_day_key(day_key: Vec<u8>, k: u8, n: u8) -> Result<Vec<Share>, CryptoError>; // Shamir GF(256)
#[uniffi::export] fn combine_shares(shares: Vec<Share>) -> Result<Vec<u8>, CryptoError>;
#[uniffi::export] fn seal_to(recipient_x25519_public: Vec<u8>, sender_ed25519_secret: Vec<u8>, plaintext: Vec<u8>, aad: Vec<u8>) -> Result<Vec<u8>, CryptoError>; // HPKE base (X25519-HKDF-SHA256, ChaCha20Poly1305) + Ed25519 sig appended
#[uniffi::export] fn open_sealed(recipient_x25519_secret: Vec<u8>, sender_ed25519_public: Vec<u8>, sealed: Vec<u8>, aad: Vec<u8>) -> Result<Vec<u8>, CryptoError>;
#[uniffi::export] fn encrypt_location(hour_key: Vec<u8>, user_id: String, epoch_id: String, seq: u64, loc: Location) -> Result<Vec<u8>, CryptoError>; // XChaCha20-Poly1305, AAD = "{user_id}|{epoch_id}|{seq}"
#[uniffi::export] fn decrypt_location(hour_key: Vec<u8>, user_id: String, epoch_id: String, seq: u64, blob: Vec<u8>) -> Result<Location, CryptoError>;
#[uniffi::export] fn proximity_tokens(group_epoch_key: Vec<u8>, lat: f64, lng: f64) -> Vec<Vec<u8>>; // 9 tokens: HMAC-SHA256(key, geohash7)[..16] for cell + 8 neighbors
#[uniffi::export] fn proximity_match(a: Vec<Vec<u8>>, b: Vec<Vec<u8>>) -> bool;
```
All byte values cross JS/native boundaries as **base64** strings.

## 2. Expo native module `SafetyNative` (`apps/mobile/modules/safety-native`)
Module name `SafetyNative`. iOS class `SafetyNativeModule` (Swift, ExpoModulesCore). Android class `expo.modules.safetynative.SafetyNativeModule`.

```ts
export type NightMode = 'auto' | 'on' | 'off' | 'paused_tonight';
export type NightModeStatus = { active: boolean; since?: number; reason: 'away_from_home' | 'manual' | 'window' | 'off' };
export type HmmState = 'normal' | 'impaired' | 'incident' | 'unresponsive';
export type EscalationLevel = 'idle' | 'check' | 'heads_up' | 'unlocked' | 'snatch' | 'resolved';
export type EngineSnapshot = { pDanger: number; hmmState: HmmState; escalation: EscalationLevel; riskBand: 0|1|2|3; evidence: string; baselineSeconds: number; placement: 'unknown'|'pocket'|'hand'|'bag'; nightMode: boolean };
export type PermissionState = 'granted' | 'denied' | 'undetermined';
export type Permissions = { locationAlways: PermissionState; motion: PermissionState; microphone: PermissionState; notifications: PermissionState; batteryUnrestricted?: PermissionState /* android */ };
export type HomePlace = { id: string; label: string; lat: number; lng: number; radiusM: number };
export type Status = { nightMode: NightModeStatus; engine: EngineSnapshot; permissions: Permissions; batteryPct: number; lastHeartbeatMs?: number; serviceRunning: boolean };

// Methods (all Promise-returning)
configure(opts: { supabaseUrl: string; supabaseAnonKey: string; accessToken: string; userId: string; deviceId: string; modelConfigToml: string }): Promise<void>;
setAccessToken(token: string): Promise<void>;
requestPermission(kind: keyof Permissions): Promise<PermissionState>;
setHomePlaces(places: HomePlace[]): Promise<void>;                 // device-only storage
setEveningWindow(startHour: number, endHour: number): Promise<void>;
setNightMode(mode: NightMode): Promise<void>;
getStatus(): Promise<Status>;
submitCheckIn(r: { phrase: string; typed: string; keyTimesMs: number[]; backspaces: number; durationMs: number }): Promise<{ accepted: boolean; zScore: number; reason: string }>;
needHelp(): Promise<void>;                                          // from the check-in screen; consent → straight to unlock
triggerSos(): Promise<void>;
cancelSos(): Promise<boolean>;                                      // native biometric prompt; false if it failed
startBaselineWalk(): Promise<void>;
stopBaselineWalk(): Promise<{ seconds: number }>;
recordTypingPractice(r: { phrase: string; typed: string; keyTimesMs: number[]; backspaces: number; durationMs: number }): Promise<void>;
getIdentity(): Promise<{ userId: string; x25519Pub: string; ed25519Pub: string; fingerprint: string }>;   // base64 keys
setGroup(g: { groupId: string; thresholdK: number; members: { userId: string; deviceId: string; x25519Pub: string; ed25519Pub: string }[] }): Promise<void>; // triggers day-key rotation + share upload
// Friend side
openReleasedKey(r: { subjectUserId: string; epochId: string; hourIndex: number; sealedB64: string; senderEd25519Pub: string }): Promise<void>;
decryptLocations(subjectUserId: string, blobs: { epochId: string; seq: number; hourIndex: number; ciphertextB64: string }[]): Promise<{ lat: number; lng: number; accuracyM: number; tMs: number }[]>;
approveUnlock(r: { requestId: string; subjectUserId: string; epochId: string; requesterX25519Pub: string }): Promise<{ sealedShareB64: string }>;
recoverFromShares(r: { subjectUserId: string; epochId: string; sealedShares: { sealedB64: string; approverEd25519Pub: string }[] }): Promise<{ ok: boolean }>;  // caches K_day for subject/epoch
ringAlarm(seconds: number): Promise<void>;   // when a friend remotely rings this phone (push → native)
stopAlarm(): Promise<void>;
injectTrace(json: string): Promise<void>;    // debug builds only; replays MotionSample[]/Context[] at wall-clock speed or faster
// Events via addListener(name, cb)
'statusChanged': Status
'checkRequested': { phrase: string; deadlineMs: number }
'escalation': { level: EscalationLevel; summary: string }
'snatch': { summary: string; lat?: number; lng?: number }
'sos': { active: boolean }
```
Native owns: sensing, night-mode controller, heartbeats, location blob upload, proximity token upload, key rotation + share upload, released_keys posting on unlock, notifications/alarm, check-in notification. **Native talks to Supabase directly over PostgREST** (`{supabaseUrl}/rest/v1/{table}`, headers `apikey`, `Authorization: Bearer {accessToken}`, `Prefer: resolution=merge-duplicates` for upserts).

## 3. Supabase tables (minimum columns; all `id uuid default gen_random_uuid()`, `created_at timestamptz default now()`)
- `profiles(id uuid pk = auth.users.id, display_name text, phone text)`
- `devices(id uuid pk, user_id uuid, platform text check in ('ios','android'), push_token text, push_kind text ('apns'|'fcm'), x25519_pub text, ed25519_pub text, last_heartbeat timestamptz, night_mode bool default false, battery_pct int, risk_band int default 0, status_level text default 'idle')`
- `groups(id, name text, owner_id uuid, threshold_k int default 2, campus_safety_number text)`
- `group_members(group_id, user_id, status text check in ('invited','active'), invited_by uuid, primary key(group_id,user_id))`
- `epochs(id uuid pk, user_id uuid, group_id uuid, day date, k int, n int, active bool default true)`
- `key_shares(id, epoch_id uuid, recipient_user_id uuid, share_index int, sealed text /*b64*/, sender_ed25519_pub text)`
- `location_blobs(id, user_id uuid, epoch_id uuid, hour_index int, seq bigint, ciphertext text /*b64*/, created_at)` — purge >6h
- `proximity_tokens(id, user_id uuid, group_id uuid, tokens text[] /*b64*/, created_at)`
- `presence(group_id uuid, user_id uuid, together bool, updated_at timestamptz, primary key(group_id,user_id))`
- `incidents(id, user_id uuid, group_id uuid, level text check in ('check','heads_up','unlocked','snatch','offline','battery_dying','sos','resolved'), summary text, opened_at timestamptz default now(), resolved_at timestamptz)`
- `incident_events(id, incident_id uuid, actor_id uuid, kind text check in ('nudge','heads_up','release','ring','en_route','called_911','called_campus','found','resolved','unlock_requested','unlock_approved','phone_offline','battery_dying'), payload jsonb, created_at)`
- `released_keys(id, incident_id uuid, subject_user_id uuid, recipient_user_id uuid, epoch_id uuid, hour_index int, sealed text, sender_ed25519_pub text)`
- `unlock_requests(id, incident_id uuid, requester_id uuid, epoch_id uuid, status text check in ('open','fulfilled','denied'))`
- `unlock_approvals(id, request_id uuid, approver_id uuid, sealed_share text, approver_ed25519_pub text)`
- `audit_log(id, subject_user_id uuid, actor_id uuid, kind text, payload jsonb, created_at)`
- `model_configs(version text pk, toml text, signature text, created_at)`

Heartbeat = device `PATCH devices set last_heartbeat=now(), night_mode, battery_pct, risk_band, status_level` every 2 min in night mode.

Edge functions (Deno, `supabase/functions/<name>/index.ts`): `push`, `watchdog`, `proximity`, `unlock`, `purge`, `config`. Client (native or app) calls `POST {supabaseUrl}/functions/v1/push` with `{ incidentId, kind, title, body, recipients?: userId[], critical?: boolean, data?: {} }`.

## 4. Repo ownership (no cross-writes)
| Path | Owner |
|---|---|
| core/crates/safety-core, core/crates/sim, core/config, core/crates/safety-ffi/src/engine.rs | detection agent |
| core/crates/safety-crypto, core/crates/safety-ffi/src/crypto.rs | crypto agent |
| supabase/ | backend agent |
| apps/mobile/** except modules/safety-native/{ios,android} | app agent |
| apps/mobile/modules/safety-native/ios | iOS agent |
| apps/mobile/modules/safety-native/android | Android agent |
| README.md, docs/ (except this file), .github/, e2e/, tools/, core/build-mobile.sh | docs/CI agent |

## 5. Cross-platform escrow conventions (iOS and Android MUST match; friends on different platforms decrypt each other's data)
- `hour_index` (u32) = `floor(unix_ms / 3_600_000)` — UTC-absolute hour number, NOT local hour of day. Used for `derive_hour_key`, `location_blobs.hour_index`, `released_keys.hour_index`.
- `epoch_id` = the `epochs.id` uuid string (lowercase).
- `key_shares.sealed` = `seal_to(recipient_x25519_pub, my_ed25519_secret, share.data, aad)` with `aad = "share|{epochId}|{recipientUserId}"`; `share_index` column carries the Shamir index.
- `released_keys.sealed` = `seal_to(recipient_pub, my_ed25519_secret, hour_key, aad)` with `aad = "hour|{epochId}|{hourIndex}"`. Release current and next hour as two rows.
- `unlock_approvals.sealed_share` = `seal_to(requester_pub, approver_ed25519_secret, [share_index as u8] ++ share.data, aad)` with `aad = "approval|{subjectUserId}|{epochId}"`.
- `location_blobs.seq` = upload wall-clock unix ms (monotonic enough); AAD inside `encrypt_location` is `"{user_id}|{epoch_id}|{seq}"` as in §1.
- Group proximity key (v1, accepted weakness: server can brute-force cells) = `SHA-256("safe/proximity|{groupId}|{YYYY-MM-DD UTC}")`.
- Shamir parameters: n = active members excluding self; k = clamp(max(2, groups.threshold_k), 2, n); n < 2 → no shares, fallback unlock disabled.
- Heartbeat = `PATCH /rest/v1/devices?id=eq.{deviceId}` with `{last_heartbeat: now, night_mode, battery_pct, risk_band, status_level}` (the `heartbeat` RPC is an equivalent alternative).
- `incidents` row is first created at `heads_up` (first friend-visible level); `check` is device-local only.
