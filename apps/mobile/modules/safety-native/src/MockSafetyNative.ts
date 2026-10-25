// JS mock used on web and in Expo Go (no native module present). Emits plausible
// status so the UI can be demoed. Contains NO detection logic — it only fakes outputs.
import type {
  Dashboard,
  HomePlace,
  IncidentKind,
  IncidentRecord,
  IncidentTier,
  LiveMetrics,
  MetricBand,
  NightMode,
  Permissions,
  SafetyNativeEventName,
  SafetyNativeEvents,
  SafetyNativeModuleType,
  Status,
  Subscription,
  TelemetryCollect,
  TelemetryStatus,
} from './SafetyNative.types';

type Listener = (e: never) => void;

/** Which scripted scenario is colouring the fake live metrics right now (§6 dashboard). */
type MetricScenario = 'idle' | 'drunk' | 'fall' | 'snatch' | 'still';

/** Population-default baselines (walking, pocket). Units: cadence steps/min, peak_g g, jerk g/s, rotation °/s, rest unitless. */
const BASELINES: { name: string; mean: number; sd: number; noise: number }[] = [
  { name: 'cadence', mean: 108, sd: 6, noise: 0.6 },
  { name: 'stride_cv', mean: 0.06, sd: 0.015, noise: 0.5 },
  { name: 'regularity', mean: 0.82, sd: 0.05, noise: 0.5 },
  { name: 'sway', mean: 0.12, sd: 0.03, noise: 0.6 },
  { name: 'wobble', mean: 0.08, sd: 0.025, noise: 0.6 },
  { name: 'jerk', mean: 8, sd: 14, noise: 0.5 },
  { name: 'rotation', mean: 40, sd: 87.5, noise: 0.5 },
  { name: 'peak_g', mean: 1.25, sd: 0.12, noise: 0.4 },
];
/** Per-scenario drift in SD units, applied on top of noise (unsteady gait for drunk, grab signature for snatch, …). */
const DRIFT: Record<MetricScenario, Partial<Record<string, number>>> = {
  idle: {},
  drunk: { stride_cv: 3.2, regularity: -3.1, sway: 3.4, wobble: 2.9, cadence: -1.6 },
  fall: { peak_g: 9, jerk: 6, rotation: 4, cadence: -4 },
  snatch: { jerk: 7, rotation: 5.5, cadence: 2.8, peak_g: 3 },
  still: { cadence: -8, sway: -2, wobble: -2, regularity: -1 },
};
const INCIDENT_TTL_MS = 8 * 3600_000;
/** The engine's fixed tier per kind (safety-core types.rs), so mock records look like real ones. */
const TIER: Record<IncidentKind, IncidentTier> = {
  fall_recovered: 'context', stumble: 'context', in_vehicle: 'context', battery_critical: 'context',
  down_after_fall: 'danger', grab: 'danger', check_in_missed: 'danger', snoring_while_down: 'danger',
  phone_drop: 'watch', possible_fall: 'watch', hard_impact: 'watch', unsteady_gait: 'watch', repeated_stumbles: 'watch', slowed_walk: 'watch',
  phone_left_behind: 'watch', separated: 'watch', stopped_on_way_home: 'watch', typing_off: 'watch', scream_shout: 'watch', distress_words: 'watch',
};
/** Kinds that open the engine's microphone listening window. */
const OPENS_LISTENING = new Set<IncidentKind>(['phone_drop', 'possible_fall', 'down_after_fall', 'hard_impact', 'grab', 'check_in_missed', 'unsteady_gait', 'repeated_stumbles']);
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
      escalation: 'idle',
      evidence: 'mock: no signals',
      sensingFull: false,
      listening: false,
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
          engine: { ...this.status.engine, nightMode: active },
          batteryPct: Math.max(3, this.status.batteryPct - (active ? 1 : 0)),
          lastHeartbeatMs: Date.now(),
        });
      }, 10_000);
    }
    this.push({ serviceRunning: true });
  }
  async setAccessToken() {}
  async setSession() {}
  async getSession() { return null; }
  async clearSession() {}
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
    if (ok) {
      // Answering acknowledges the uncleared incidents: they stay open but no longer ask again.
      this.clearScenario();
      this.setMetricScenario('idle');
      this.incidents = this.incidents.map((r) => (r.clearedMs === 0 ? { ...r, acknowledged: true, watched: false } : r));
    }
    this.push({ engine: { ...this.status.engine, escalation: ok ? 'idle' : 'check', evidence: ok ? 'mock: check-in answered, incidents acknowledged' : this.status.engine.evidence } });
    if (ok) this.emit('escalation', { level: 'resolved', summary: 'Check-in dismissed' });
    return { accepted: ok, zScore: ok ? 0.3 : 2.4, reason: ok ? 'mock: phrase matched' : 'mock: phrase mismatch' };
  }
  /** No native check-in screen in the mock: the caller falls back to the JS /check-in screen. */
  async openCheckIn(): Promise<void> {
    throw new Error('native check-in screen not available');
  }
  async needHelp() {
    this.clearScenario();
    this.push({ engine: { ...this.status.engine, escalation: 'unlocked', evidence: 'user asked for help' } });
    this.emit('escalation', { level: 'unlocked', summary: 'User tapped "I need help"' });
  }
  async triggerSos() {
    this.clearScenario();
    this.sosActive = true;
    this.emit('sos', { active: true });
    this.push({ engine: { ...this.status.engine, escalation: 'unlocked', evidence: 'manual SOS' } });
    this.emit('escalation', { level: 'unlocked', summary: 'Manual SOS' });
  }
  /** Biometric-gated stand-down for SOS, snatch and any running escalation. The mock always passes the biometric. */
  async cancelSos() {
    this.clearScenario();
    this.setMetricScenario('idle');
    this.incidents = this.incidents.map((r) => ({ ...r, watched: false }));
    for (const r of this.incidents) if (r.clearedMs === 0) this.clearIncident(r.id);
    this.sosActive = false;
    this.emit('sos', { active: false });
    this.push({ engine: { ...this.status.engine, escalation: 'resolved', sensingFull: false, listening: false, evidence: 'mock: stood down by owner (biometric)' } });
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
  async resetIncidents() {
    this.clearScenario();
    this.incidents = [];
    this.push({ engine: { ...this.status.engine, escalation: 'idle', evidence: '', sensingFull: false, listening: false } });
    this.emit('incidentLogCleared', {});
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
    const hz = this.telemetryOn || this.dashTimer ? 10 : this.status.nightMode.active ? 1 : 0;
    return { on: this.telemetryOn, hz, lastSentMs: 0, failures: 0, connected: false, reconnects: 0, dropped: 0, rttMs: null, error: 'mock: nothing is published' };
  }
  async setDemoSensitivity(on: boolean) {
    this.demoSensitivity = on;
  }
  async getDemoSensitivity() {
    return this.demoSensitivity;
  }
  private collectAllowed = false;
  async setCollectAllowed(on: boolean) {
    this.collectAllowed = on;
  }
  async getCollect(): Promise<TelemetryCollect> {
    // The mock publishes nothing, so a /collect page can never start a session on it.
    return { allowed: this.collectAllowed, on: false, startedMs: 0, untilMs: 0, label: null, demo: this.demoSensitivity };
  }
  async stopCollect() {}
  private liveIncidents() {
    const cutoff = Date.now() - INCIDENT_TTL_MS;
    this.incidents = this.incidents.filter((r) => r.tMs >= cutoff);
    return this.incidents.slice();
  }
  private setMetricScenario(sc: MetricScenario) {
    this.metricScenario = sc;
    this.metricScenarioSince = Date.now();
  }
  /** Situational chips, in the engine's words (LiveMetrics.context). */
  private contextChips(stationary: boolean): string[] {
    const out: string[] = [];
    if (this.status.nightMode.active) out.push('away from home late');
    if (stationary && this.metricScenario !== 'idle') out.push('phone set down');
    return out;
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
      samplingFull: this.status.engine.sensingFull || this.status.nightMode.active || sc !== 'idle',
      activity,
      bands,
      listening: this.status.engine.listening,
      context: this.contextChips(activity === 'stationary'),
      baselineTrusted,
      baselineWalkDays,
      evidence: this.status.engine.evidence,
    };
    this.lastMetrics = m;
    return m;
  }
  /**
   * Append to the incident log (newest last, like the engine) and fire 'signalIncident'. Point kinds (stumble,
   * fall_recovered) arrive already cleared; a watch/danger incident turns on full sensing.
   */
  private signal(kind: IncidentKind, summary: string, sdDistance: number, opts: { sequenceId?: number; watched?: boolean; raw?: Record<string, unknown> } = {}) {
    const m = this.lastMetrics ?? this.computeMetrics();
    const now = Date.now();
    const tier = TIER[kind];
    const point = kind === 'stumble' || kind === 'fall_recovered';
    const rec: IncidentRecord = {
      id: this.nextIncidentId++,
      tMs: now,
      kind, tier, summary, sdDistance,
      placement: this.status.engine.placement,
      rawJson: JSON.stringify({ kind, scenario: this.metricScenario, sampling_full: m.samplingFull, activity: m.activity, bands: Object.fromEntries(m.bands.map((b) => [b.name, Number(b.value.toFixed(3))])), ...opts.raw }),
      clearedMs: point ? now : 0,
      acknowledged: false,
      sequenceId: opts.sequenceId ?? 0,
      watched: opts.watched ?? false,
    };
    this.incidents.push(rec);
    this.emit('signalIncident', rec);
    if (tier !== 'context' && !point) {
      const e = this.status.engine;
      this.push({ engine: { ...e, sensingFull: true, listening: e.listening || OPENS_LISTENING.has(kind) } });
    }
    return rec;
  }
  /** Clear an open incident (sets clearedMs) and fire 'incidentCleared'. */
  private clearIncident(id: number) {
    const i = this.incidents.findIndex((r) => r.id === id && r.clearedMs === 0);
    if (i < 0) return;
    const rec = { ...this.incidents[i], clearedMs: Date.now(), watched: false };
    this.incidents[i] = rec;
    this.emit('incidentCleared', rec);
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
  private runCheckChain(opts: { evidence: string; deadlineMs: number; stopAt: 'check' | 'heads_up' | 'unlocked'; unlockAfterMs?: number }) {
    const phrases = ['blue river stone', 'quiet amber lane', 'soft copper wave', 'green paper moon'];
    const phrase = phrases[Math.floor(Math.random() * phrases.length)];
    const deadline = Date.now() + opts.deadlineMs;
    this.push({ engine: { ...this.status.engine, escalation: 'check', evidence: opts.evidence } });
    this.emit('escalation', { level: 'check', summary: opts.evidence });
    this.emit('checkRequested', { phrase, deadlineMs: deadline });
    if (opts.stopAt === 'check') return;
    this.later(opts.deadlineMs, () => {
      const ev = `${opts.evidence}; no answer to check-in`;
      this.signal('check_in_missed', 'no answer to "You okay?" within the deadline', 0, { raw: { deadline_s: Math.round(opts.deadlineMs / 1000) } });
      this.push({ engine: { ...this.status.engine, escalation: 'heads_up', evidence: ev } });
      this.emit('escalation', { level: 'heads_up', summary: ev });
      if (opts.stopAt === 'heads_up') return;
      this.later(opts.unlockAfterMs ?? 8_000, () => {
        const ev2 = `${ev}; still no movement`;
        this.push({ engine: { ...this.status.engine, escalation: 'unlocked', evidence: ev2 } });
        this.emit('escalation', { level: 'unlocked', summary: ev2 });
        // Real engine: CallOptionAvailable after 600 s with no response. Mock clock: 10 s.
        this.later(10_000, () => this.emit('callOption', { summary: `${ev2}; 10 min without a response` }));
      });
    });
  }

  /** fall-type scenarios: a possible fall now, then down-after-fall once the metrics have settled (same sequence). */
  private fallSignals() {
    this.setMetricScenario('fall');
    const seq = this.nextSequenceId++;
    // Both stay uncleared until steps resume (or the owner stands down); then the engine logs fall_recovered.
    this.signal('possible_fall', 'free fall, 3.1 g impact, orientation change', 9, { sequenceId: seq, watched: true, raw: { peak_g: 3.1, orientation_change_deg: 74 } });
    this.later(5_000, () => this.signal('down_after_fall', 'still and no touch for 60 s after a fall', -8, { sequenceId: seq, watched: true, raw: { down_s: 60, no_touch_s: 60 } }));
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
          return this.runCheckChain({ evidence: 'mock: fall trace, impact 3.1 g then still', deadlineMs: 9_000, stopAt: 'unlocked', unlockAfterMs: 8_000 });
        case 'drunk': {
          this.setMetricScenario('drunk');
          const seq = this.nextSequenceId++;
          this.signal('stumble', 'one stumble, recovered within 2 s', 2.8, { sequenceId: seq, raw: { jerk_peak: 2.1 } });
          this.signal('unsteady_gait', 'sway +3.4 SD, stride variability +3.2 SD for 30 s of walking', 3.4, { sequenceId: seq, watched: true, raw: { persisted_s: 30 } });
          // A second, independent family (location) makes the engine ask.
          this.later(3_000, () => {
            this.signal('stopped_on_way_home', 'stopped 6 min on the way home, 1.2 km out', 0, { sequenceId: seq, watched: true, raw: { stopped_s: 360 } });
            this.runCheckChain({ evidence: 'mock: unsteady gait, then stopped on the way home', deadlineMs: 9_000, stopAt: 'unlocked', unlockAfterMs: 8_000 });
          });
          return;
        }
        case 'still': {
          this.setMetricScenario('still');
          this.signal('phone_left_behind', 'phone set down and untouched 3 min while away from home', -8, { raw: { still_s: 180, no_touch_s: 180 } });
          return this.runCheckChain({ evidence: 'mock: still trace, no movement, no touch 3 min', deadlineMs: 9_000, stopAt: 'unlocked', unlockAfterMs: 8_000 });
        }
        case 'snatch': {
          const summary = 'mock: jerk in hand, running cadence, separated from group';
          this.setMetricScenario('snatch');
          this.push({ engine: { ...this.status.engine, escalation: 'snatch', placement: 'hand', evidence: summary } });
          this.signal('grab', 'jerk +7 SD in hand, cadence → running within 2 s', 7, { sequenceId: this.nextSequenceId++, watched: true, raw: { jerk_peak: 4.4, phone_unlocked: false, window_s: 120 } });
          this.emit('snatch', { summary, lat: 42.3505, lng: -71.1054 });
          this.emit('escalation', { level: 'snatch', summary });
          return;
        }
        case 'manual-sos':
        case 'sos':
          // Night out, nothing detected: the user holds the button themselves.
          this.setMetricScenario('idle');
          return this.push({ engine: { ...this.status.engine, escalation: 'idle', evidence: 'mock: walking home, nothing unusual' } });
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
