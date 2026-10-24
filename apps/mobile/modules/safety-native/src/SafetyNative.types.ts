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

export type SafetyNativeEvents = {
  statusChanged: Status;
  checkRequested: { phrase: string; deadlineMs: number };
  escalation: { level: EscalationLevel; summary: string };
  snatch: { summary: string; lat?: number; lng?: number };
  sos: { active: boolean };
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
  addListener<K extends SafetyNativeEventName>(
    name: K,
    cb: (event: SafetyNativeEvents[K]) => void,
  ): Subscription;
  /** true when running against the JS mock (web / Expo Go), not the real native service */
  readonly isMock?: boolean;
}
