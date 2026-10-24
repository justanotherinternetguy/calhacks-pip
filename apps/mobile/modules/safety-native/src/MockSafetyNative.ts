// JS mock used on web and in Expo Go (no native module present). Emits plausible
// status so the UI can be demoed. Contains NO detection logic — it only fakes outputs.
import type {
  SafetyNativeModuleType,
  SafetyNativeEvents,
  SafetyNativeEventName,
  Status,
  Permissions,
  HomePlace,
  NightMode,
  Subscription,
} from './SafetyNative.types';

type Listener = (e: never) => void;

export class MockSafetyNative implements SafetyNativeModuleType {
  readonly isMock = true;
  private listeners = new Map<string, Set<Listener>>();
  private permissions: Permissions = {
    locationAlways: 'undetermined',
    motion: 'undetermined',
    microphone: 'undetermined',
    notifications: 'undetermined',
  };
  private mode: NightMode = 'auto';
  private userId = 'mock-user';
  private walkStart: number | null = null;
  private baselineSeconds = 0;
  private sosActive = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private status: Status = {
    nightMode: { active: false, reason: 'off' },
    engine: {
      pDanger: 0.02,
      hmmState: 'normal',
      escalation: 'idle',
      riskBand: 0,
      evidence: 'mock: no signals',
      baselineSeconds: 0,
      placement: 'pocket',
      nightMode: false,
    },
    permissions: this.permissions,
    batteryPct: 81,
    serviceRunning: false,
  };

  private emit<K extends SafetyNativeEventName>(name: K, e: SafetyNativeEvents[K]) {
    this.listeners.get(name)?.forEach((l) => (l as (x: SafetyNativeEvents[K]) => void)(e));
  }
  private push(patch: Partial<Status>) {
    this.status = { ...this.status, ...patch, permissions: this.permissions };
    this.emit('statusChanged', this.status);
  }

  addListener<K extends SafetyNativeEventName>(name: K, cb: (e: SafetyNativeEvents[K]) => void): Subscription {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(cb as Listener);
    return { remove: () => this.listeners.get(name)?.delete(cb as Listener) };
  }

  async configure(opts: { userId: string }) {
    this.userId = opts.userId;
    if (!this.timer) {
      this.timer = setInterval(() => {
        const active = this.mode === 'on' || (this.mode === 'auto' && new Date().getHours() >= 20);
        this.push({
          nightMode: { active, reason: active ? (this.mode === 'on' ? 'manual' : 'window') : 'off' },
          engine: { ...this.status.engine, nightMode: active, pDanger: active ? 0.05 : 0.02 },
          batteryPct: Math.max(3, this.status.batteryPct - (active ? 1 : 0)),
          lastHeartbeatMs: Date.now(),
        });
      }, 10_000);
    }
    this.push({ serviceRunning: true });
  }
  async setAccessToken() {}
  async requestPermission(kind: keyof Permissions) {
    this.permissions = { ...this.permissions, [kind]: 'granted' };
    this.push({});
    return 'granted' as const;
  }
  async setHomePlaces(_places: HomePlace[]) {}
  async setEveningWindow() {}
  async setNightMode(mode: NightMode) {
    this.mode = mode;
    const active = mode === 'on';
    this.push({
      nightMode: { active, since: active ? Date.now() : undefined, reason: active ? 'manual' : 'off' },
      engine: { ...this.status.engine, nightMode: active },
    });
  }
  async getStatus() {
    return this.status;
  }
  async submitCheckIn(r: { phrase: string; typed: string }) {
    const ok = r.typed.trim().toLowerCase() === r.phrase.trim().toLowerCase();
    this.push({ engine: { ...this.status.engine, escalation: ok ? 'idle' : 'check', pDanger: ok ? 0.05 : 0.7 } });
    return { accepted: ok, zScore: ok ? 0.3 : 2.4, reason: ok ? 'mock: phrase matched' : 'mock: phrase mismatch' };
  }
  async needHelp() {
    this.push({ engine: { ...this.status.engine, escalation: 'unlocked', pDanger: 0.99, evidence: 'user asked for help' } });
    this.emit('escalation', { level: 'unlocked', summary: 'User tapped "I need help"' });
  }
  async triggerSos() {
    this.sosActive = true;
    this.emit('sos', { active: true });
    this.push({ engine: { ...this.status.engine, escalation: 'unlocked', pDanger: 1, evidence: 'manual SOS' } });
    this.emit('escalation', { level: 'unlocked', summary: 'Manual SOS' });
  }
  async cancelSos() {
    this.sosActive = false;
    this.emit('sos', { active: false });
    this.push({ engine: { ...this.status.engine, escalation: 'resolved', pDanger: 0.02, evidence: 'SOS cancelled' } });
    return true;
  }
  async startBaselineWalk() {
    this.walkStart = Date.now();
  }
  async stopBaselineWalk() {
    const seconds = this.walkStart ? Math.round((Date.now() - this.walkStart) / 1000) : 0;
    this.walkStart = null;
    this.baselineSeconds += seconds;
    this.push({ engine: { ...this.status.engine, baselineSeconds: this.baselineSeconds } });
    return { seconds };
  }
  async recordTypingPractice() {}
  async getIdentity() {
    const fp = Array.from({ length: 8 }, (_, i) => (this.userId.charCodeAt(i % this.userId.length) * 2654435761 % 65536).toString(16).padStart(4, '0')).join('-');
    return { userId: this.userId, x25519Pub: btoa('mock-x25519-' + this.userId), ed25519Pub: btoa('mock-ed25519-' + this.userId), fingerprint: fp };
  }
  async setGroup() {}
  async openReleasedKey() {}
  async decryptLocations(_s: string, blobs: { seq: number }[]) {
    // fake a short walking trail around a campus-ish point
    return blobs.map((b, i) => ({
      lat: 42.3505 + i * 0.0004,
      lng: -71.1054 + i * 0.0003,
      accuracyM: 25,
      tMs: Date.now() - (blobs.length - i) * 120_000,
    }));
  }
  async approveUnlock() {
    return { sealedShareB64: btoa('mock-share') };
  }
  async recoverFromShares(r: { sealedShares: unknown[] }) {
    return { ok: r.sealedShares.length >= 2 };
  }
  async ringAlarm() {}
  async stopAlarm() {}
  async injectTrace(json: string) {
    // Demo helper: a trace with "scenario":"fall" simulates the escalation path via events.
    let scenario = 'check';
    try {
      scenario = JSON.parse(json).scenario ?? scenario;
    } catch {}
    this.push({ engine: { ...this.status.engine, hmmState: 'incident', pDanger: 0.72, evidence: 'mock: hard fall, no movement 2 min' } });
    this.emit('checkRequested', { phrase: 'blue river stone', deadlineMs: Date.now() + 90_000 });
    if (scenario === 'snatch') this.emit('snatch', { summary: 'mock: phone snatched', lat: 42.35, lng: -71.1 });
  }
}
