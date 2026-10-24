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
  private scenarioTimers: ReturnType<typeof setTimeout>[] = [];
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
    if (ok) this.clearScenario();
    this.push({ engine: { ...this.status.engine, hmmState: ok ? 'normal' : this.status.engine.hmmState, escalation: ok ? 'idle' : 'check', pDanger: ok ? 0.05 : 0.7, evidence: ok ? 'mock: check-in dismissed, sensitivity lowered 30 min' : this.status.engine.evidence } });
    if (ok) this.emit('escalation', { level: 'resolved', summary: 'Check-in dismissed' });
    return { accepted: ok, zScore: ok ? 0.3 : 2.4, reason: ok ? 'mock: phrase matched' : 'mock: phrase mismatch' };
  }
  async needHelp() {
    this.clearScenario();
    this.push({ engine: { ...this.status.engine, escalation: 'unlocked', pDanger: 0.99, evidence: 'user asked for help' } });
    this.emit('escalation', { level: 'unlocked', summary: 'User tapped "I need help"' });
  }
  async triggerSos() {
    this.clearScenario();
    this.sosActive = true;
    this.emit('sos', { active: true });
    this.push({ engine: { ...this.status.engine, escalation: 'unlocked', pDanger: 1, evidence: 'manual SOS' } });
    this.emit('escalation', { level: 'unlocked', summary: 'Manual SOS' });
  }
  /** Biometric-gated stand-down for SOS, snatch and any running escalation. The mock always passes the biometric. */
  async cancelSos() {
    this.clearScenario();
    this.sosActive = false;
    this.emit('sos', { active: false });
    this.push({ engine: { ...this.status.engine, hmmState: 'normal', escalation: 'resolved', pDanger: 0.02, evidence: 'mock: stood down by owner (biometric)' } });
    this.emit('escalation', { level: 'resolved', summary: 'Stood down by owner' });
    this.later(3_000, () => this.push({ engine: { ...this.status.engine, escalation: 'idle' } }));
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
  // ---- debug: scripted scenarios standing in for the native trace replay (e2e/*.yaml, docs/DEMO.md)

  private later(ms: number, f: () => void) {
    const t = setTimeout(() => { this.scenarioTimers = this.scenarioTimers.filter((x) => x !== t); f(); }, ms);
    this.scenarioTimers.push(t);
  }
  private clearScenario() {
    this.scenarioTimers.forEach(clearTimeout);
    this.scenarioTimers = [];
  }
  private nightOn() {
    if (this.status.nightMode.active) return;
    this.mode = 'on';
    this.push({ nightMode: { active: true, since: Date.now(), reason: 'away_from_home' }, engine: { ...this.status.engine, nightMode: true }, serviceRunning: true });
  }
  /** check → (deadline) heads-up → (+unlockAfterMs) unlocked. `stopAt` caps the chain. */
  private runCheckChain(opts: { evidence: string; deadlineMs: number; stopAt: 'check' | 'heads_up' | 'unlocked'; unlockAfterMs?: number }) {
    const phrases = ['blue river stone', 'quiet amber lane', 'soft copper wave', 'green paper moon'];
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const deadline = Date.now() + opts.deadlineMs;
    this.push({ engine: { ...this.status.engine, hmmState: 'incident', escalation: 'check', pDanger: 0.62, riskBand: 2, evidence: opts.evidence } });
    this.emit('escalation', { level: 'check', summary: opts.evidence });
    this.emit('checkRequested', { phrase, deadlineMs: deadline });
    if (opts.stopAt === 'check') return;
    this.later(opts.deadlineMs, () => {
      const ev = `${opts.evidence}; no answer to check-in`;
      this.push({ engine: { ...this.status.engine, hmmState: 'unresponsive', escalation: 'heads_up', pDanger: 0.78, riskBand: 3, evidence: ev } });
      this.emit('escalation', { level: 'heads_up', summary: ev });
      if (opts.stopAt === 'heads_up') return;
      this.later(opts.unlockAfterMs ?? 8_000, () => {
        const ev2 = `${ev}; still no movement`;
        this.push({ engine: { ...this.status.engine, escalation: 'unlocked', pDanger: 0.93, evidence: ev2 } });
        this.emit('escalation', { level: 'unlocked', summary: ev2 });
      });
    });
  }

  /**
   * The native module replays a real {speed, motion[], context[], audio[]} trace through the Rust engine.
   * The mock cannot, so it plays a scripted version keyed by `scenario` (or `trace`) name — the same names
   * the e2e flows and the demo script use — on a 10x-style clock (90 s check-in deadline → 9 s).
   */
  async injectTrace(json: string) {
    let name = 'check';
    try {
      const t = JSON.parse(json) as { scenario?: string; trace?: string; motion?: unknown[] };
      name = t.scenario ?? t.trace ?? (t.motion?.length ? 'fall' : name);
    } catch {}
    const scenario = name.toLowerCase().replace(/[\s_]+/g, '-');
    this.clearScenario();
    this.nightOn();
    // Give the status update a beat to land before events fire, like native would.
    this.later(600, () => {
      switch (scenario) {
        case 'checkin-dismiss':
        case 'check':
        case 'checkin':
        case 'check-in':
          return this.runCheckChain({ evidence: 'mock: stumble, hard impact, then still 40 s', deadlineMs: 20_000, stopAt: 'unlocked', unlockAfterMs: 15_000 });
        case 'heads-up':
          return this.runCheckChain({ evidence: 'mock: hard fall, no movement 2 min', deadlineMs: 9_000, stopAt: 'heads_up' });
        case 'unlock-map':
        case 'unlock':
        case 'unlocked':
          return this.runCheckChain({ evidence: 'mock: hard fall, no movement 4 min', deadlineMs: 9_000, stopAt: 'unlocked', unlockAfterMs: 6_000 });
        case 'fall':
        case 'drunk':
        case 'still':
          return this.runCheckChain({ evidence: `mock: ${scenario} trace`, deadlineMs: 9_000, stopAt: 'unlocked', unlockAfterMs: 8_000 });
        case 'snatch': {
          const summary = 'mock: jerk in hand, running cadence, separated from group';
          this.push({ engine: { ...this.status.engine, hmmState: 'incident', escalation: 'snatch', pDanger: 0.9, riskBand: 3, placement: 'hand', evidence: summary } });
          this.emit('snatch', { summary, lat: 42.3505, lng: -71.1054 });
          this.emit('escalation', { level: 'snatch', summary });
          return;
        }
        case 'manual-sos':
        case 'sos':
          // Night out, nothing detected: the user holds the button themselves.
          return this.push({ engine: { ...this.status.engine, hmmState: 'normal', escalation: 'idle', pDanger: 0.05, riskBand: 1, evidence: 'mock: walking home, nothing unusual' } });
        case 'resolve':
        case 'reset':
        case 'idle':
          return void this.cancelSos();
        default:
          console.warn(`[SafetyNative mock] unknown scenario "${name}", playing a check-in`);
          return this.runCheckChain({ evidence: `mock: ${name}`, deadlineMs: 20_000, stopAt: 'unlocked', unlockAfterMs: 15_000 });
      }
    });
  }
}
