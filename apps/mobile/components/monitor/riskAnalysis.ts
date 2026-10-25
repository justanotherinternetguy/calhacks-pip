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
import { levelOf, RISK_BAND, RISKS, type Easing } from './riskDecay';

export { RISK_BAND, RISKS } from './riskDecay';

export type RiskLevel = 'low' | 'elevated' | 'high' | 'critical';
export type Urgency = 'info' | 'warn' | 'urgent';
export type Trajectory = 'rising' | 'steady' | 'easing';
export type Confidence = 'low' | 'medium' | 'high';
export type ChainStep = { t: string; id: number | null; note: string };
/** One step of the reasoning that moved the score: what combines which incidents (or context), and by how much. */
export type Driver = { factor: string; ids: number[]; effect: 'up' | 'down'; points: number };
export type Effect = 'up' | 'down' | 'none';
/** How the model read one incident on its own: its meaning here and its signed share of the score. */
export type Assessment = { id: number; reading: string; effect: Effect; points: number };
/** The owner said they are fine: answered a check-in (fingerprint / face / PIN) or tapped "I'm okay". */
export type OkConfirmation = { atMs: number; how: 'check_in' | 'tapped' };
export type Analysis = {
  risk: RiskLevel;
  /** 0-100, always inside the band of `risk` */
  score: number;
  trajectory: Trajectory;
  confidence: Confidence;
  headline: string;
  analysis: string;
  chain: ChainStep[];
  /** per incident, in the order the model gave them */
  assessments: Assessment[];
  drivers: Driver[];
  /** sum of the assessment and driver points: the score before it is pulled into the level's band */
  ledger: number;
  /** set when this read is the local reset after the owner confirmed OK (no model call) */
  okReset: OkConfirmation | null;
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
  /** times the owner confirmed they are OK, oldest first (phone clock) */
  confirmations?: OkConfirmation[];
  /** how far the console eased the previous read's score while things stayed calm (riskDecay.ts) */
  easing?: Easing | null;
};

const MAX_RECORDS = 40;
const MAX_EVENTS = 25;

const SYSTEM = `You are the risk analyst on a friend-safety console. One person (the subject) carries a phone running an on-device rule engine that flags incidents on a night out. Their friends watch this console. You read the engine's incidents as a timeline and estimate how much danger the subject is in right now. You get only the incidents (kind, order, timing, duration, state), never the sensor measurements behind them, so reason from those alone.

INCIDENT KINDS (tier: context = logged only, watch = counts toward a check-in, danger = asks "You okay?" on its own)
- fall family: phone_drop (phone fell, person likely fine), possible_fall, fall_recovered (got back up), down_after_fall [danger] (still down / motionless after a fall), hard_impact (violent jolt: hit, shove, collision)
- gait family, vs the person's own baseline: unsteady_gait, stumble, repeated_stumbles, slowed_walk (impairment: alcohol, possible drugging)
- phone: phone_left_behind; handling: grab [danger] (phone snatched or yanked; afterwards the phone may be with someone else)
- location: separated (apart from all friends, not heading home), stopped_on_way_home (stopped before reaching home), in_vehicle
- device: battery_critical; check_in: check_in_missed [danger] (no answer to "You okay?" in 2 min), typing_off (answered, but typing did not match their normal rhythm: impaired or not them)
- audio (labels only, no recordings; the mic only listens for 10 min after a fall, drop, grab, missed check-in or unsteady gait): scream_shout, snoring_while_down [danger] (snoring-like breathing while down after a missed check-in: possible loss of consciousness), distress_words (someone near the phone said "help", "get off me", "call the police" or similar within 10 min after a fall; on-device keyword spotting, the words themselves never leave the phone; can be a bystander)
Escalation ladder: idle -> check (asked "You okay?") -> heads_up (friends notified) -> unlocked (location released to friends); snatch = grab confirmed; resolved = over.
Check-ins can be turned off, so the absence of check_in_missed is not reassurance. An answered check-in is. "No response" means a check_in_missed or a pending check-in running out; when no check-in was asked, whether they would answer is unknown: say so, never "no response".

THE TIMELINE (JSON, all times on the phone clock, all durations in seconds)
- now: clock, local hour, late_night (21:00-06:00). escalation: engine state now. check_in_pending_s: seconds left on an open check-in.
- incidents[] oldest first: id, kind, tier, family, at, ago_s (before now), gap_s (since the previous incident started), lasted_s (until it cleared, or so far), active, answered (they acknowledged a check-in), episode (engine-grouped sequence), burst, after_grab (the phone may not be with the subject).
- bursts[]: incidents that each started within 5 min of the previous one. Several families in one short burst is far stronger evidence than the same incidents spread over hours.
- overlaps[]: pairs open at the same time (e.g. down_after_fall while separated), with how long they overlapped.
- chains[]: ordered patterns matched in the log, each with its gaps, steps matched (e.g. "2/4"), concern (reassuring / moderate / high / critical), and for an unfinished chain either next (what would come next, and how long its window stays open) or stalled (the window passed without it). Chains are hints from fixed rules, not verdicts: confirm them against the timing and states, and look for combinations they miss.
- trend: weighted load (watch 1, danger 3) of incidents that started in the last 15 min vs the 15 min before. calm_for_s: time since the last incident cleared when nothing is open.
- engine_events[] oldest first: the phone engine's recent event log. Escalation steps: check_requested, heads_up, unlock_location, snatch_detected, call_option (no response for 10 min), resolved. signal_incident / incident_cleared mirror incidents[] opening and closing. battery_dying. audio_listening: the mic window opened or closed. sampling_rate_changed / location_interval_changed: the engine changed sensor mode (housekeeping, not evidence of danger on their own). incident_log_cleared: the log was reset.
You are asked again after every new engine event, incident or friend action, and the user message names the newest engine event. Update your previous read: keep the score steady when the new event changes nothing, and say so in the analysis.
CONFIRMED OK: the user message lists the times the subject confirmed they are fine (answered a check-in with fingerprint / face / PIN, or tapped "I'm okay"). A confirmation resolves everything before it: those incidents add 0 points (say "before the OK"), and the score restarts from 0 using only what happened after the latest confirmation.

SHOW YOUR WORK (the console draws arrows from each incident to your reading of it, then into the score)
- assessments[]: one entry per incident you weighed (every active one and any that matter; skip pure housekeeping): id, reading (max 90 chars: what this incident means here, e.g. "fall 40 s after the impairment started"), effect up / down / none, points (signed share of the score, e.g. +15, -10, 0).
- drivers[]: the reasoning steps that combine incidents or add context: factor (the step, with its timing), ids (the incidents it combines, [] for pure context like late night), effect, points (the extra the combination adds or removes beyond the incidents' own points, e.g. +10 for two families within 2 min, -15 for an answered check-in).
- The points of assessments and drivers must add up to your score (before it is fitted to the level's band).

HOW TO REASON
1. Order matters. Fall then scream reads differently from scream then fall. Impairment then separated then in_vehicle late at night is the drugging / led-away pattern; the same kinds in the reverse order, or spread over hours, are not.
2. Gaps matter. Steps seconds or a couple of minutes apart are probably one event. Gaps of an hour or more are probably unrelated, unless the thread connecting them is impairment that is still active.
3. Duration matters. down_after_fall open for 20 s is a sit-down; open for 5+ min with no answer is an emergency. Impairment that lasted 30 min and is still active weighs more than one that cleared in 2 min.
4. State matters. Active, unanswered danger incidents drive risk up. Answered check-ins, cleared incidents, fall_recovered and a long calm_for_s bring it down. So does normal walking after the incidents (the user message gives the minutes: their usual gait, nothing out of band): someone walking like themselves is probably fine; weigh it as a down driver. Context tier alone is never more than low.
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
{"risk":"low|elevated|high|critical","score":0,"trajectory":"rising|steady|easing","confidence":"low|medium|high","headline":"one line, max 90 chars","analysis":"3-6 sentences for the friends: what the sequence adds up to and why","chain":[{"t":"HH:MM:SS","id":12,"note":"what this step means in the sequence"}],"assessments":[{"id":12,"reading":"what #12 means here","effect":"up|down|none","points":15}],"drivers":[{"factor":"the step that combines incidents or adds context, with its timing","ids":[12,14],"effect":"up|down","points":10}],"benign":"the most plausible innocent explanation, one sentence","watch_for":"what would change your read, one sentence","reminders":[{"text":"...","urgency":"info|warn|urgent"}]}`;

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
  assessments: { type: 'array', items: obj({ id: { type: 'integer' }, reading: { type: 'string' }, effect: enumOf(['up', 'down', 'none']), points: { type: 'integer' } }) },
  drivers: { type: 'array', items: obj({ factor: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' } }, effect: enumOf(['up', 'down']), points: { type: 'integer' } }) },
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
    events: input.events.slice(-MAX_EVENTS),
    maxIncidents: MAX_RECORDS,
  });
}

export function buildMessages(input: AnalysisInput): ChatMessage[] {
  const timeline = timelineFor(input);
  const lines: string[] = [`Subject: ${input.subjectName}.`];
  if (!input.tick) lines.push('No live engine state (the phone is not streaming right now): escalation is unknown, only the log is known.');
  const last = input.events.at(-1);
  if (last) lines.push(`Newest engine event: ${last.name}, ${ago(last.t, input.phoneNow)} ago.`);
  lines.push('', 'Timeline:', JSON.stringify(timeline));

  if (input.serverIncidents.length) {
    lines.push('', 'Escalations the friends were already notified about:');
    for (const i of input.serverIncidents) lines.push(`- ${i.level} opened ${ago(new Date(i.opened_at).getTime(), Date.now())} ago`);
  }
  if (input.friendEvents.length) {
    lines.push(`Friend actions so far: ${input.friendEvents.map((e) => `${e.actorName} ${EVENT_LABEL[e.kind] ?? e.kind} (${ago(new Date(e.created_at).getTime(), Date.now())} ago)`).join('; ')}.`);
  }
  const oks = input.confirmations ?? [];
  if (oks.length) {
    const last = oks[oks.length - 1];
    const before = timeline.incidents.filter((i) => recAt(input.records, i.id) <= last.atMs).map((i) => `#${i.id}`);
    lines.push('', `${input.subjectName} confirmed they are OK ${oks.length > 1 ? `${oks.length} times, last` : ''} ${ago(last.atMs, input.phoneNow)} ago (${last.how === 'check_in' ? 'answered a check-in with fingerprint / face / PIN' : 'tapped "I\'m okay"'}).`
      + (before.length ? ` Resolved by it, 0 points: ${before.join(' ')}.` : ' No incident came before it.'));
  }
  const walkS = input.tick?.metrics?.calmWalkS;
  if (walkS != null) {
    lines.push('', `Normal walking since the newest watch / danger incident opened (their usual gait, every unsteadiness metric in band): ${ago(0, walkS * 1000)}.`);
  }
  if (input.previous) {
    const p = input.previous;
    lines.push('', `Your previous read (${ago(p.atMs, Date.now())} ago): ${p.risk}${p.score != null ? ` ${p.score}/100` : ''}: ${p.headline}`);
    const e = input.easing;
    if (e && e.score < e.from) {
      lines.push(`Since then it stayed calm for ${Math.round(e.calmMin)} min${e.walkMin >= 0.5 ? ` (${Math.round(e.walkMin)} min of it walking normally)` : ''}, and the console eased the score from ${e.from} to ${e.score} (${e.risk}). Start from ${e.score}: go above it only for something new, and keep easing if nothing new matters.`);
    }
  }
  if (input.shownReminders.length) lines.push(`Reminders already shown to the friends: ${input.shownReminders.map((r) => `"${r}"`).join(' ')}`);

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** Phone time an incident started (records may hold several copies of an id across log resets: the newest). */
function recAt(records: IncidentRecord[], id: number): number {
  let t = -Infinity;
  for (const r of records) if (r.id === id && r.tMs > t) t = r.tMs;
  return t;
}

/**
 * The read right after the owner confirmed they are OK: risk 0, every incident before it resolved. Shown at once,
 * without a model call; the next engine event or incident brings a fresh read that starts from 0.
 */
export function okAnalysis(subjectName: string, ok: OkConfirmation, records: IncidentRecord[]): Analysis {
  const before = [...records].filter((r) => r.tMs <= ok.atMs).sort((a, b) => b.tMs - a.tMs).slice(0, 12);
  const how = ok.how === 'check_in' ? 'answered the check-in (fingerprint, face or PIN)' : 'tapped "I\'m okay"';
  return {
    risk: 'low', score: 0, trajectory: 'easing', confidence: 'high',
    headline: `${subjectName} confirmed they are OK`,
    analysis: `${subjectName} ${how}. Everything logged before that counts as resolved, so the risk is back to 0. The next incident starts a new read.`,
    chain: [],
    assessments: before.map((r) => ({ id: r.id, reading: 'before the OK: resolved', effect: 'none' as const, points: 0 })),
    drivers: [{ factor: `Confirmed OK: ${how}`, ids: before.map((r) => r.id), effect: 'down', points: 0 }],
    ledger: 0, okReset: ok, benign: '', watchFor: 'Any new incident after the confirmation.', reminders: [], floor: null,
  };
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
/** Points with the sign of their effect (a model may send "+15", 15 for a down step, or nothing). */
const signed = (v: unknown, effect: 'up' | 'down') => {
  const n = Math.abs(Math.round(num(v)));
  return Number.isFinite(n) ? Math.min(100, n) * (effect === 'down' ? -1 : 1) : 0;
};

/** Parses the model's answer; a non-JSON answer still shows up as the analysis text. */
export function parseAnalysis(text: string, floor: { level: RiskLevel; reason: string } | null = null): Analysis {
  const o = parseJsonObject(text);
  if (!o) {
    const risk = floor && RISKS.indexOf(floor.level) > 1 ? floor.level : 'elevated';
    return {
      risk, score: RISK_BAND[risk][0], trajectory: 'steady', confidence: 'low', headline: 'The AI answered in free text',
      analysis: text.slice(0, 1500), chain: [], assessments: [], drivers: [], ledger: RISK_BAND[risk][0], okReset: null, benign: '', watchFor: '', reminders: [], floor: floor && risk === floor.level ? floor.reason : null,
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
      const effect = e === 'down' || e === '-' || e === '−' ? 'down' : 'up';
      return { factor: str(s.factor, 240), ids: ids(s.ids ?? []).slice(0, 8), effect, points: signed(s.points, effect) };
    })
    .filter((d) => d.factor)
    .slice(0, 8);
  const seen = new Set<number>();
  const assessments = (Array.isArray(o.assessments) ? o.assessments : [])
    .map((a: unknown): Assessment | null => {
      const s = (a ?? {}) as Record<string, unknown>;
      const id = ids(s.id)[0];
      if (id == null || seen.has(id)) return null;
      seen.add(id);
      const e = String(s.effect ?? '').trim();
      const effect: Effect = e === 'up' || e === 'down' ? e : 'none';
      return { id, reading: str(s.reading, 160), effect, points: effect === 'none' ? 0 : signed(s.points, effect) };
    })
    .filter((a): a is Assessment => !!a)
    .slice(0, 24);
  const ledger = [...assessments, ...drivers].reduce((n, x) => n + x.points, 0);
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
    assessments,
    drivers,
    ledger,
    okReset: null,
    benign: str(o.benign, 400),
    watchFor: str(o.watch_for ?? o.watchFor, 400),
    reminders,
    floor: floored,
  };
}
