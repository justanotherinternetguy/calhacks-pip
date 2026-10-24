// Mirrors docs/CONTRACTS.md §2 exactly. Native (ios/, android/) implements this surface.

export type NightMode = 'auto' | 'on' | 'off' | 'paused_tonight';
export type NightModeStatus = {
  active: boolean;
  since?: number;
  reason: 'away_from_home' | 'manual' | 'window' | 'off';
};
export type HmmState = 'normal' | 'impaired' | 'incident' | 'unresponsive';
export type EscalationLevel = 'idle' | 'check' | 'heads_up' | 'unlocked' | 'snatch' | 'resolved';
export type EngineSnapshot = {
  pDanger: number;
  hmmState: HmmState;
  escalation: EscalationLevel;
  riskBand: 0 | 1 | 2 | 3;
  evidence: string;
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
  userId: string;
  deviceId: string;
  modelConfigToml: string;
};
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
export type IncidentKind = 'gait_drift' | 'impact' | 'grab' | 'stillness' | 'separated' | 'typing_off';
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
  pNormal: number;
  pImpaired: number;
  pIncident: number;
  pUnresponsive: number;
  baselineTrusted: boolean;
  baselineWalkDays: number; // distinct local days with walking (trusted at 7)
  evidence: string;
};
export type IncidentRecord = {
  id: number;
  tMs: number;
  kind: IncidentKind;
  summary: string;
  sdDistance: number;
  placement: Placement;
  rawJson: string;
  pNormal: number;
  pImpaired: number;
  pIncident: number;
  pUnresponsive: number;
  sequenceId: number; // 0 = none
  watched: boolean; // part of a sequence the engine is still watching (not yet escalated)
};
export type Dashboard = { metrics: LiveMetrics; incidents: IncidentRecord[] };

// ---- §7 live telemetry stream (Android → web monitor). Supabase Realtime broadcast, topic `telemetry:{userId}`, event `tick`.
/** Engine events since the last tick, snake_case (CONTRACTS §7). Unknown names are tolerated by the UI. */
export type TelemetryEventName =
  | 'check_requested' | 'heads_up' | 'unlock_location' | 'snatch_detected' | 'resolved' | 'risk_band_changed'
  | 'battery_dying' | 'sampling_rate_changed' | 'signal_incident' | 'call_option';
export type TelemetryTick = {
  v: 1;
  t: number; // unix ms on the phone
  seq: number;
  user: string;
  metrics: LiveMetrics;
  hmm: HmmState;
  escalation: EscalationLevel;
  riskBand: 0 | 1 | 2 | 3;
  pDanger: number;
  nightMode: boolean;
  battery: number;
  activity: Activity;
  placement: Placement;
  samplingFull: boolean;
  accel: number[]; // |a| in g for the samples since the last tick (≤ 50), newest last
  gyro: number[]; // |ω| rad/s, same length (zeros in low-rate mode)
  sampleHz: number;
  incidents: IncidentRecord[]; // deltas: records with id > lastSentId
  incidentCount: number; // total live log size on the phone (gap detection)
  events: (TelemetryEventName | string)[];
  checkPhrase?: string; // while a check-in is pending
  checkDeadlineMs?: number;
};
export type TelemetryStatus = { on: boolean; hz: number; lastSentMs: number; failures: number };

export type SafetyNativeEvents = {
  statusChanged: Status;
  checkRequested: { phrase: string; deadlineMs: number };
  escalation: { level: EscalationLevel; summary: string };
  snatch: { summary: string; lat?: number; lng?: number };
  sos: { active: boolean };
  dashboard: Dashboard; // every 1 s while setDashboardStreaming(true)
  signalIncident: IncidentRecord;
  callOption: { summary: string }; // 10 min with no response: friends get the one-tap call option
};
export type SafetyNativeEventName = keyof SafetyNativeEvents;
export type Subscription = { remove(): void };

export interface SafetyNativeModuleType {
  configure(opts: ConfigureOptions): Promise<void>;
  setAccessToken(token: string): Promise<void>;
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
  // §7 telemetry publisher (Android). 4 Hz while on (default on once configured) or while the dashboard streams; 1 Hz in night mode otherwise.
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
