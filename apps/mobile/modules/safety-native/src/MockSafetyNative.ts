// JS mock used on web and in Expo Go (no native module present). Emits plausible
// status so the UI can be demoed. Contains NO detection logic — it only fakes outputs.
import type {
  Dashboard,
  HomePlace,
  IncidentKind,
  IncidentRecord,
  LiveMetrics,
  MetricBand,
  NightMode,
  Permissions,
  SafetyNativeEventName,
  SafetyNativeEvents,
  SafetyNativeModuleType,
  Status,
  Subscription,
  TelemetryStatus,
} from './SafetyNative.types';

type Listener = (e: never) => void;

/** Which scripted scenario is colouring the fake live metrics right now (§6 dashboard). */
type MetricScenario = 'idle' | 'drunk' | 'fall' | 'snatch' | 'still';

/** Population-default baselines (walking, pocket). Units: cadence steps/min, peak_g g, jerk m/s³, rotation rad/s, rest unitless. */
const BASELINES: { name: string; mean: number; sd: number; noise: number }[] = [
  { name: 'cadence', mean: 108, sd: 6, noise: 0.6 },
  { name: 'stride_cv', mean: 0.06, sd: 0.015, noise: 0.5 },
  { name: 'regularity', mean: 0.82, sd: 0.05, noise: 0.5 },
  { name: 'sway', mean: 0.12, sd: 0.03, noise: 0.6 },
  { name: 'wobble', mean: 0.08, sd: 0.025, noise: 0.6 },
  { name: 'jerk', mean: 1.6, sd: 0.4, noise: 0.5 },
  { name: 'rotation', mean: 0.9, sd: 0.3, noise: 0.5 },
  { name: 'peak_g', mean: 1.25, sd: 0.12, noise: 0.4 },
];
/** Per-scenario drift in SD units, applied on top of noise (gait_drift for drunk, grab signature for snatch, …). */
const DRIFT: Record<MetricScenario, Partial<Record<string, number>>> = {
  idle: {},
  drunk: { stride_cv: 3.2, regularity: -3.1, sway: 3.4, wobble: 2.9, cadence: -1.6 },
  fall: { peak_g: 9, jerk: 6, rotation: 4, cadence: -4 },
  snatch: { jerk: 7, rotation: 5.5, cadence: 2.8, peak_g: 3 },
  still: { cadence: -8, sway: -2, wobble: -2, regularity: -1 },
};
const INCIDENT_TTL_MS = 8 * 3600_000;
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

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
  // §6 dashboard state
  private dashTimer: ReturnType<typeof setInterval> | null = null;
  private metricScenario: MetricScenario = 'idle';
  private metricScenarioSince = 0;
  private incidents: IncidentRecord[] = [];
  private nextIncidentId = 1;
  private nextSequenceId = 1;
  private lastMetrics: LiveMetrics | null = null;
  // §7 telemetry: the mock never publishes (no sensing here); it only remembers the preference (default on, like native).
  private telemetryOn = true;
  /** Demo sensitivity: the mock has no engine to re-configure; it only remembers the switch (default off, like native). */
  private demoSensitivity = false;
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
    if (ok) { this.clearScenario(); this.setMetricScenario('idle'); }
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
    this.setMetricScenario('idle');
    this.incidents = this.incidents.map((r) => ({ ...r, watched: false }));
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

  // ---- §6 personal dashboard: fake live metrics + incident log -------------------------------------
  async getDashboard(): Promise<Dashboard> {
    return { metrics: this.computeMetrics(), incidents: this.liveIncidents() };
  }
  async setDashboardStreaming(on: boolean) {
    if (on && !this.dashTimer) {
      this.dashTimer = setInterval(() => this.emit('dashboard', { metrics: this.computeMetrics(), incidents: this.liveIncidents() }), 1_000);
      this.emit('dashboard', { metrics: this.computeMetrics(), incidents: this.liveIncidents() });
    } else if (!on && this.dashTimer) {
      clearInterval(this.dashTimer);
      this.dashTimer = null;
    }
  }
  // ---- §7 telemetry publisher: no-op on the mock. Only an Android phone broadcasts; the web client subscribes (lib/telemetry.ts).
  async setTelemetry(on: boolean) {
    this.telemetryOn = on;
  }
  async getTelemetryStatus(): Promise<TelemetryStatus> {
    return { on: this.telemetryOn, hz: this.telemetryOn ? (this.dashTimer ? 4 : this.status.nightMode.active ? 1 : 4) : 0, lastSentMs: 0, failures: 0 };
  }
  async setDemoSensitivity(on: boolean) {
    this.demoSensitivity = on;
  }
  async getDemoSensitivity() {
    return this.demoSensitivity;
  }
  private liveIncidents() {
    const cutoff = Date.now() - INCIDENT_TTL_MS;
    this.incidents = this.incidents.filter((r) => r.tMs >= cutoff);
    return this.incidents.slice();
  }
  private setMetricScenario(sc: MetricScenario) {
    this.metricScenario = sc;
    this.metricScenarioSince = Date.now();
  }
  private stateProbabilities() {
    const { hmmState, pDanger } = this.status.engine;
    // Dominant state carries most of the mass; the rest is split so the strip visibly moves with pDanger.
    const base: Record<Status['engine']['hmmState'], [number, number, number, number]> = {
      normal: [0.86, 0.1, 0.03, 0.01], impaired: [0.22, 0.62, 0.12, 0.04], incident: [0.08, 0.17, 0.6, 0.15], unresponsive: [0.03, 0.07, 0.25, 0.65],
    };
    const [n, i, c, u] = base[hmmState];
    const danger = Math.min(1, Math.max(0, pDanger));
    const pNormal = Math.max(0.01, n * (1 - danger) + 0.02);
    const raw = [pNormal, i + danger * 0.1, c + danger * 0.25, u + danger * 0.15];
    const sum = raw.reduce((a, b) => a + b, 0);
    const [pN, pI, pC, pU] = raw.map((x) => x / sum);
    return { pNormal: pN, pImpaired: pI, pIncident: pC, pUnresponsive: pU };
  }
  private computeMetrics(): LiveMetrics {
    const baselineWalkDays = Math.min(7, Math.round((2.5 + this.baselineSeconds / 300) * 10) / 10);
    const baselineTrusted = baselineWalkDays >= 7;
    const bandSd = baselineTrusted ? 2.5 : 3.5;
    const sc = this.metricScenario;
    const age = (Date.now() - this.metricScenarioSince) / 1000;
    // A fall is a spike that settles into stillness; the others hold while the scenario runs.
    const envelope = sc === 'fall' ? Math.max(0, 1 - age / 4) : sc === 'idle' ? 0 : Math.min(1, age / 3);
    const stillAfterFall = sc === 'fall' && age > 4;
    const bands: MetricBand[] = BASELINES.map((b) => {
      const drift = (stillAfterFall ? DRIFT.still[b.name] : DRIFT[sc][b.name]) ?? 0;
      const z = gauss() * b.noise + drift * (stillAfterFall ? 1 : envelope);
      const value = Math.max(0, b.mean + z * b.sd);
      const sdDistance = (value - b.mean) / b.sd;
      return { name: b.name, value, mean: b.mean, sd: b.sd, sdDistance, inBand: Math.abs(sdDistance) <= bandSd };
    });
    const activity = stillAfterFall || sc === 'still' ? 'stationary' : sc === 'snatch' ? 'running' : 'walking';
    const m: LiveMetrics = {
      tMs: Date.now(),
      placement: this.status.engine.placement,
      samplingFull: this.status.nightMode.active || sc !== 'idle',
      activity,
      bands,
      ...this.stateProbabilities(),
      baselineTrusted,
      baselineWalkDays,
      evidence: this.status.engine.evidence,
    };
    this.lastMetrics = m;
    return m;
  }
  /** Append to the incident log (newest last, like the engine) and fire 'signalIncident'. */
  private signal(kind: IncidentKind, summary: string, sdDistance: number, opts: { sequenceId?: number; watched?: boolean; raw?: Record<string, unknown> } = {}) {
    const m = this.lastMetrics ?? this.computeMetrics();
    const rec: IncidentRecord = {
      id: this.nextIncidentId++,
      tMs: Date.now(),
      kind, summary, sdDistance,
      placement: this.status.engine.placement,
      rawJson: JSON.stringify({ kind, scenario: this.metricScenario, sampling_full: m.samplingFull, activity: m.activity, bands: Object.fromEntries(m.bands.map((b) => [b.name, Number(b.value.toFixed(3))])), ...opts.raw }),
      pNormal: m.pNormal, pImpaired: m.pImpaired, pIncident: m.pIncident, pUnresponsive: m.pUnresponsive,
      sequenceId: opts.sequenceId ?? 0,
      watched: opts.watched ?? false,
    };
    this.incidents.push(rec);
    this.emit('signalIncident', rec);
    return rec;
  }
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
  private runCheckChain(opts: { evidence: string; deadlineMs: number; stopAt: 'check' | 'heads_up' | 'unlocked'; unlockAfterMs?: number; state?: Status['engine']['hmmState'] }) {
    const phrases = ['blue river stone', 'quiet amber lane', 'soft copper wave', 'green paper moon'];
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const deadline = Date.now() + opts.deadlineMs;
    this.push({ engine: { ...this.status.engine, hmmState: opts.state ?? 'incident', escalation: 'check', pDanger: 0.62, riskBand: 2, evidence: opts.evidence } });
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
        // Real engine: CallOptionAvailable after 600 s with no response. Mock clock: 10 s.
        this.later(10_000, () => this.emit('callOption', { summary: `${ev2}; 10 min without a response` }));
      });
    });
  }

  /** fall-type scenarios: impact now, stillness once the metrics have settled (same sequence). */
  private fallSignals() {
    this.setMetricScenario('fall');
    const seq = this.nextSequenceId++;
    this.signal('impact', 'peak 3.1 g with orientation change', 9, { sequenceId: seq, watched: true, raw: { peak_g: 3.1, orientation_change_deg: 74 } });
    this.later(5_000, () => this.signal('stillness', 'still 3 min and no touch 3 min after impact', -8, { sequenceId: seq, watched: false, raw: { still_s: 180, no_touch_s: 180 } }));
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
          this.fallSignals();
          return this.runCheckChain({ evidence: 'mock: stumble, hard impact, then still 40 s', deadlineMs: 20_000, stopAt: 'unlocked', unlockAfterMs: 15_000 });
        case 'heads-up':
          this.fallSignals();
          return this.runCheckChain({ evidence: 'mock: hard fall, no movement 2 min', deadlineMs: 9_000, stopAt: 'heads_up' });
        case 'unlock-map':
        case 'unlock':
        case 'unlocked':
          this.fallSignals();
          return this.runCheckChain({ evidence: 'mock: hard fall, no movement 4 min', deadlineMs: 9_000, stopAt: 'unlocked', unlockAfterMs: 6_000 });
        case 'fall':
          this.fallSignals();
          return this.runCheckChain({ evidence: 'mock: fall trace — impact 3.1 g then still', deadlineMs: 9_000, stopAt: 'unlocked', unlockAfterMs: 8_000 });
        case 'drunk': {
          this.setMetricScenario('drunk');
          const seq = this.nextSequenceId++;
          this.signal('gait_drift', 'sway +3.4 SD, stride variability +3.2 SD for 30 s of walking', 3.4, { sequenceId: seq, watched: true, raw: { persisted_s: 30 } });
          return this.runCheckChain({ evidence: 'mock: drunk trace — gait drifted out of band for 30 s', deadlineMs: 9_000, stopAt: 'unlocked', unlockAfterMs: 8_000, state: 'impaired' });
        }
        case 'still': {
          this.setMetricScenario('still');
          this.signal('stillness', 'still 3 min, no touch 3 min', -8, { raw: { still_s: 180, no_touch_s: 180 } });
          return this.runCheckChain({ evidence: 'mock: still trace — no movement, no touch 3 min', deadlineMs: 9_000, stopAt: 'unlocked', unlockAfterMs: 8_000 });
        }
        case 'snatch': {
          const summary = 'mock: jerk in hand, running cadence, separated from group';
          this.setMetricScenario('snatch');
          this.push({ engine: { ...this.status.engine, hmmState: 'incident', escalation: 'snatch', pDanger: 0.9, riskBand: 3, placement: 'hand', evidence: summary } });
          this.signal('grab', 'jerk +7 SD in hand, cadence → running within 2 s', 7, { sequenceId: this.nextSequenceId++, watched: true, raw: { jerk_peak: 4.4, phone_unlocked: false, window_s: 120 } });
          this.emit('snatch', { summary, lat: 42.3505, lng: -71.1054 });
          this.emit('escalation', { level: 'snatch', summary });
          return;
        }
        case 'manual-sos':
        case 'sos':
          // Night out, nothing detected: the user holds the button themselves.
          this.setMetricScenario('idle');
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
