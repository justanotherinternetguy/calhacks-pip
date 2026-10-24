// Turns a subject's incident log into a structured, chronological picture for the monitor's AI read: every
// incident with its time, gap and duration, bursts of incidents close together, incidents active at the same time,
// and known ordered chains (with their timing windows, including chains that are only part-way through).
//
// Advisory only: this shapes what the language model reads. It never opens incidents or escalates; detection and
// escalation stay in the Rust engine. Like the prompt, it uses only kinds, tiers, times and states: no
// measurements, summaries or raw sensor JSON.
//
// Pure and dependency-free (type imports only) so `node --test` can run it directly.
import type { EscalationLevel, IncidentKind, IncidentRecord, IncidentTier } from '@/modules/safety-native';

export type Family = 'fall' | 'gait' | 'phone' | 'handling' | 'location' | 'device' | 'check_in' | 'audio';
/** How a matched chain bears on the read. `reassuring` chains point to the innocent explanation. */
export type Concern = 'reassuring' | 'moderate' | 'high' | 'critical';

/** Same families as safety_core::IncidentFamily. */
export const FAMILY: Record<IncidentKind, Family> = {
  phone_drop: 'fall', possible_fall: 'fall', fall_recovered: 'fall', down_after_fall: 'fall', hard_impact: 'fall',
  unsteady_gait: 'gait', stumble: 'gait', repeated_stumbles: 'gait', slowed_walk: 'gait',
  phone_left_behind: 'phone', grab: 'handling',
  separated: 'location', stopped_on_way_home: 'location', in_vehicle: 'location',
  battery_critical: 'device', check_in_missed: 'check_in', typing_off: 'check_in',
  scream_shout: 'audio', snoring_while_down: 'audio',
};

export type TimelineIncident = {
  id: number;
  kind: IncidentKind;
  tier: IncidentTier;
  family: Family;
  /** phone clock, HH:MM:SS */
  at: string;
  /** seconds before now */
  ago_s: number;
  /** seconds since the previous incident started (null for the first) */
  gap_s: number | null;
  /** seconds until it cleared, or so far if still active */
  lasted_s: number;
  active: boolean;
  /** the subject answered a check-in while it was open */
  answered: boolean;
  /** engine episode (check-in / grab / SOS sequence) */
  episode: number | null;
  /** burst number when it is part of a burst (see Burst) */
  burst: number | null;
  /** started after a grab: the phone may no longer be with the subject */
  after_grab?: true;
};

/** Incidents that each started within BURST_GAP_S of the previous one. */
export type Burst = {
  burst: number;
  ids: number[];
  kinds: IncidentKind[];
  from: string;
  to: string;
  span_s: number;
  ago_s: number;
  families: Family[];
  worst_tier: IncidentTier;
  active: number;
};

/** Two incidents that were open at the same time. */
export type Overlap = { ids: [number, number]; kinds: [IncidentKind, IncidentKind]; overlap_s: number; still_both_active: boolean };

export type ChainMatch = {
  chain: string;
  meaning: string;
  concern: Concern;
  ids: number[];
  kinds: IncidentKind[];
  /** seconds between consecutive steps */
  gaps_s: number[];
  span_s: number;
  /** seconds since the last matched step */
  ago_s: number;
  /** "matched/total" */
  steps: string;
  complete: boolean;
  /** part-way chain still inside the window for its next step */
  next?: { kinds: IncidentKind[]; window_left_s: number };
  /** part-way chain whose next-step window passed without it */
  stalled?: true;
  active: boolean;
  answered: boolean;
  late_night: boolean;
};

export type Timeline = {
  now: { at: string; local_hour: number; late_night: boolean };
  escalation: EscalationLevel | 'unknown';
  /** seconds left on a pending "You okay?" check-in, null when none is pending */
  check_in_pending_s: number | null;
  totals: {
    incidents: number;
    active: number;
    by_tier: Record<IncidentTier, number>;
    active_families: Family[];
    /** danger incidents still active and not answered */
    unanswered_danger: number;
  };
  since_last_incident_s: number | null;
  /** when nothing above context tier is active: seconds since the last one cleared */
  calm_for_s: number | null;
  /** weighted load (watch 1, danger 3) of incidents that started in each window */
  trend: { last_15_min: number; prev_15_min: number; direction: 'rising' | 'steady' | 'easing' };
  incidents: TimelineIncident[];
  bursts: Burst[];
  overlaps: Overlap[];
  chains: ChainMatch[];
  escalation_steps: { at: string; ago_s: number; step: string }[];
  /** older incidents left out to keep the prompt small */
  omitted?: number;
};

export type TimelineInput = {
  records: IncidentRecord[];
  /** phone clock, unix ms */
  nowMs: number;
  escalation?: EscalationLevel | null;
  checkDeadlineMs?: number | null;
  /** escalation steps (check_requested, heads_up, …), any order */
  events?: { t: number; name: string }[];
  maxIncidents?: number;
};

// ---- tunables ----
export const BURST_GAP_S = 300;
/** Same night window the engine uses for full-rate sensing (model-v1.toml [sampling]). */
const NIGHT_START_H = 21;
const NIGHT_END_H = 6;
const AFTER_GRAB_S = 1800;
const MAX_OVERLAPS = 12;
const MAX_CHAINS = 12;
const MAX_PER_CHAIN = 2;
const TIER_WEIGHT: Record<IncidentTier, number> = { context: 0, watch: 1, danger: 3 };
const TIER_RANK: Record<IncidentTier, number> = { context: 0, watch: 1, danger: 2 };
const CONCERN_RANK: Record<Concern, number> = { reassuring: 0, moderate: 1, high: 2, critical: 3 };

// ---- chain library ----
type Step = { kinds: IncidentKind[]; /** seconds after the previous step started; ignored on the first */ within_s: number };
export type ChainDef = {
  name: string;
  meaning: string;
  steps: Step[];
  /** shortest match worth reporting (default: every step) */
  min_steps?: number;
  /** one value, or one per number of matched steps (index = matched − 1) */
  concern: Concern | Concern[];
  /** reject the match when one of these starts within within_s after the first step */
  unless?: { kinds: IncidentKind[]; within_s: number };
  /** reject unless nothing above context tier happened within this many seconds either side (and that long has passed) */
  isolated_s?: number;
};

const IMPAIRED: IncidentKind[] = ['unsteady_gait', 'slowed_walk', 'repeated_stumbles'];
const FALL: IncidentKind[] = ['possible_fall', 'hard_impact'];

export const CHAINS: ChainDef[] = [
  {
    name: 'violent_contact',
    meaning: 'an impact or grab, then a scream within two minutes: consistent with an assault or robbery',
    steps: [{ kinds: ['hard_impact', 'grab'], within_s: 0 }, { kinds: ['scream_shout'], within_s: 120 }],
    concern: 'high',
  },
  {
    name: 'scream_then_fall',
    meaning: 'a scream, then a fall or impact: consistent with being attacked, or a panicked fall',
    steps: [{ kinds: ['scream_shout'], within_s: 0 }, { kinds: ['possible_fall', 'hard_impact', 'down_after_fall'], within_s: 180 }],
    concern: 'high',
  },
  {
    name: 'down_unresponsive',
    meaning: 'a fall, still down, no answer to the check-in, then snoring-like breathing: consistent with losing consciousness',
    steps: [
      { kinds: FALL, within_s: 0 },
      { kinds: ['down_after_fall'], within_s: 180 },
      { kinds: ['check_in_missed'], within_s: 900 },
      { kinds: ['snoring_while_down'], within_s: 1200 },
    ],
    min_steps: 2,
    concern: ['moderate', 'high', 'critical', 'critical'],
  },
  {
    name: 'hurt_then_unanswered',
    meaning: 'an impact or scream, then no answer to the check-in: consistent with being hurt or not free to answer',
    steps: [{ kinds: ['hard_impact', 'scream_shout'], within_s: 0 }, { kinds: ['check_in_missed'], within_s: 900 }],
    concern: 'high',
  },
  {
    name: 'impaired_then_hurt',
    meaning: 'impaired walking, then a fall or impact (then still down): consistent with heavy intoxication or drugging',
    steps: [{ kinds: IMPAIRED, within_s: 0 }, { kinds: FALL, within_s: 1200 }, { kinds: ['down_after_fall'], within_s: 180 }],
    min_steps: 2,
    concern: ['moderate', 'moderate', 'high'],
  },
  {
    name: 'led_away',
    meaning: 'impaired walking, then apart from friends, then in a vehicle or stopped somewhere: consistent with being led away while impaired (possible drugging), or with heading home alone drunk',
    steps: [
      { kinds: IMPAIRED, within_s: 0 },
      { kinds: ['separated'], within_s: 2700 },
      { kinds: ['in_vehicle', 'stopped_on_way_home'], within_s: 1800 },
    ],
    min_steps: 2,
    concern: ['moderate', 'moderate', 'high'],
  },
  {
    name: 'impaired_then_moved',
    meaning: 'impaired walking, then in a vehicle or stopped on the way home: consistent with a ride home, or with being taken somewhere while impaired',
    steps: [{ kinds: IMPAIRED, within_s: 0 }, { kinds: ['in_vehicle', 'stopped_on_way_home'], within_s: 2700 }],
    concern: 'moderate',
  },
  {
    name: 'separated_then_stranded',
    meaning: 'apart from friends, then stopped, in a vehicle, phone left or battery dying: consistent with being alone and harder to reach',
    steps: [{ kinds: ['separated'], within_s: 0 }, { kinds: ['stopped_on_way_home', 'in_vehicle', 'phone_left_behind', 'battery_critical'], within_s: 3600 }],
    concern: 'moderate',
  },
  {
    name: 'grab_getaway',
    meaning: 'the phone was grabbed, then moved away from the friends: consistent with a thief leaving with it (the subject may be unhurt but without a phone)',
    steps: [{ kinds: ['grab'], within_s: 0 }, { kinds: ['separated', 'in_vehicle'], within_s: 600 }],
    concern: 'high',
  },
  {
    name: 'impaired_check_in',
    meaning: 'impaired or hurt, then a check-in answer that did not match their typing: consistent with being impaired, or someone else answering',
    steps: [{ kinds: [...IMPAIRED, ...FALL], within_s: 0 }, { kinds: ['typing_off'], within_s: 3600 }],
    concern: 'moderate',
  },
  {
    name: 'recovered_fall',
    meaning: 'a fall or impact, then up and walking again, with no scream, grab or missed check-in after: consistent with a slip they walked off',
    steps: [{ kinds: FALL, within_s: 0 }, { kinds: ['fall_recovered'], within_s: 300 }],
    unless: { kinds: ['scream_shout', 'check_in_missed', 'grab'], within_s: 600 },
    concern: 'reassuring',
  },
  {
    name: 'lone_drop',
    meaning: 'the phone fell on its own with nothing else around it: consistent with a dropped phone',
    steps: [{ kinds: ['phone_drop'], within_s: 0 }],
    isolated_s: 600,
    concern: 'reassuring',
  },
];

// ---- helpers ----
const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));
const isLate = (ms: number) => {
  const h = new Date(ms).getHours();
  return h >= NIGHT_START_H || h < NIGHT_END_H;
};
const endOf = (r: IncidentRecord, nowMs: number) => (r.clearedMs > 0 ? r.clearedMs : nowMs);
const concernFor = (def: ChainDef, matched: number): Concern =>
  Array.isArray(def.concern) ? def.concern[Math.min(matched, def.concern.length) - 1] : def.concern;

/** Longest ordered match of `def` starting at incident `anchor` (ties: the tighter one). Indices into `recs`. */
function longestFrom(def: ChainDef, recs: IncidentRecord[], anchor: number): number[] {
  let best: number[] = [anchor];
  const walk = (path: number[]) => {
    const step = def.steps[path.length];
    if (!step) return;
    const last = recs[path[path.length - 1]];
    for (let j = path[path.length - 1] + 1; j < recs.length; j++) {
      const r = recs[j];
      if (r.tMs - last.tMs > step.within_s * 1000) break;
      if (!step.kinds.includes(r.kind)) continue;
      const next = [...path, j];
      if (next.length > best.length) best = next;
      walk(next);
    }
  };
  walk([anchor]);
  return best;
}

function matchChain(def: ChainDef, recs: IncidentRecord[], nowMs: number): ChainMatch[] {
  const min = def.min_steps ?? def.steps.length;
  const found: number[][] = [];
  recs.forEach((r, i) => {
    if (!def.steps[0].kinds.includes(r.kind)) return;
    const path = longestFrom(def, recs, i);
    if (path.length < min) return;
    const first = recs[path[0]];
    if (def.unless) {
      const { kinds, within_s } = def.unless;
      if (recs.some((o) => kinds.includes(o.kind) && o.tMs >= first.tMs && o.tMs - first.tMs <= within_s * 1000)) return;
    }
    if (def.isolated_s != null) {
      const w = def.isolated_s * 1000;
      if (nowMs - first.tMs < w) return; // too early to call it isolated
      if (recs.some((o) => !path.includes(recs.indexOf(o)) && o.tier !== 'context' && Math.abs(o.tMs - first.tMs) <= w)) return;
    }
    found.push(path);
  });

  // Several anchors can reach the same later steps (three unsteady-gait incidents, then one separation): keep the
  // latest anchor for each tail. Then drop matches contained in a longer one.
  const byTail = new Map<string, number[]>();
  for (const p of found) {
    const key = p.length > 1 ? p.slice(1).join(',') : String(p[0]);
    const prev = byTail.get(key);
    if (!prev || p[0] > prev[0]) byTail.set(key, p);
  }
  const paths = [...byTail.values()];
  const kept = paths.filter((p) => !paths.some((q) => q !== p && q.length > p.length && p.every((i) => q.includes(i))));

  return kept.map((p): ChainMatch => {
    const rs = p.map((i) => recs[i]);
    const first = rs[0];
    const last = rs[rs.length - 1];
    const complete = p.length === def.steps.length;
    const m: ChainMatch = {
      chain: def.name,
      meaning: def.meaning,
      concern: concernFor(def, p.length),
      ids: rs.map((r) => r.id),
      kinds: rs.map((r) => r.kind),
      gaps_s: rs.slice(1).map((r, k) => secs(r.tMs - rs[k].tMs)),
      span_s: secs(last.tMs - first.tMs),
      ago_s: secs(nowMs - last.tMs),
      steps: `${p.length}/${def.steps.length}`,
      complete,
      active: rs.some((r) => r.clearedMs === 0),
      answered: rs.every((r) => r.acknowledged),
      late_night: isLate(first.tMs),
    };
    if (!complete) {
      const step = def.steps[p.length];
      const left = step.within_s - secs(nowMs - last.tMs);
      if (left > 0) m.next = { kinds: step.kinds, window_left_s: left };
      else m.stalled = true;
    }
    return m;
  });
}

/** Every chain match, newest first; a match contained in a longer match of equal or higher concern is dropped. */
export function matchChains(recs: IncidentRecord[], nowMs: number, defs: ChainDef[] = CHAINS): ChainMatch[] {
  const all = defs.flatMap((d) => matchChain(d, recs, nowMs).sort((a, b) => a.ago_s - b.ago_s).slice(0, MAX_PER_CHAIN));
  const kept = all.filter(
    (m) => !all.some((o) => o !== m && o.ids.length > m.ids.length && CONCERN_RANK[o.concern] >= CONCERN_RANK[m.concern] && m.ids.every((id) => o.ids.includes(id))),
  );
  return kept.sort((a, b) => CONCERN_RANK[b.concern] - CONCERN_RANK[a.concern] || a.ago_s - b.ago_s).slice(0, MAX_CHAINS);
}

export function buildTimeline(input: TimelineInput): Timeline {
  const { nowMs } = input;
  const max = input.maxIncidents ?? 40;
  const sorted = [...input.records].sort((a, b) => a.tMs - b.tMs || a.id - b.id);
  const recs = sorted.slice(-max);

  // bursts
  const burstOf = new Map<number, number>();
  const groups: IncidentRecord[][] = [];
  for (const r of recs) {
    const g = groups[groups.length - 1];
    if (g && r.tMs - g[g.length - 1].tMs <= BURST_GAP_S * 1000) g.push(r);
    else groups.push([r]);
  }
  const bursts: Burst[] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    const n = bursts.length + 1;
    g.forEach((r) => burstOf.set(r.id, n));
    const first = g[0];
    const last = g[g.length - 1];
    bursts.push({
      burst: n,
      ids: g.map((r) => r.id),
      kinds: g.map((r) => r.kind),
      from: clock(first.tMs),
      to: clock(last.tMs),
      span_s: secs(last.tMs - first.tMs),
      ago_s: secs(nowMs - last.tMs),
      families: [...new Set(g.map((r) => FAMILY[r.kind]))],
      worst_tier: g.reduce<IncidentTier>((w, r) => (TIER_RANK[r.tier] > TIER_RANK[w] ? r.tier : w), 'context'),
      active: g.filter((r) => r.clearedMs === 0).length,
    });
  }

  const grabs = recs.filter((r) => r.kind === 'grab').map((r) => r.tMs);
  const incidents = recs.map((r, i): TimelineIncident => {
    const inc: TimelineIncident = {
      id: r.id,
      kind: r.kind,
      tier: r.tier,
      family: FAMILY[r.kind],
      at: clock(r.tMs),
      ago_s: secs(nowMs - r.tMs),
      gap_s: i > 0 ? secs(r.tMs - recs[i - 1].tMs) : null,
      lasted_s: secs(endOf(r, nowMs) - r.tMs),
      active: r.clearedMs === 0,
      answered: r.acknowledged,
      episode: r.sequenceId > 0 ? r.sequenceId : null,
      burst: burstOf.get(r.id) ?? null,
    };
    if (r.kind !== 'grab' && grabs.some((g) => r.tMs > g && r.tMs - g <= AFTER_GRAB_S * 1000)) inc.after_grab = true;
    return inc;
  });

  // overlaps (above context tier, different kinds), newest first
  const notable = recs.filter((r) => r.tier !== 'context');
  const overlaps: Overlap[] = [];
  for (let i = 0; i < notable.length; i++) {
    for (let j = i + 1; j < notable.length; j++) {
      const a = notable[i];
      const b = notable[j];
      if (a.kind === b.kind) continue;
      const ms = Math.min(endOf(a, nowMs), endOf(b, nowMs)) - Math.max(a.tMs, b.tMs);
      if (ms < 1000) continue;
      overlaps.push({ ids: [a.id, b.id], kinds: [a.kind, b.kind], overlap_s: secs(ms), still_both_active: a.clearedMs === 0 && b.clearedMs === 0 });
    }
  }
  overlaps.sort((x, y) => Number(y.still_both_active) - Number(x.still_both_active) || y.ids[1] - x.ids[1]);

  // totals, trend, calm
  const active = recs.filter((r) => r.clearedMs === 0);
  const activeNotable = active.filter((r) => r.tier !== 'context');
  const load = (fromS: number, toS: number) =>
    recs.filter((r) => nowMs - r.tMs >= fromS * 1000 && nowMs - r.tMs < toS * 1000).reduce((s, r) => s + TIER_WEIGHT[r.tier], 0);
  const last15 = load(0, 900);
  const prev15 = load(900, 1800);
  const lastCleared = notable.filter((r) => r.clearedMs > 0).reduce((m, r) => Math.max(m, r.clearedMs), 0);

  const steps = (input.events ?? []).slice().sort((a, b) => a.t - b.t).map((e) => ({ at: clock(e.t), ago_s: secs(nowMs - e.t), step: e.name }));

  const t: Timeline = {
    now: { at: clock(nowMs), local_hour: new Date(nowMs).getHours(), late_night: isLate(nowMs) },
    escalation: input.escalation ?? 'unknown',
    check_in_pending_s: input.checkDeadlineMs ? secs(input.checkDeadlineMs - nowMs) : null,
    totals: {
      incidents: recs.length,
      active: active.length,
      by_tier: {
        context: recs.filter((r) => r.tier === 'context').length,
        watch: recs.filter((r) => r.tier === 'watch').length,
        danger: recs.filter((r) => r.tier === 'danger').length,
      },
      active_families: [...new Set(activeNotable.map((r) => FAMILY[r.kind]))],
      unanswered_danger: active.filter((r) => r.tier === 'danger' && !r.acknowledged).length,
    },
    since_last_incident_s: recs.length ? secs(nowMs - recs[recs.length - 1].tMs) : null,
    calm_for_s: !activeNotable.length && lastCleared > 0 ? secs(nowMs - lastCleared) : null,
    trend: { last_15_min: last15, prev_15_min: prev15, direction: last15 > prev15 ? 'rising' : last15 < prev15 ? 'easing' : 'steady' },
    incidents,
    bursts,
    overlaps: overlaps.slice(0, MAX_OVERLAPS),
    chains: matchChains(recs, nowMs),
    escalation_steps: steps,
  };
  if (sorted.length > recs.length) t.omitted = sorted.length - recs.length;
  return t;
}

/**
 * Coarse clock for the AI read's digest: changes when an open incident has lasted into a new bucket
 * (1, 2, 5, 10, 20, 40, 60 min) or, once everything above context tier cleared, when the calm reaches 10, 30 or
 * 60 min. Duration changes the read (down for 20 s vs 10 min) without re-asking the model every second.
 */
export function timeBucket(records: IncidentRecord[], nowMs: number): string {
  const open = records.filter((r) => r.clearedMs === 0 && r.tier !== 'context');
  if (open.length) {
    const age = (nowMs - Math.min(...open.map((r) => r.tMs))) / 1000;
    return `a${[60, 120, 300, 600, 1200, 2400, 3600].filter((b) => age >= b).length}`;
  }
  const cleared = records.filter((r) => r.clearedMs > 0 && r.tier !== 'context');
  if (!cleared.length) return 'q';
  const calm = (nowMs - Math.max(...cleared.map((r) => r.clearedMs))) / 1000;
  return `c${[600, 1800, 3600].filter((b) => calm >= b).length}`;
}
