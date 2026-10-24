// Prompt + parser for the monitor's AI read of a subject's incident log. The LM is advisory only: it reads what
// the engine flagged as a sequence and estimates how much danger the subject is in, for the friends watching.
// Detection and escalation stay in the Rust engine.
// The model gets a structured timeline (incidentTimeline.ts): kinds, tiers, times, order, gaps, durations, overlaps,
// bursts and matched chains, never the measurements behind them (g, SD distances, summaries, raw JSON).
import { isCheckPending, type EscalationLevel, type IncidentRecord, type TelemetryTick } from '@/modules/safety-native';
import type { Incident, IncidentEvent } from '@/lib/types';
import { parseJsonObject, type ChatMessage } from '@/lib/llm';
import { EVENT_LABEL } from './labels';
import { buildTimeline, type Timeline } from './incidentTimeline';

export type RiskLevel = 'low' | 'elevated' | 'high' | 'critical';
export type Urgency = 'info' | 'warn' | 'urgent';
export type Trajectory = 'rising' | 'steady' | 'easing';
export type Confidence = 'low' | 'medium' | 'high';
export type ChainStep = { t: string; id: number | null; note: string };
/** One thing that moved the score: up (+) or down (−). */
export type Driver = { factor: string; ids: number[]; effect: 'up' | 'down' };
export type Analysis = {
  risk: RiskLevel;
  /** 0-100, always inside the band of `risk` */
  score: number;
  trajectory: Trajectory;
  confidence: Confidence;
  headline: string;
  analysis: string;
  chain: ChainStep[];
  drivers: Driver[];
  benign: string;
  watchFor: string;
  reminders: { text: string; urgency: Urgency }[];
  /** set when the engine's own escalation raised the model's level */
  floor: string | null;
};

export type AnalysisInput = {
  subjectName: string;
  /** phone clock, unix ms */
  phoneNow: number;
  tick: TelemetryTick | null;
  /** engine incident log, any order */
  records: IncidentRecord[];
  /** recent engine events, oldest first */
  events: { t: number; name: string }[];
  /** open server-side incidents for the subject (escalations friends were told about) */
  serverIncidents: Incident[];
  /** friend actions on those incidents (ring, on the way, found…) */
  friendEvents: (IncidentEvent & { actorName: string })[];
  previous: { risk: RiskLevel; score: number | null; headline: string; atMs: number } | null;
  shownReminders: string[];
};

const MAX_RECORDS = 40;
const MAX_EVENTS = 25;
/** Engine events that are reports in their own right (escalation steps); the rest repeat the log or are sensor housekeeping. */
const REPORT_EVENTS = new Set(['check_requested', 'heads_up', 'unlock_location', 'snatch_detected', 'call_option', 'resolved', 'incident_log_cleared']);

export const RISKS: RiskLevel[] = ['low', 'elevated', 'high', 'critical'];
/** Score band per level, inclusive. */
export const RISK_BAND: Record<RiskLevel, [number, number]> = { low: [0, 24], elevated: [25, 49], high: [50, 74], critical: [75, 100] };
const levelOf = (score: number): RiskLevel => RISKS.find((l) => score <= RISK_BAND[l][1]) ?? 'critical';

const SYSTEM = `You are the risk analyst on a friend-safety console. One person (the subject) carries a phone running an on-device rule engine that flags incidents on a night out. Their friends watch this console. You read the engine's incidents as a timeline and estimate how much danger the subject is in right now. You get only the incidents (kind, order, timing, duration, state), never the sensor measurements behind them, so reason from those alone.

INCIDENT KINDS (tier: context = logged only, watch = counts toward a check-in, danger = asks "You okay?" on its own)
- fall family: phone_drop (phone fell, person likely fine), possible_fall, fall_recovered (got back up), down_after_fall [danger] (still down / motionless after a fall), hard_impact (violent jolt: hit, shove, collision)
- gait family, vs the person's own baseline: unsteady_gait, stumble, repeated_stumbles, slowed_walk (impairment: alcohol, possible drugging)
- phone: phone_left_behind; handling: grab [danger] (phone snatched or yanked; afterwards the phone may be with someone else)
- location: separated (apart from all friends, not heading home), stopped_on_way_home (stopped before reaching home), in_vehicle
- device: battery_critical; check_in: check_in_missed [danger] (no answer to "You okay?" in 2 min), typing_off (answered, but typing did not match their normal rhythm: impaired or not them)
- audio (labels only, no recordings; the mic only listens for 10 min after a fall, drop, grab, missed check-in or unsteady gait): scream_shout, snoring_while_down [danger] (snoring-like breathing while down after a missed check-in: possible loss of consciousness)
Escalation ladder: idle -> check (asked "You okay?") -> heads_up (friends notified) -> unlocked (location released to friends); snatch = grab confirmed; resolved = over.
Check-ins can be turned off, so the absence of check_in_missed is not reassurance. An answered check-in is. "No response" means a check_in_missed or a pending check-in running out; when no check-in was asked, whether they would answer is unknown: say so, never "no response".

THE TIMELINE (JSON, all times on the phone clock, all durations in seconds)
- now: clock, local hour, late_night (21:00-06:00). escalation: engine state now. check_in_pending_s: seconds left on an open check-in.
- incidents[] oldest first: id, kind, tier, family, at, ago_s (before now), gap_s (since the previous incident started), lasted_s (until it cleared, or so far), active, answered (they acknowledged a check-in), episode (engine-grouped sequence), burst, after_grab (the phone may not be with the subject).
- bursts[]: incidents that each started within 5 min of the previous one. Several families in one short burst is far stronger evidence than the same incidents spread over hours.
- overlaps[]: pairs open at the same time (e.g. down_after_fall while separated), with how long they overlapped.
- chains[]: ordered patterns matched in the log, each with its gaps, steps matched (e.g. "2/4"), concern (reassuring / moderate / high / critical), and for an unfinished chain either next (what would come next, and how long its window stays open) or stalled (the window passed without it). Chains are hints from fixed rules, not verdicts: confirm them against the timing and states, and look for combinations they miss.
- trend: weighted load (watch 1, danger 3) of incidents that started in the last 15 min vs the 15 min before. calm_for_s: time since the last incident cleared when nothing is open.

HOW TO REASON
1. Order matters. Fall then scream reads differently from scream then fall. Impairment then separated then in_vehicle late at night is the drugging / led-away pattern; the same kinds in the reverse order, or spread over hours, are not.
2. Gaps matter. Steps seconds or a couple of minutes apart are probably one event. Gaps of an hour or more are probably unrelated, unless the thread connecting them is impairment that is still active.
3. Duration matters. down_after_fall open for 20 s is a sit-down; open for 5+ min with no answer is an emergency. Impairment that lasted 30 min and is still active weighs more than one that cleared in 2 min.
4. State matters. Active, unanswered danger incidents drive risk up. Answered check-ins, cleared incidents, fall_recovered and a long calm_for_s bring it down. Context tier alone is never more than low.
5. Late night, being separated, a dying battery and being in a vehicle make the same incidents worse because friends have less reach.
6. Always weigh the innocent reading: dancing, a dropped phone, a bus or rideshare home, a recovered stumble, a quick answer.
7. Never claim certainty or invent facts: no measurements, places, people or causes that are not in the data. Say "consistent with", not "is". Cite incidents by #id.

SCORING (0-100, the band must match the level)
- low 0-24: nothing concerning, or fully explained (context only, a lone drop, a recovered fall, everything answered and calm for a while)
- elevated 25-49: worth a text: one active watch-tier thread (e.g. impairment alone), or a moderate chain that stalled
- high 50-74: contact them now: watch incidents from 2+ families close together, a high-concern chain, or a danger incident that is new and unanswered
- critical 75-100: act now: escalation at heads_up / unlocked / snatch, a critical chain, a danger incident still open for minutes, or a high-concern chain still active after a missed check-in
Move within a band by timing tightness, duration and how many independent families agree. trajectory: rising / steady / easing, from the trend, open next-steps and calm. confidence: how well the data pins down the reading (low when few incidents or the benign reading is about as likely).

Reminders are short pop-ups shown to the friends right now (max 110 characters, 0-3). Make them concrete actions using the subject's name, e.g. "Call Alex now: still down 4 min after a fall, no answer." Urgency "urgent" only at high/critical, "warn" at elevated, "info" otherwise. Do not repeat a reminder already shown unless the situation got worse.

Answer with one JSON object only, no prose around it:
{"risk":"low|elevated|high|critical","score":0,"trajectory":"rising|steady|easing","confidence":"low|medium|high","headline":"one line, max 90 chars","analysis":"3-6 sentences for the friends: what the sequence adds up to and why","chain":[{"t":"HH:MM:SS","id":12,"note":"what this step means in the sequence"}],"drivers":[{"factor":"what raised or lowered the score, with its timing","ids":[12,14],"effect":"up|down"}],"benign":"the most plausible innocent explanation, one sentence","watch_for":"what would change your read, one sentence","reminders":[{"text":"...","urgency":"info|warn|urgent"}]}`;

/** The answer's shape, enforced by Claude's structured outputs (OpenRouter only gets JSON mode plus the prompt). */
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const enumOf = (values: string[]) => ({ type: 'string', enum: values });
export const ANALYSIS_SCHEMA = obj({
  risk: enumOf(['low', 'elevated', 'high', 'critical']),
  score: { type: 'integer' },
  trajectory: enumOf(['rising', 'steady', 'easing']),
  confidence: enumOf(['low', 'medium', 'high']),
  headline: { type: 'string' },
  analysis: { type: 'string' },
  chain: { type: 'array', items: obj({ t: { type: 'string' }, id: { type: 'integer' }, note: { type: 'string' } }) },
  drivers: { type: 'array', items: obj({ factor: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' } }, effect: enumOf(['up', 'down']) }) },
  benign: { type: 'string' },
  watch_for: { type: 'string' },
  reminders: { type: 'array', items: obj({ text: { type: 'string' }, urgency: enumOf(['info', 'warn', 'urgent']) }) },
});

const ago = (fromMs: number, toMs: number) => {
  const s = Math.max(0, Math.round((toMs - fromMs) / 1000));
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

export function timelineFor(input: Pick<AnalysisInput, 'records' | 'phoneNow' | 'tick' | 'events'>): Timeline {
  return buildTimeline({
    records: input.records,
    nowMs: input.phoneNow,
    escalation: input.tick?.escalation ?? null,
    checkDeadlineMs: isCheckPending(input.tick) ? input.tick?.checkDeadlineMs ?? null : null,
    events: input.events.filter((e) => REPORT_EVENTS.has(e.name)).slice(-MAX_EVENTS),
    maxIncidents: MAX_RECORDS,
  });
}

export function buildMessages(input: AnalysisInput): ChatMessage[] {
  const timeline = timelineFor(input);
  const lines: string[] = [`Subject: ${input.subjectName}.`];
  if (!input.tick) lines.push('No live engine state (the phone is not streaming right now): escalation is unknown, only the log is known.');
  lines.push('', 'Timeline:', JSON.stringify(timeline));

  if (input.serverIncidents.length) {
    lines.push('', 'Escalations the friends were already notified about:');
    for (const i of input.serverIncidents) lines.push(`- ${i.level} opened ${ago(new Date(i.opened_at).getTime(), Date.now())} ago`);
  }
  if (input.friendEvents.length) {
    lines.push(`Friend actions so far: ${input.friendEvents.map((e) => `${e.actorName} ${EVENT_LABEL[e.kind] ?? e.kind} (${ago(new Date(e.created_at).getTime(), Date.now())} ago)`).join('; ')}.`);
  }
  if (input.previous) {
    const p = input.previous;
    lines.push('', `Your previous read (${ago(p.atMs, Date.now())} ago): ${p.risk}${p.score != null ? ` ${p.score}/100` : ''}: ${p.headline}`);
  }
  if (input.shownReminders.length) lines.push(`Reminders already shown to the friends: ${input.shownReminders.map((r) => `"${r}"`).join(' ')}`);

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * The lowest level the read may show, from the engine's own escalation: the engine's ladder is authoritative,
 * so a model that under-calls cannot show "low" while friends are being alerted.
 */
export function riskFloor(escalation: EscalationLevel | null | undefined, checkPending: boolean): { level: RiskLevel; reason: string } | null {
  if (escalation === 'snatch') return { level: 'critical', reason: 'engine detected a snatch' };
  if (escalation === 'unlocked') return { level: 'critical', reason: 'engine released the location' };
  if (escalation === 'heads_up') return { level: 'high', reason: 'engine notified the friends' };
  if (escalation === 'check' || checkPending) return { level: 'elevated', reason: 'a check-in is pending' };
  return null;
}

const URGENCIES: Urgency[] = ['info', 'warn', 'urgent'];
const TRAJECTORIES: Trajectory[] = ['rising', 'steady', 'easing'];
const CONFIDENCES: Confidence[] = ['low', 'medium', 'high'];
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : Number.NaN);
const ids = (v: unknown): number[] =>
  (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'number' ? x : Number.parseInt(String(x ?? '').replace('#', ''), 10))).filter(Number.isFinite);
const clamp = (n: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Parses the model's answer; a non-JSON answer still shows up as the analysis text. */
export function parseAnalysis(text: string, floor: { level: RiskLevel; reason: string } | null = null): Analysis {
  const o = parseJsonObject(text);
  if (!o) {
    const risk = floor && RISKS.indexOf(floor.level) > 1 ? floor.level : 'elevated';
    return {
      risk, score: RISK_BAND[risk][0], trajectory: 'steady', confidence: 'low', headline: 'AI answer was not structured',
      analysis: text.slice(0, 1500), chain: [], drivers: [], benign: '', watchFor: '', reminders: [], floor: floor && risk === floor.level ? floor.reason : null,
    };
  }
  // The level is authoritative; the score is pulled into its band. A missing level comes from the score.
  const rawScore = num(o.score ?? o.risk_score);
  let risk: RiskLevel = RISKS.includes(o.risk as RiskLevel) ? (o.risk as RiskLevel) : Number.isFinite(rawScore) ? levelOf(rawScore) : 'elevated';
  let floored: string | null = null;
  if (floor && RISKS.indexOf(floor.level) > RISKS.indexOf(risk)) {
    risk = floor.level;
    floored = floor.reason;
  }
  const band = RISK_BAND[risk];
  const score = clamp(Number.isFinite(rawScore) ? rawScore : (band[0] + band[1]) / 2, band);

  const chain = (Array.isArray(o.chain) ? o.chain : [])
    .map((c: unknown) => {
      const s = (c ?? {}) as Record<string, unknown>;
      return { t: str(s.t, 12), id: ids(s.id)[0] ?? null, note: str(s.note, 300) };
    })
    .filter((c) => c.note)
    .slice(0, 12);
  const drivers = (Array.isArray(o.drivers) ? o.drivers : [])
    .map((d: unknown): Driver => {
      const s = (typeof d === 'string' ? { factor: d } : (d ?? {})) as Record<string, unknown>;
      const e = String(s.effect ?? '').trim();
      return { factor: str(s.factor, 240), ids: ids(s.ids ?? []).slice(0, 8), effect: e === 'down' || e === '-' || e === '−' ? 'down' : 'up' };
    })
    .filter((d) => d.factor)
    .slice(0, 8);
  const reminders = (Array.isArray(o.reminders) ? o.reminders : [])
    .map((r: unknown) => {
      const s = (typeof r === 'string' ? { text: r } : (r ?? {})) as Record<string, unknown>;
      const urgency = URGENCIES.includes(s.urgency as Urgency) ? (s.urgency as Urgency) : risk === 'critical' || risk === 'high' ? 'urgent' : 'info';
      return { text: str(s.text, 160), urgency };
    })
    .filter((r) => r.text)
    .slice(0, 3);
  return {
    risk,
    score,
    trajectory: TRAJECTORIES.includes(o.trajectory as Trajectory) ? (o.trajectory as Trajectory) : 'steady',
    confidence: CONFIDENCES.includes(o.confidence as Confidence) ? (o.confidence as Confidence) : 'medium',
    headline: str(o.headline, 140) || 'Analysis',
    analysis: str(o.analysis),
    chain,
    drivers,
    benign: str(o.benign, 400),
    watchFor: str(o.watch_for ?? o.watchFor, 400),
    reminders,
    floor: floored,
  };
}
