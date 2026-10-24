// Mirrors docs/CONTRACTS.md §2 exactly. Native (ios/, android/) implements this surface.

export type NightMode = 'auto' | 'on' | 'off' | 'paused_tonight';
export type NightModeStatus = {
  active: boolean;
  since?: number;
  reason: 'away_from_home' | 'manual' | 'window' | 'off';
};
export type EscalationLevel = 'idle' | 'check' | 'heads_up' | 'unlocked' | 'snatch' | 'resolved';
export type EngineSnapshot = {
  escalation: EscalationLevel;
  evidence: string;
  sensingFull: boolean; // 50 Hz + gyro, faster location (a watch incident has not cleared yet)
  listening: boolean; // the microphone listening window is open (labels only, never audio)
  baselineSeconds: number;
  placement: 'unknown' | 'pocket' | 'hand' | 'bag';
  nightMode: boolean;
};
export type PermissionState = 'granted' | 'denied' | 'undetermined';
export type Permissions = {
  locationAlways: PermissionState;
  motion: PermissionState;
  microphone: PermissionState;
  notifications: PermissionState;
  batteryUnrestricted?: PermissionState; // android
};
export type HomePlace = { id: string; label: string; lat: number; lng: number; radiusM: number };
export type Status = {
  nightMode: NightModeStatus;
  engine: EngineSnapshot;
  permissions: Permissions;
  batteryPct: number;
  lastHeartbeatMs?: number;
  serviceRunning: boolean;
};

export type ConfigureOptions = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  accessToken: string;
  /** Lets native refresh the JWT itself while JS is asleep (Android SessionKeeper). Omit for demo / mock sessions. */
  refreshToken?: string;
  userId: string;
  deviceId: string;
  modelConfigToml: string;
};
/** The session pair native holds (and refreshes on Android). `getSession()` returns null until JS handed a refresh token over. */
export type NativeSession = { accessToken: string; refreshToken: string; userId: string };
export type TypingRecord = {
  phrase: string;
  typed: string;
  keyTimesMs: number[];
  backspaces: number;
  durationMs: number;
};
export type TypingVerdict = { accepted: boolean; zScore: number; reason: string };
export type Identity = { userId: string; x25519Pub: string; ed25519Pub: string; fingerprint: string };
export type GroupMemberKeys = { userId: string; deviceId: string; x25519Pub: string; ed25519Pub: string };
export type GroupConfig = { groupId: string; thresholdK: number; members: GroupMemberKeys[] };
export type ReleasedKeyInput = {
  subjectUserId: string;
  epochId: string;
  hourIndex: number;
  sealedB64: string;
  senderEd25519Pub: string;
};
export type BlobInput = { epochId: string; seq: number; hourIndex: number; ciphertextB64: string };
export type DecryptedLocation = { lat: number; lng: number; accuracyM: number; tMs: number };
export type ApproveUnlockInput = {
  requestId: string;
  subjectUserId: string;
  epochId: string;
  requesterX25519Pub: string;
};
export type RecoverInput = {
  subjectUserId: string;
  epochId: string;
  sealedShares: { sealedB64: string; approverEd25519Pub: string }[];
};

// ---- §6 addendum (spec v1.1): live signals, incident log, grab detection. camelCase mirrors of the Rust records.
export type Placement = EngineSnapshot['placement'];
export type Activity = 'unknown' | 'stationary' | 'walking' | 'running' | 'vehicle';
export type IncidentKind =
  | 'phone_drop' | 'possible_fall' | 'fall_recovered' | 'down_after_fall' | 'hard_impact'
  | 'unsteady_gait' | 'stumble' | 'repeated_stumbles' | 'slowed_walk'
  | 'phone_left_behind' | 'grab'
  | 'separated' | 'stopped_on_way_home' | 'in_vehicle'
  | 'battery_critical'
  | 'check_in_missed' | 'typing_off'
  | 'scream_shout' | 'snoring_while_down';
/** context = logged only · watch = full sensing, counts toward a check-in · danger = asks "You okay?" on its own. */
export type IncidentTier = 'context' | 'watch' | 'danger';
/** One live metric vs its personal baseline band (mean ± 2.5 SD; 3.5 SD until the baseline is trusted). */
export type MetricBand = {
  name: string; // cadence | stride_cv | regularity | sway | wobble | jerk | rotation | peak_g
  value: number;
  mean: number;
  sd: number;
  sdDistance: number; // signed (value - mean) / sd
  inBand: boolean;
};
export type LiveMetrics = {
  tMs: number;
  placement: Placement;
  samplingFull: boolean; // true = 50 Hz + gyro, false = ~10 Hz accel only
  activity: Activity;
  bands: MetricBand[];
  listening: boolean;
  context: string[]; // situational chips, e.g. "away from home late", "in a vehicle"
  baselineTrusted: boolean;
  baselineWalkDays: number; // distinct local days with walking (trusted at 7)
  evidence: string;
};
export type IncidentRecord = {
  id: number;
  tMs: number;
  kind: IncidentKind;
  tier: IncidentTier;
  summary: string;
  sdDistance: number;
  placement: Placement;
  rawJson: string;
  clearedMs: number; // 0 = not yet cleared
  acknowledged: boolean; // the owner answered a check-in before it cleared
  sequenceId: number; // 0 = none
  watched: boolean; // part of a sequence the engine is still watching (not yet escalated)
};
export type Dashboard = { metrics: LiveMetrics; incidents: IncidentRecord[] };

// ---- §7 live telemetry stream (Android → web monitor). Supabase Realtime broadcast, topic `telemetry:{userId}`, event `tick`.
/** Engine events since the last tick, snake_case (CONTRACTS §7). Unknown names are tolerated by the UI. */
export type TelemetryEventName =
  | 'check_requested' | 'heads_up' | 'unlock_location' | 'snatch_detected' | 'resolved'
  | 'battery_dying' | 'sampling_rate_changed' | 'audio_listening' | 'signal_incident' | 'incident_cleared' | 'incident_log_cleared' | 'call_option';
/** The engine / mode part of a tick: sent by the phone at least once a second and after every engine tick (§7 v2 `state`). */
export type TelemetryState = {
  metrics: LiveMetrics;
  escalation: EscalationLevel;
  listening: boolean;
  nightMode: boolean;
  battery: number;
  activity: Activity;
  placement: Placement;
  samplingFull: boolean;
  checkPhrase?: string; // while a check-in is pending
  checkDeadlineMs?: number;
};
/**
 * Wire frame (§7 v2), 10 Hz while streaming / 1 Hz in night mode: always the raw samples since the previous frame,
 * engine events and incident deltas; `state` only when something changed or a second passed. `lib/telemetry.ts`
 * merges frames into full `TelemetryTick`s for the UI.
 */
export type TelemetryFrame = {
  v: 2;
  t: number; // unix ms on the phone when the frame was built
  seq: number;
  user: string;
  accel: number[]; // |a| in g, newest last
  gyro: number[]; // |ω| rad/s, same length (zeros in low-rate mode)
  st: number; // phone unix ms of the newest sample (0 when the frame carries none)
  sampleHz: number; // measured accelerometer delivery rate
  incidents: IncidentRecord[]; // deltas: new records plus ones whose clearedMs / acknowledged / sequenceId changed (upsert by id; the whole live log again after a rejoin)
  incidentCount: number;
  events: (TelemetryEventName | string)[];
  rttMs?: number; // phone → Realtime → phone round trip (self-echo), smoothed
  state?: TelemetryState;
};
/** What the monitor consumes: a v1 tick as published by older phones, or a v2 frame merged with the latest `state`. */
export type TelemetryTick = TelemetryState & {
  v: 1 | 2;
  t: number; // unix ms on the phone
  seq: number;
  user: string;
  accel: number[]; // |a| in g for the samples since the last tick, newest last
  gyro: number[]; // |ω| rad/s, same length (zeros in low-rate mode)
  st: number; // phone unix ms of the newest sample (v1: = t)
  sampleHz: number;
  incidents: IncidentRecord[]; // deltas, upserted by id
  incidentCount: number; // total live log size on the phone (gap detection)
  events: (TelemetryEventName | string)[];
  rttMs?: number;
};
export type TelemetryStatus = {
  on: boolean; // the explicit switch
  hz: number; // what is being published right now (0 = idle)
  lastSentMs: number;
  failures: number; // socket failures since process start
  connected: boolean; // channel joined
  reconnects: number;
  dropped: number; // frames dropped while the channel was down
  rttMs: number | null; // phone → Realtime → phone round trip (self-echo), null until measured
  error: string | null; // last socket failure reason
};

export type SafetyNativeEvents = {
  statusChanged: Status;
  checkRequested: { phrase: string; deadlineMs: number };
  escalation: { level: EscalationLevel; summary: string };
  snatch: { summary: string; lat?: number; lng?: number };
  sos: { active: boolean };
  dashboard: Dashboard; // every 1 s while setDashboardStreaming(true)
  signalIncident: IncidentRecord; // an incident opened (point kinds arrive already cleared)
  incidentCleared: IncidentRecord; // an incident met its clearing rule (clearedMs set)
  incidentLogCleared: Record<string, never>; // the user reset the incident log (resetIncidents)
  callOption: { summary: string }; // 10 min with no response: friends get the one-tap call option
  sessionRefreshed: NativeSession; // native rotated the JWT pair; JS must adopt it (supabase.auth.setSession)
};
export type SafetyNativeEventName = keyof SafetyNativeEvents;
export type Subscription = { remove(): void };

export interface SafetyNativeModuleType {
  configure(opts: ConfigureOptions): Promise<void>;
  setAccessToken(token: string): Promise<void>;
  /** New JWT pair from supabase-js (sign-in, TOKEN_REFRESHED). Idempotent. */
  setSession(s: { accessToken: string; refreshToken: string }): Promise<void>;
  /** The pair native holds, for JS to adopt at startup (native may have rotated it while JS slept). */
  getSession(): Promise<NativeSession | null>;
  /** Sign-out: native forgets the tokens and stops uploading / streaming as that user. */
  clearSession(): Promise<void>;
  requestPermission(kind: keyof Permissions): Promise<PermissionState>;
  setHomePlaces(places: HomePlace[]): Promise<void>; // device-only storage
  setEveningWindow(startHour: number, endHour: number): Promise<void>;
  setNightMode(mode: NightMode): Promise<void>;
  getStatus(): Promise<Status>;
  submitCheckIn(r: TypingRecord): Promise<TypingVerdict>;
  needHelp(): Promise<void>;
  triggerSos(): Promise<void>;
  cancelSos(): Promise<boolean>;
  startBaselineWalk(): Promise<void>;
  stopBaselineWalk(): Promise<{ seconds: number }>;
  recordTypingPractice(r: TypingRecord): Promise<void>;
  getIdentity(): Promise<Identity>;
  setGroup(g: GroupConfig): Promise<void>;
  // Friend side
  openReleasedKey(r: ReleasedKeyInput): Promise<void>;
  decryptLocations(subjectUserId: string, blobs: BlobInput[]): Promise<DecryptedLocation[]>;
  approveUnlock(r: ApproveUnlockInput): Promise<{ sealedShareB64: string }>;
  recoverFromShares(r: RecoverInput): Promise<{ ok: boolean }>;
  ringAlarm(seconds: number): Promise<void>;
  stopAlarm(): Promise<void>;
  injectTrace(json: string): Promise<void>; // debug builds only
  // §6 personal dashboard
  getDashboard(): Promise<Dashboard>;
  setDashboardStreaming(on: boolean): Promise<void>; // while on, emit 'dashboard' every 1 s
  /** Empty the incident log and put sensing back to rest (rule timers, mic window, incident-driven full rate). Baselines stay. */
  resetIncidents(): Promise<void>;
  // §7 telemetry publisher (Android). 10 Hz while on (default on once configured) or while the dashboard streams; 1 Hz in night mode otherwise.
  setTelemetry(on: boolean): Promise<void>;
  getTelemetryStatus(): Promise<TelemetryStatus>;
  /**
   * Demo sensitivity (Android): swap the live engine onto the bundled model-demo.toml (lenient thresholds so a judge
   * can trigger incidents by hand). The normal server model stays persisted and is restored when switched off.
   */
  setDemoSensitivity(on: boolean): Promise<void>;
  getDemoSensitivity(): Promise<boolean>;
  addListener<K extends SafetyNativeEventName>(
    name: K,
    cb: (event: SafetyNativeEvents[K]) => void,
  ): Subscription;
  /** true when running against the JS mock (web / Expo Go), not the real native service */
  readonly isMock?: boolean;
}
