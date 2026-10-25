// §7 live telemetry: a friend's browser subscribes to the subject phone's private Realtime broadcast channel
// `telemetry:{subjectUserId}` (event `tick`, 10 Hz frames, no DB rows) and keeps enough history for the monitor's
// live charts. Nothing here publishes — only the Android phone does (OkHttp WebSocket → Realtime).
// RLS on realtime.messages lets the subject insert and subject + group-mates select, so a non-group-mate
// gets CHANNEL_ERROR on join, never data.
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { IncidentRecord, TelemetryTick } from '@/modules/safety-native';
import { FrameMerger, sampleTimes } from './telemetryFrames';
import { supabase } from './supabase';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './env';
import { isSimId, subscribeSimulated } from './sim';

export { isTelemetryTick, isTelemetryFrame } from './telemetryFrames';

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
  /** Phone-measured round trip phone → Realtime → phone (same clock, no skew); null while the phone is not probing. */
  rttMs: number | null;
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
const COMMAND_JOIN_MS = 8_000;

/** Commands a member's phone understands (TelemetryPublisher.onCommand). Friend actions are checked by the phone
 * against the incident row on the server before it acts. */
export type TelemetryCommand =
  | { cmd: 'reset_incidents' }
  | { cmd: 'friend_marked_safe'; incidentId: string; by: string }
  | { cmd: 'release_location'; incidentId: string; requestId?: string; by: string };

/**
 * Send a command to a member's phone on `telemetry-cmd:{userId}` (migration 0012: the subject or any group-mate may
 * publish, only the phone reads). Resolves to 'ok' when the server accepted it, otherwise the reason.
 *
 * It posts to the batch endpoint `POST /realtime/v1/api/broadcast` itself, not `channel.httpSend()`: httpSend uses the
 * per-topic endpoint, which delivers the message as a binary frame, and the phone's RealtimeSocket only reads text
 * frames, so it dropped every command. The batch endpoint delivers an ordinary JSON broadcast.
 */
export async function sendTelemetryCommand(userId: string, command: TelemetryCommand | TelemetryCommand['cmd']): Promise<string> {
  const payload = typeof command === 'string' ? { cmd: command } : command;
  if (isSimulated(userId)) return 'ok'; // simulated people have no phone to tell
  const topic = `telemetry-cmd:${userId}`;
  // Group-mates may publish on this channel but not subscribe to it (0012), so a websocket join fails for them.
  // The HTTP broadcast endpoint needs only the publish (insert) policy.
  try {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    if (!token) return 'signed out';
    const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic, event: 'command', payload: { ...payload, t: Date.now() }, private: true }] }),
    });
    if (res.status === 202) return 'ok';
    console.warn('telemetry command over HTTP refused; trying the socket', res.status, await res.text().catch(() => ''));
  } catch (e) {
    console.warn('telemetry command over HTTP failed; trying the socket', e);
  }
  try { await supabase.realtime.setAuth(); } catch {}
  const ch = supabase.channel(topic, { config: { private: true, broadcast: { ack: true } } });
  try {
    const joined = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('join timed out'), COMMAND_JOIN_MS);
      ch.subscribe((st, err) => {
        if (st === 'SUBSCRIBED') { clearTimeout(timer); resolve('ok'); }
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') { clearTimeout(timer); resolve(err?.message ?? st.toLowerCase()); }
      });
    });
    if (joined !== 'ok') return joined;
    return await ch.send({ type: 'broadcast', event: 'command', payload: { ...payload, t: Date.now() } });
  } finally {
    void supabase.removeChannel(ch).catch(() => {});
  }
}

// ---- "I'm okay" ------------------------------------------------------------------------------------------
//
// A person can tell their friends they are fine without anything having happened. It rides on the same private
// channel as the phone's telemetry (`telemetry:{me}`, event `okay`): only the subject may publish there (0010), so a
// friend cannot say it on someone's behalf, and the server sees nothing but a timestamp. Display only: it never
// touches the engine, which still decides escalation.

export const OKAY_EVENT = 'okay';
/** How long a manual "I'm okay" is shown for. */
export const OKAY_SHOWN_MS = 30 * 60_000;

function okayPayloadTime(payload: unknown): number | null {
  const t = (payload as { t?: unknown } | undefined)?.t;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
}

/**
 * Publish my "I'm okay" to my group-mates. Uses the subscription this app already holds on my own channel when there
 * is one (the feed subscribes to everyone, me included); otherwise a one-off publish over HTTP. Resolves 'ok' or why not.
 */
export async function sendOkay(userId: string, atMs = Date.now()): Promise<string> {
  const topic = telemetryTopic(userId);
  const payload = { t: atMs, user: userId };
  const mine = supabase.getChannels().find((c) => c.topic === `realtime:${topic}`);
  if (mine && mine.state === 'joined') {
    try { return await mine.send({ type: 'broadcast', event: OKAY_EVENT, payload }); } catch (e) { return e instanceof Error ? e.message : String(e); }
  }
  try { await supabase.realtime.setAuth(); } catch {}
  const ch = mine ?? supabase.channel(topic, { config: { private: true, broadcast: { ack: true } } });
  try {
    const r = await ch.httpSend(OKAY_EVENT, payload);
    return r.success ? 'ok' : (r.error ?? 'rejected');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    if (!mine) void supabase.removeChannel(ch).catch(() => {});
  }
}

/** Record an "I'm okay" locally (my own, which Realtime does not echo back to me) so every screen shows it at once. */
export function markOkay(userId: string, atMs = Date.now()) {
  const e = hub.get(userId);
  if (!e || (e.okayAt != null && atMs <= e.okayAt)) return;
  e.okayAt = atMs;
  for (const l of e.listeners) l.onOkay?.(atMs);
}

// ---- shared subscriptions ------------------------------------------------------------------------------
//
// The map feed and the monitor console both watch the same people, and realtime-js hands back one channel per topic,
// so every subscriber goes through this hub: one source per person (the Realtime channel, or the simulator for people
// without sensors), fanned out to any number of listeners. A listener that joins late gets the newest tick with the
// whole incident log in it, since the stream itself only carries deltas.

type Listener = {
  onTick: (tick: TelemetryTick, receivedAtMs: number) => void;
  onStatus: (s: TelemetryConnection) => void;
  onOkay?: (atMs: number) => void;
  /** the source switched kind (simulated ↔ real): drop everything kept from it, the incident log above all */
  onReset?: () => void;
};
type HubEntry = {
  listeners: Set<Listener>;
  stop: () => void;
  simulated: boolean;
  status: TelemetryConnection | null;
  last: { tick: TelemetryTick; at: number } | null;
  log: Map<number, IncidentRecord>;
  /** when this person last said "I'm okay" by hand (phone ms), if they did */
  okayAt: number | null;
};
const hub = new Map<string, HubEntry>();
let simulatedUsers = new Set<string>();

const isSimulated = (userId: string) => isSimId(userId) || simulatedUsers.has(userId);

function startSource(userId: string, e: HubEntry) {
  e.simulated = isSimulated(userId);
  e.status = null;
  e.last = null;
  e.log.clear();
  const onTick = (tick: TelemetryTick, at: number) => {
    if (tick.events.includes('incident_log_cleared')) e.log.clear();
    for (const r of tick.incidents) e.log.set(r.id, r);
    e.last = { tick, at };
    for (const l of e.listeners) l.onTick(tick, at);
  };
  const onStatus = (s: TelemetryConnection) => {
    e.status = s;
    for (const l of e.listeners) l.onStatus(s);
  };
  const onOkay = (atMs: number) => {
    if (e.okayAt != null && atMs <= e.okayAt) return;
    e.okayAt = atMs;
    for (const l of e.listeners) l.onOkay?.(atMs);
  };
  e.stop = e.simulated ? subscribeSimulated(userId, onTick, onStatus) : openTelemetry(userId, onTick, onStatus, onOkay);
}

/**
 * Which real accounts have no sensors (no phone registered) and so get simulated data. Sources whose kind changes
 * are restarted in place; their listeners stay subscribed.
 */
export function setSimulatedUsers(ids: string[]) {
  const next = new Set(ids);
  const changed = [...hub.keys()].filter((id) => !isSimId(id) && simulatedUsers.has(id) !== next.has(id));
  simulatedUsers = next;
  for (const id of changed) {
    const e = hub.get(id)!;
    e.stop();
    // Made-up incidents must never stay in a real person's log (and the two sources' record ids overlap).
    for (const l of e.listeners) l.onReset?.();
    startSource(id, e);
  }
}
export const isSimulatedUser = isSimulated;

/**
 * Subscribe to one subject's telemetry. `onTick(tick, receivedAtMs)` for every complete tick, `onStatus` for every
 * connection change, `onReset` when the source switches between simulated and real. Shared: see the hub above.
 * Returns an unsubscribe function.
 */
export function subscribeTelemetry(
  userId: string,
  onTick: (tick: TelemetryTick, receivedAtMs: number) => void,
  onStatus: (s: TelemetryConnection) => void,
  onOkay?: (atMs: number) => void,
  onReset?: () => void,
): () => void {
  let e = hub.get(userId);
  if (!e) {
    e = { listeners: new Set(), stop: () => {}, simulated: false, status: null, last: null, log: new Map(), okayAt: null };
    hub.set(userId, e);
    startSource(userId, e);
  } else {
    if (e.status) onStatus({ ...e.status });
    if (e.last) onTick({ ...e.last.tick, incidents: [...e.log.values()], events: [] }, e.last.at);
    if (e.okayAt != null) onOkay?.(e.okayAt);
  }
  const l: Listener = { onTick, onStatus, onOkay, onReset };
  e.listeners.add(l);
  const entry = e;
  return () => {
    entry.listeners.delete(l);
    if (entry.listeners.size === 0 && hub.get(userId) === entry) {
      entry.stop();
      hub.delete(userId);
    }
  };
}

/**
 * One Realtime subscription. `onTick(tick, receivedAtMs)` for every complete tick (v2 frames are merged
 * with the latest state block first), `onStatus` for every connection change (SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT /
 * CLOSED, staleness, retry schedule). Resubscribes with exponential backoff (1 s → 30 s). Returns an unsubscribe function.
 */
function openTelemetry(
  userId: string,
  onTick: (tick: TelemetryTick, receivedAtMs: number) => void,
  onStatus: (s: TelemetryConnection) => void,
  onOkay?: (atMs: number) => void,
): () => void {
  const topic = telemetryTopic(userId);
  const status: TelemetryConnection = { state: 'connecting', subscribedAt: null, lastTickAt: null, latencyMs: null, rttMs: null, ticksPerSec: 0, attempts: 0, nextRetryAt: null, error: null };
  const arrivals: number[] = [];
  const merger = new FrameMerger();
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
    merger.reset();
    const ch = supabase.channel(topic, { config: { private: true, broadcast: { ack: false } } });
    channel = ch;
    ch.on('broadcast', { event: 'tick' }, (msg: { payload?: unknown }) => {
      if (stopped || ch !== channel) return;
      const tick = merger.merge(msg.payload);
      if (!tick) return;
      const now = Date.now();
      const raw = Math.max(0, now - tick.t);
      latency = latency == null ? raw : latency * 0.7 + raw * 0.3;
      status.latencyMs = Math.round(latency);
      status.rttMs = tick.rttMs ?? status.rttMs;
      status.lastTickAt = now;
      arrivals.push(now);
      pruneArrivals(now);
      status.ticksPerSec = arrivals.length / (RATE_WINDOW_MS / 1000);
      status.state = 'live';
      status.error = null;
      onTick(tick, now);
      emit();
    });
    ch.on('broadcast', { event: OKAY_EVENT }, (msg: { payload?: unknown }) => {
      if (stopped || ch !== channel) return;
      const t = okayPayloadTime(msg.payload);
      if (t != null) onOkay?.(t);
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
/** Smallest display delay behind wall-clock (ms); the renderers add 1.5 frame intervals + the observed jitter. */
export const MIN_DISPLAY_DELAY_MS = 120;

export type TrendPoint = {
  t: number; // phone unix ms
  at: number; // local arrival ms
  listening: boolean;
  sd: Record<string, number>; // per-band sd_distance
  inBand: Record<string, boolean>;
};
export type EngineEventEntry = { key: string; t: number; seq: number; name: string };
export type TickDelta = { newIncidents: IncidentRecord[]; events: string[] };

/**
 * Mutable history for one subject, read directly by the canvas renderers on every animation frame (no
 * React state in the hot path). accel/gyro magnitudes sit in fixed Float32 rings with the phone-clock time of each
 * sample beside them, so the waveform is drawn on sensor time (arrival jitter and batching cannot stretch or
 * compress it); trends are pruned by age.
 */
export class TelemetryBuffers {
  readonly accel = new Float32Array(SAMPLE_RING_CAPACITY);
  readonly gyro = new Float32Array(SAMPLE_RING_CAPACITY);
  /** phone unix ms of each sample */
  readonly times = new Float64Array(SAMPLE_RING_CAPACITY);
  /** next write index */
  head = 0;
  /** samples stored (≤ capacity) */
  count = 0;
  sampleHz = 50;
  /** local ms when the newest frame arrived */
  lastTickAt = 0;
  /** EMA of the inter-frame interval, for the renderers' display delay */
  tickIntervalMs = 100;
  /**
   * local arrival − phone sample time, tracked as a fast-down / slow-up floor: ≈ clock skew + the quickest transport
   * we have seen. Adding it to a phone timestamp gives the local time at which that sample could first be on screen.
   */
  skewMs: number | null = null;
  /** EMA of how far above that floor frames arrive (ms); the display delay covers it so the trace never stalls. */
  jitterMs = 0;
  tick: TelemetryTick | null = null;
  trend: TrendPoint[] = [];
  events: EngineEventEntry[] = [];
  readonly incidents = new Map<number, IncidentRecord>();
  /** `incidentCount` from the newest tick: the phone's live log size */
  incidentCountOnPhone = 0;

  /** Forget every incident record and engine event held here (the phone is told to reset its log separately). */
  clearIncidents() {
    this.incidents.clear();
    this.events = [];
    this.incidentCountOnPhone = 0;
  }
  ticks = 0;
  private lastSeq: number | null = null;
  dropped = 0; // sequence gaps seen

  reset() {
    this.head = 0; this.count = 0; this.lastTickAt = 0; this.tickIntervalMs = 100; this.skewMs = null; this.jitterMs = 0; this.tick = null;
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
    if (n > 0) {
      const raw = receivedAt - tick.st;
      if (this.skewMs == null || raw < this.skewMs) this.skewMs = raw;
      else { this.skewMs = this.skewMs * 0.995 + raw * 0.005; this.jitterMs = this.jitterMs * 0.9 + (raw - this.skewMs) * 0.1; }
      const ts = sampleTimes(n, tick.st, this.sampleHz);
      for (let i = tick.accel.length - n, j = 0; i < tick.accel.length; i++, j++) {
        this.accel[this.head] = tick.accel[i] ?? 0;
        this.gyro[this.head] = tick.gyro[i] ?? 0;
        this.times[this.head] = ts[j];
        this.head = (this.head + 1) % SAMPLE_RING_CAPACITY;
      }
      this.count = Math.min(SAMPLE_RING_CAPACITY, this.count + n);
    }

    const m = tick.metrics;
    const sd: Record<string, number> = {};
    const inBand: Record<string, boolean> = {};
    for (const b of m.bands) { sd[b.name] = b.sdDistance; inBand[b.name] = b.inBand; }
    this.trend.push({ t: tick.t, at: receivedAt, listening: tick.listening, sd, inBand });
    const cutoff = receivedAt - TREND_SECONDS * 1000;
    let drop = 0;
    while (drop < this.trend.length && this.trend[drop].at < cutoff) drop++;
    if (drop) this.trend.splice(0, drop);

    // The phone's log was reset: drop the records and events we hold before taking this frame's.
    if (tick.events.includes('incident_log_cleared')) { this.incidents.clear(); this.events = []; }
    // Upsert by id: records are re-sent when they clear / are acknowledged; only a first sighting counts as new.
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

  private idx(k: number) { return (this.head - 1 - k + SAMPLE_RING_CAPACITY * 2) % SAMPLE_RING_CAPACITY; }

  /** k-th newest sample (k = 0 is the newest). Undefined behaviour for k ≥ count; callers clamp. */
  sample(which: 'accel' | 'gyro', k: number): number {
    return (which === 'accel' ? this.accel : this.gyro)[this.idx(k)];
  }

  /** Local-clock time at which the k-th newest sample belongs on screen (phone time + skew floor). */
  sampleTimeLocal(k: number): number {
    return this.times[this.idx(k)] + (this.skewMs ?? 0);
  }

  /** How far behind wall-clock the renderers draw: 1.5 frame intervals plus twice the observed jitter, never less than MIN_DISPLAY_DELAY_MS. */
  displayDelayMs(): number {
    return Math.max(MIN_DISPLAY_DELAY_MS, this.tickIntervalMs * 1.5 + this.jitterMs * 2);
  }

  /** Incident log, newest first. */
  incidentList(): IncidentRecord[] {
    return [...this.incidents.values()].sort((a, b) => b.tMs - a.tMs || b.id - a.id);
  }
}

export const latencyText = (ms: number | null) => (ms == null ? '—' : `~${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`);
