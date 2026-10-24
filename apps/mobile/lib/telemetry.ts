// §7 live telemetry: a friend's browser subscribes to the subject phone's private Realtime broadcast channel
// `telemetry:{subjectUserId}` (event `tick`, 4 Hz, no DB rows) and keeps enough history for the monitor's
// live charts. Nothing here publishes — only the Android phone does (OkHttp → /realtime/v1/api/broadcast).
// RLS on realtime.messages lets the subject insert and subject + group-mates select, so a non-group-mate
// gets CHANNEL_ERROR on join, never data.
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { IncidentRecord, TelemetryTick } from '@/modules/safety-native';
import { supabase } from './supabase';

// ---- connection status -----------------------------------------------------------------------------

export type TelemetryConnState =
  | 'connecting' // channel join in flight (or auth refresh before it)
  | 'subscribed' // joined, no tick yet
  | 'live' // ticks arriving
  | 'stale' // joined but no tick for > STALE_MS
  | 'error' // CHANNEL_ERROR / TIMED_OUT, retry scheduled
  | 'closed'; // server closed the channel, retry scheduled

export type TelemetryConnection = {
  state: TelemetryConnState;
  subscribedAt: number | null; // local ms of the last SUBSCRIBED
  lastTickAt: number | null; // local ms of the last tick
  /** Smoothed max(0, Date.now() - tick.t). Clock skew between phone and browser makes this approximate ("~N ms"). */
  latencyMs: number | null;
  ticksPerSec: number;
  attempts: number; // consecutive resubscribe attempts
  nextRetryAt: number | null;
  error: string | null;
};

export const STALE_MS = 3_000;
/** After this long subscribed without a tick, the monitor hints that the phone is not streaming. */
export const NO_STREAM_HINT_MS = 10_000;
const RATE_WINDOW_MS = 3_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export const telemetryTopic = (userId: string) => `telemetry:${userId}`;
/** realtime-js hands back the existing channel for a duplicate topic, so a resubscribe must wait for the old one to leave. */
const pendingRemovals = new Map<string, Promise<unknown>>();

/** Runtime guard for the broadcast payload; anything that is not a v1 tick is dropped. */
export function isTelemetryTick(p: unknown): p is TelemetryTick {
  if (!p || typeof p !== 'object') return false;
  const t = p as Partial<TelemetryTick>;
  return t.v === 1 && typeof t.t === 'number' && typeof t.seq === 'number' && Array.isArray(t.accel) && Array.isArray(t.gyro)
    && !!t.metrics && Array.isArray(t.metrics.bands) && Array.isArray(t.incidents) && Array.isArray(t.events);
}

/**
 * Subscribe to one subject's telemetry. `onTick(tick, receivedAtMs)` for every valid tick, `onStatus` for every
 * connection change (SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED, staleness, retry schedule). Resubscribes
 * with exponential backoff (1 s → 30 s). Returns an unsubscribe function.
 */
export function subscribeTelemetry(
  userId: string,
  onTick: (tick: TelemetryTick, receivedAtMs: number) => void,
  onStatus: (s: TelemetryConnection) => void,
): () => void {
  const topic = telemetryTopic(userId);
  const status: TelemetryConnection = { state: 'connecting', subscribedAt: null, lastTickAt: null, latencyMs: null, ticksPerSec: 0, attempts: 0, nextRetryAt: null, error: null };
  const arrivals: number[] = [];
  let channel: RealtimeChannel | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let latency: number | null = null;

  const emit = () => { if (!stopped) onStatus({ ...status }); };
  const pruneArrivals = (now: number) => { while (arrivals.length && arrivals[0] < now - RATE_WINDOW_MS) arrivals.shift(); };
  const dropChannel = () => {
    const ch = channel;
    channel = null;
    if (!ch) return;
    const p = supabase.removeChannel(ch).catch(() => {}).finally(() => { if (pendingRemovals.get(topic) === p) pendingRemovals.delete(topic); });
    pendingRemovals.set(topic, p);
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(status.attempts, 5));
    status.attempts += 1;
    status.nextRetryAt = Date.now() + delay;
    emit();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      dropChannel();
      void connect();
    }, delay);
  };

  const connect = async () => {
    if (stopped) return;
    status.state = 'connecting';
    status.nextRetryAt = null;
    emit();
    // Private channels are authorised by the user JWT on the socket; make sure the current one is attached
    // (supabase-js does this on auth events, but a fresh page can subscribe before INITIAL_SESSION lands).
    try { await pendingRemovals.get(topic); } catch {}
    try { await supabase.realtime.setAuth(); } catch {}
    if (stopped) return;
    const ch = supabase.channel(topic, { config: { private: true, broadcast: { ack: false } } });
    channel = ch;
    ch.on('broadcast', { event: 'tick' }, (msg: { payload?: unknown }) => {
      const tick = msg.payload;
      if (stopped || ch !== channel || !isTelemetryTick(tick)) return;
      const now = Date.now();
      const raw = Math.max(0, now - tick.t);
      latency = latency == null ? raw : latency * 0.7 + raw * 0.3;
      status.latencyMs = Math.round(latency);
      status.lastTickAt = now;
      arrivals.push(now);
      pruneArrivals(now);
      status.ticksPerSec = arrivals.length / (RATE_WINDOW_MS / 1000);
      status.state = 'live';
      status.error = null;
      onTick(tick, now);
      emit();
    });
    ch.subscribe((st, err) => {
      if (stopped || ch !== channel) return;
      if (st === 'SUBSCRIBED') {
        status.attempts = 0;
        status.subscribedAt = Date.now();
        status.state = status.lastTickAt && Date.now() - status.lastTickAt < STALE_MS ? 'live' : 'subscribed';
        status.error = null;
        emit();
        return;
      }
      status.state = st === 'CLOSED' ? 'closed' : 'error';
      status.error = err?.message ?? (st === 'TIMED_OUT' ? 'join timed out' : st === 'CLOSED' ? 'channel closed' : 'channel error (not a group-mate, or realtime unavailable)');
      emit();
      scheduleRetry();
    });
  };

  // Watchdog: staleness + rate decay between ticks.
  const watchdog = setInterval(() => {
    const now = Date.now();
    const before = `${status.state}|${status.ticksPerSec}`;
    pruneArrivals(now);
    status.ticksPerSec = arrivals.length / (RATE_WINDOW_MS / 1000);
    if ((status.state === 'live' || status.state === 'subscribed') && status.lastTickAt && now - status.lastTickAt > STALE_MS) status.state = 'stale';
    if (`${status.state}|${status.ticksPerSec}` !== before) emit();
  }, 1_000);

  void connect();
  return () => {
    stopped = true;
    clearInterval(watchdog);
    if (retryTimer) clearTimeout(retryTimer);
    dropChannel();
  };
}

// ---- history buffers --------------------------------------------------------------------------------

export const SAMPLE_RING_SECONDS = 60;
export const SAMPLE_RING_CAPACITY = SAMPLE_RING_SECONDS * 100; // headroom up to 100 Hz
export const TREND_SECONDS = 300;
export const INCIDENT_TTL_MS = 8 * 3_600_000;
export const EVENT_HISTORY = 50;

export type TrendPoint = {
  t: number; // phone unix ms
  at: number; // local arrival ms
  pDanger: number;
  p: [number, number, number, number]; // normal, impaired, incident, unresponsive
  sd: Record<string, number>; // per-band sd_distance
  inBand: Record<string, boolean>;
};
export type EngineEventEntry = { key: string; t: number; seq: number; name: string };
export type TickDelta = { newIncidents: IncidentRecord[]; events: string[] };

/**
 * Mutable history for one subject, read directly by the canvas renderers on every animation frame (no
 * React state in the hot path). accel/gyro magnitudes sit in fixed Float32 rings; trends are pruned by age.
 */
export class TelemetryBuffers {
  readonly accel = new Float32Array(SAMPLE_RING_CAPACITY);
  readonly gyro = new Float32Array(SAMPLE_RING_CAPACITY);
  /** next write index */
  head = 0;
  /** samples stored (≤ capacity) */
  count = 0;
  sampleHz = 50;
  /** local ms when the newest sample arrived (the stream's right edge) */
  lastTickAt = 0;
  /** EMA of the inter-tick interval, for the renderers' display delay */
  tickIntervalMs = 250;
  tick: TelemetryTick | null = null;
  trend: TrendPoint[] = [];
  events: EngineEventEntry[] = [];
  readonly incidents = new Map<number, IncidentRecord>();
  /** `incidentCount` from the newest tick: the phone's live log size */
  incidentCountOnPhone = 0;
  ticks = 0;
  private lastSeq: number | null = null;
  dropped = 0; // sequence gaps seen

  reset() {
    this.head = 0; this.count = 0; this.lastTickAt = 0; this.tickIntervalMs = 250; this.tick = null;
    this.trend = []; this.events = []; this.incidents.clear(); this.incidentCountOnPhone = 0; this.ticks = 0; this.lastSeq = null; this.dropped = 0;
  }

  /** Merge one tick. Returns what is new (for sound / flashes). */
  push(tick: TelemetryTick, receivedAt: number): TickDelta {
    if (this.lastTickAt) this.tickIntervalMs = this.tickIntervalMs * 0.8 + Math.min(5_000, receivedAt - this.lastTickAt) * 0.2;
    if (this.lastSeq != null && tick.seq > this.lastSeq + 1) this.dropped += tick.seq - this.lastSeq - 1;
    this.lastSeq = tick.seq;
    this.lastTickAt = receivedAt;
    this.ticks += 1;
    this.tick = tick;
    if (tick.sampleHz > 0) this.sampleHz = tick.sampleHz;
    const n = Math.min(tick.accel.length, SAMPLE_RING_CAPACITY);
    for (let i = tick.accel.length - n; i < tick.accel.length; i++) {
      this.accel[this.head] = tick.accel[i] ?? 0;
      this.gyro[this.head] = tick.gyro[i] ?? 0;
      this.head = (this.head + 1) % SAMPLE_RING_CAPACITY;
    }
    this.count = Math.min(SAMPLE_RING_CAPACITY, this.count + n);

    const m = tick.metrics;
    const sd: Record<string, number> = {};
    const inBand: Record<string, boolean> = {};
    for (const b of m.bands) { sd[b.name] = b.sdDistance; inBand[b.name] = b.inBand; }
    this.trend.push({ t: tick.t, at: receivedAt, pDanger: tick.pDanger, p: [m.pNormal, m.pImpaired, m.pIncident, m.pUnresponsive], sd, inBand });
    const cutoff = receivedAt - TREND_SECONDS * 1000;
    let drop = 0;
    while (drop < this.trend.length && this.trend[drop].at < cutoff) drop++;
    if (drop) this.trend.splice(0, drop);

    const newIncidents: IncidentRecord[] = [];
    for (const r of tick.incidents) {
      const prev = this.incidents.get(r.id);
      if (!prev || prev.tMs !== r.tMs) newIncidents.push(r);
      this.incidents.set(r.id, r);
    }
    const expire = tick.t - INCIDENT_TTL_MS;
    for (const [id, r] of this.incidents) if (r.tMs < expire) this.incidents.delete(id);
    this.incidentCountOnPhone = tick.incidentCount;

    for (const name of tick.events) this.events.push({ key: `${tick.seq}:${name}:${this.events.length}`, t: tick.t, seq: tick.seq, name });
    if (this.events.length > EVENT_HISTORY) this.events.splice(0, this.events.length - EVENT_HISTORY);
    return { newIncidents, events: tick.events.slice() };
  }

  /** k-th newest sample (k = 0 is the newest). Undefined behaviour for k ≥ count; callers clamp. */
  sample(which: 'accel' | 'gyro', k: number): number {
    const arr = which === 'accel' ? this.accel : this.gyro;
    return arr[(this.head - 1 - k + SAMPLE_RING_CAPACITY * 2) % SAMPLE_RING_CAPACITY];
  }

  /** Incident log, newest first. */
  incidentList(): IncidentRecord[] {
    return [...this.incidents.values()].sort((a, b) => b.tMs - a.tMs || b.id - a.id);
  }
}

export const latencyText = (ms: number | null) => (ms == null ? '—' : `~${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`);
