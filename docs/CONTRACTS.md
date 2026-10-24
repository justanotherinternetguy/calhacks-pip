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
#[derive(uniffi::Record)] pub struct AudioScores { pub t_ms: u64, pub scream: f32, pub shout: f32, pub snore: f32, pub level_db: f32 } // §9: raw YAMNet probs + dB SPL, listening windows only
#[derive(uniffi::Record)] pub struct TypingSample { pub phrase: String, pub typed: String, pub key_times_ms: Vec<u64>, pub backspaces: u32, pub duration_ms: u64 }
#[derive(uniffi::Record)] pub struct TypingVerdict { pub accepted: bool, pub z_score: f32, pub reason: String }
#[derive(uniffi::Enum)] pub enum UserAction { DismissOk, DismissWrongPhrase, NeedHelp, ManualSos, BiometricDismiss, FriendMarkedSafe, CheckTimeout }
#[derive(uniffi::Enum)] pub enum EscalationLevel { Idle, Check, HeadsUp, Unlocked, Snatch, Resolved }
#[derive(uniffi::Record)] pub struct Snapshot { pub escalation: EscalationLevel, pub evidence: String, pub sensing_full: bool, pub listening: bool, pub baseline_seconds: u32, pub placement: Placement, pub night_mode: bool }
#[derive(uniffi::Enum)] pub enum EngineEvent {
  CheckRequested { phrase: String, deadline_ms: u64 },
  HeadsUp { summary: String },
  UnlockLocation { summary: String },
  SnatchDetected { summary: String },
  Resolved,
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
  pub fn tick(&self, now_ms: u64) -> Vec<EngineEvent>; // call every ~1 s in night mode; every incident rule and the escalation run inside
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
export type EscalationLevel = 'idle' | 'check' | 'heads_up' | 'unlocked' | 'snatch' | 'resolved';
export type EngineSnapshot = { escalation: EscalationLevel; evidence: string; sensingFull: boolean; listening: boolean; baselineSeconds: number; placement: 'unknown'|'pocket'|'hand'|'bag'; nightMode: boolean };
export type PermissionState = 'granted' | 'denied' | 'undetermined';
export type Permissions = { locationAlways: PermissionState; motion: PermissionState; microphone: PermissionState; notifications: PermissionState; batteryUnrestricted?: PermissionState /* android */ };
export type HomePlace = { id: string; label: string; lat: number; lng: number; radiusM: number };
export type Status = { nightMode: NightModeStatus; engine: EngineSnapshot; permissions: Permissions; batteryPct: number; lastHeartbeatMs?: number; serviceRunning: boolean };

// Methods (all Promise-returning)
configure(opts: { supabaseUrl: string; supabaseAnonKey: string; accessToken: string; refreshToken?: string; userId: string; deviceId: string; modelConfigToml: string }): Promise<void>;
setAccessToken(token: string): Promise<void>;
// Session hand-off (Android keeps the JWT alive itself, see §8): JS delivers every new pair, adopts native's at startup, clears on sign-out.
setSession(s: { accessToken: string; refreshToken: string }): Promise<void>;   // idempotent
getSession(): Promise<{ accessToken: string; refreshToken: string; userId: string } | null>;
clearSession(): Promise<void>;
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
'sessionRefreshed': { accessToken: string; refreshToken: string; userId: string }   // native rotated the pair; JS calls supabase.auth.setSession
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

Heartbeat = device `PATCH devices set last_heartbeat=now(), night_mode, battery_pct, status_level` every 2 min in night mode.

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
- Shamir parameters: n = active members excluding self; k = clamp(max(2, groups.threshold_k), 2, n); n < 2 → k = 0, no shares, fallback unlock disabled. An epoch row is still created (group_id may be null) so location blobs have an epoch.
- Heartbeat = `PATCH /rest/v1/devices?id=eq.{deviceId}` with `{last_heartbeat: now, night_mode, battery_pct, status_level}` (the `heartbeat` RPC is an equivalent alternative).
- `incidents` row is first created at `heads_up` (first friend-visible level); `check` is device-local only.

## 6. Addendum: live signals, incident log, grab detection (spec v1.1)

### FFI changes (engine.rs; `safety_core` mirrors them)
- `MotionSample` gains `pub rx: f32, pub ry: f32, pub rz: f32` — gyroscope rotation rate in rad/s, device frame; all 0 when the gyro is off (low-rate mode).
- `Context` gains `pub last_touch_ms: u64` (0 = never/unknown; wall-clock ms of the last touch or interactive unlock), `pub distance_home_m: f32` (-1 = unknown), `pub sampling_full: bool` (what native is currently delivering: true = 50 Hz + gyro, false = ~10 Hz accel only).
- `UserAction` gains `PhoneUnlocked` (owner unlocked the device; clears a grab within its 2-minute window).
- `EngineEvent` gains:
  - `SamplingRateChanged { hz: u32, gyro: bool }` — native must reconfigure sensors (10 Hz/no gyro by default; 50 Hz + gyro when away from home 21:00–06:00 or after any incident).
  - `SignalIncident { record: IncidentRecord }` — an incident opened (kinds and rules in §9). Native appends to its own notification/dashboard stream; the engine keeps the log itself.
  - `CallOptionAvailable { summary: String }` — 10 min with no response: friends get the one-tap campus safety / 911 option (native posts `incident_events.kind='call_option'`).
  - `HeadsUp` is now emitted immediately on a grab (no location); `UnlockLocation` follows after 2 min unless `PhoneUnlocked`/`BiometricDismiss`.
- New records/enums:
```rust
// IncidentKind, IncidentTier, LiveMetrics and IncidentRecord were redefined in v2: see §9.
#[derive(uniffi::Record)] pub struct MetricBand { pub name: String, pub value: f32, pub mean: f32, pub sd: f32, pub sd_distance: f32, pub in_band: bool }
```
- New `SafetyEngine` methods: `metrics() -> LiveMetrics`, `incident_log() -> Vec<IncidentRecord>` (newest last; entries expire after 8 h). The incident log is included in the opaque `export_baseline()` blob so it survives restarts (expired entries dropped on load).
- Thresholds: superseded by §9 (config/model-v1.toml `[thresholds]` and `[incidents]`). Bands = baseline mean ± 2.5 SD.
- Baselines: per placement; trusted after 7 days (≥ 7 distinct local days with walking); rolling 14-day window; nights that produced an incident are excluded; population defaults with wider bands (3.5 SD) until trusted.

### Native facade additions (§2)
```ts
getDashboard(): Promise<{ metrics: LiveMetrics; incidents: IncidentRecord[] }>;   // same field names, camelCase
setDashboardStreaming(on: boolean): Promise<void>;   // while on, emit 'dashboard' every 1 s
// Events
'dashboard': { metrics: LiveMetrics; incidents: IncidentRecord[] }
'signalIncident': IncidentRecord
'callOption': { summary: string }
```
Native tracks `last_touch_ms` from: any touch in the app (root view touch listener), screen interactive + USER_PRESENT / protectedDataDidBecomeAvailable, and lock-screen unlock. On `UserAction::PhoneUnlocked` native calls `push_action(PhoneUnlocked)` whenever the device is unlocked by the owner.

### Groups
Default n = 4 friends, k = 2; fallback unlock requires ≥ 3 active members (enforced in `open_unlock_request` and in the UI).

### Display
`/dashboard` (personal, off by default, opened from Settings) shows live metrics vs bands, sensing / mic status and context, and the incident log. Friends get only the one-line triggering-sequence summary on unlock; never another user's dashboard.

## 7. Live telemetry stream (Android → web monitor). iOS is out of scope (module removed).

Transport: Supabase Realtime **broadcast** on a private channel over **one persistent WebSocket**, no DB rows.
- Topic `telemetry:{subjectUserId}`, event `tick`. Private channel (`realtime.messages` RLS: subject may insert; subject + group-mates may select).
- Publisher (Android native, OkHttp WebSocket, Phoenix serializer v2 — the same frames realtime-js sends): connect `wss://{host}/realtime/v1/websocket?apikey={anon}&vsn=2.0.0`, join `realtime:telemetry:{uid}` with `{ config: { broadcast: { self, ack: false }, presence: { enabled: false }, postgres_changes: [], private: true }, access_token }`, heartbeat `phoenix`/`heartbeat` every 25 s, push `access_token` when the JWT rotates, reconnect with 1 / 2 / 5 / 10 s backoff. Each frame is `[join_ref, null, topic, "broadcast", { type: "broadcast", event: "tick", payload }]`. The old `POST /realtime/v1/api/broadcast` path is no longer used (one HTTP round trip per tick).
- Rate: **10 Hz** while telemetry is explicitly enabled (`setTelemetry(true)`, default ON when the app is configured) or the dashboard streams; 1 Hz in night mode otherwise; socket closed when neither. While streaming, native delivers sensors unbatched (`maxReportLatency = 0`) on a dedicated thread and holds a partial wake lock, so the stream survives screen-off and unplugged.
- A frame that lands while the channel is not joined is dropped, never queued. Every (re)join replays the whole live incident log once (the monitor dedups by id).
- Latency probe: at 10 Hz the channel is joined with `self = true`; the phone receives its own frames back and reports the smoothed round trip (phone → Realtime → phone, one clock, no skew) as `rttMs`.
- Subscriber (web): `supabase.channel('telemetry:'+uid, { config: { private: true, broadcast: { ack: false } } }).on('broadcast', { event: 'tick' }, cb).subscribe()`; `lib/telemetryFrames.ts` folds frames into complete ticks.

Payload (`v: 2`), all keys camelCase. Every frame carries the raw samples since the previous frame; `state` is attached after every engine tick, at least once a second, and whenever `events` / `incidents` are non-empty, so a subscriber joining mid-stream is complete within one second:
```ts
type TelemetryFrame = {
  v: 2; t: number /* unix ms, frame build time */; seq: number; user: string;
  accel: number[];                          // |a| in g for the samples since the last frame (≈ 5 at 10 Hz, ≤ 128), newest last
  gyro: number[];                           // |ω| rad/s, same length (zeros in low-rate mode)
  st: number;                               // phone unix ms of the newest sample (0 when the frame carries none)
  sampleHz: number;                         // measured accelerometer delivery rate (e.g. 49.9)
  incidents: IncidentRecord[];              // new records (id > lastSentId) and records whose clearedMs / acknowledged / sequenceId changed — UPSERT by id; the whole live log again after a rejoin
  incidentCount: number;                    // total live log size, lets the UI detect gaps
  events: string[];                         // engine events since the last frame, snake_case: check_requested, heads_up, unlock_location, snatch_detected, resolved, battery_dying, sampling_rate_changed, audio_listening, signal_incident, incident_cleared, call_option
  rttMs?: number;                           // self-echo round trip, smoothed
  state?: {
    metrics: LiveMetrics;                   // §9 shape (bands[], listening, context, placement, samplingFull, evidence, …)
    escalation: EscalationLevel; listening: boolean;   // v2 dropped hmm / pDanger / riskBand (older phones may still send them)
    nightMode: boolean; battery: number; activity: Activity; placement: Placement; samplingFull: boolean;
    checkPhrase?: string; checkDeadlineMs?: number;   // while a check-in is pending
  };
};
```
A `v: 1` payload (one complete tick per message, 4 Hz, as published before this revision) is still accepted by the monitor.

Sample timing: the monitor places every sample on the phone's sensor clock (`st` minus `k / sampleHz`) and maps it to local time with a skew floor (fast-down / slow-up minimum of `arrival − st`), then draws `max(120 ms, 1.5 × frame interval + 2 × jitter)` behind wall-clock. Arrival jitter therefore cannot stretch or compress the waveform.

Native facade: `setTelemetry(on: boolean): Promise<void>`, `getTelemetryStatus(): Promise<{ on: boolean; hz: number; lastSentMs: number; failures: number; connected: boolean; reconnects: number; dropped: number; rttMs: number | null; error: string | null }>`.
Location is NOT in telemetry; it stays on the escrow path (location_blobs + released_keys).

## 8. Session ownership on Android

JS (supabase-js) refreshes the JWT only while it is awake and in the foreground; the native service runs all night and after reboots without JS. So on Android **native keeps the session alive**:
- JS hands the pair over: `configure({ …, refreshToken })` at sign-in and `setSession({ accessToken, refreshToken })` on every `TOKEN_REFRESHED` / `SIGNED_IN`; `clearSession()` on sign-out. Demo / mock sessions (non-JWT access tokens) carry no refresh token and are never refreshed.
- Native (`SessionKeeper`) refreshes 5 min before `exp` via `POST /auth/v1/token?grant_type=refresh_token`, stores the new pair, installs it in the PostgREST client and the telemetry channel (`access_token` push), and emits `sessionRefreshed`; JS answers with `supabase.auth.setSession(pair)`. A refusal (400/401/403: token used, revoked, signed out) parks the keeper until JS delivers a different refresh token.
- At JS startup, before `supabase.auth.getSession()`, `adoptNativeSession()` compares the persisted supabase-js session with `getSession()` and installs native's pair when it is newer (same user) — otherwise supabase-js would refresh with a refresh token the server already rotated and sign the user out.
- Whoever refreshes first wins and the other side adopts; both refreshing within Supabase's reuse interval returns the same new pair.

## 9. v2: rule-based incidents (replaces the HMM and P(danger))

The 4-state HMM, `HmmState`, `P(danger)` and the per-state probabilities are gone. Signals open and clear explicit
incidents; the incident log decides when to ask "You okay?". Parameters: `core/config/model-v1.toml` (header comment,
`[thresholds]`, `[incidents]`); the backend serves them as model config `v2` (migration 0011).

```rust
#[derive(uniffi::Enum)] pub enum IncidentKind {
  PhoneDrop, PossibleFall, FallRecovered, DownAfterFall, HardImpact,      // falls
  UnsteadyGait, Stumble, RepeatedStumbles, SlowedWalk,                    // gait
  PhoneLeftBehind, Grab,                                                  // phone
  Separated, StoppedOnWayHome, InVehicle,                                 // location
  BatteryCritical, CheckInMissed, TypingOff,                              // device, check-in
  ScreamShout, SnoringWhileDown }                                         // audio
#[derive(uniffi::Enum)] pub enum IncidentTier { Context, Watch, Danger }
#[derive(uniffi::Record)] pub struct IncidentRecord { pub id: u32, pub t_ms: u64, pub kind: IncidentKind, pub tier: IncidentTier, pub summary: String, pub sd_distance: f32, pub placement: Placement, pub raw_json: String, pub cleared_ms: u64 /* 0 = active */, pub acknowledged: bool, pub sequence_id: u32 /* episode, 0 = none */, pub watched: bool }
#[derive(uniffi::Record)] pub struct LiveMetrics { pub t_ms: u64, pub placement: Placement, pub sampling_full: bool, pub activity: Activity, pub bands: Vec<MetricBand>, pub listening: bool, pub context: Vec<String>, pub baseline_trusted: bool, pub baseline_walk_days: f32, pub evidence: String }
// Context gains `charging: bool`. AudioScores is { t_ms, scream, shout, snore, level_db } (glass removed).
// EngineEvent gains AudioListening { on: bool } and IncidentCleared { record: IncidentRecord }.
```
- **`thresholds.auto_escalate`** (bundled default `false`): incident logging only. Incidents open, clear, log and
  drive sensing / listening, but no automatic check-in, heads-up, unlock or grab alert is raised; NeedHelp /
  ManualSos still unlock. Everything below about triggers and escalation applies with it set to `true`.
- **Tiers.** Context: logged only. Watch: full sensing (50 Hz + gyro) and counts toward a
  check-in. Danger: asks on its own. Point kinds (`Stumble`, `FallRecovered`) are logged already cleared.
- **Check-in trigger.** An unacknowledged Danger incident, or unacknowledged Watch incidents from ≥ `check_min_families`
  (2) families: fall · gait · phone · location · check-in · audio (`CheckInMissed` and `Grab` never trigger one).
  Answering (`DismissOk`, `BiometricDismiss`, `FriendMarkedSafe`) acknowledges every active incident and clears
  `CheckInMissed` / `TypingOff` / `SnoringWhileDown`. `DismissWrongPhrase` leaves the check open.
- **Escalation.** Check → at `check_deadline_s` (120) still triggered ⇒ `CheckInMissed` + `HeadsUp`, else `Resolved` →
  `UnlockLocation` at `unlock_no_response_s` (240, since the check) if still triggered, `Resolved` if it stops →
  `CallOptionAvailable` at `call_option_s` (600). Grab / NeedHelp / ManualSos unchanged.
- **No risk band.** The engine exposes no score or band; the heartbeat no longer writes `devices.risk_band` (column
  kept, default 0). Location uploads every `location_upload_s` (300), every `location_upload_alert_s` (60) once friends
  were alerted.
- **Listening window.** The engine emits `AudioListening { on: true }` (night mode) when a `PhoneDrop`, `PossibleFall`,
  `DownAfterFall`, `HardImpact`, `Grab`, `CheckInMissed`, `UnsteadyGait` or `RepeatedStumbles` incident opens or an
  escalation is running, and `on: false` `listen_hold_min` (10) after the newest of those (a long-lasting incident
  does not keep the mic on by itself). Native captures continuously only inside the window
  and pushes ~1 s frames; `push_audio` outside a window is ignored. `level_db` = dBFS + 112.3 (CDD 5.4.2 calibration of
  the voice-recognition source).
- **Episodes.** A check-in, grab or SOS starts an episode: incidents of the last `sequence.window_min` (60) join it
  (`sequence_id`, `watched`), later ones join until it resolves. Summaries are built from it (single stumbles omitted).
- **Night mode off** (home) clears every active incident.
- **Persisted log.** A log written by the HMM-era engine loads empty; the gait / typing baseline in the same blob is kept.
- JS: kinds and tiers are lowercase snake strings (`possible_fall`, `watch`); native emits `incidentCleared`
  (IncidentRecord) next to `signalIncident`.

### Monitor → phone commands (migration 0012)
Private broadcast channel `telemetry-cmd:{subjectUserId}`, event `command`, payload `{ cmd: "reset_incidents", t }`.
RLS: the subject **or any active group-mate** may publish; only the subject may subscribe (their phone). The phone
joins it next to `telemetry:{uid}` whenever the publisher runs and on `reset_incidents` empties the incident log and
rests sensing (`SafetyEngine.reset_incidents`). Kept apart from `telemetry:{uid}` because Realtime authorizes publishing
per channel, so group-mates must never get write access to the tick stream. The web monitor's "Clear incidents" button
sends it (acked) and empties its own list.

