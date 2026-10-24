// Prompt + parser for the monitor's AI read of a subject's incident log. The LM is advisory only: it explains what
// the engine flagged, as a sequence, for the friends watching. Detection and escalation stay in the Rust engine.
// It sees the incident reports only (type, tier, time, order, gaps, cleared / answered, episode), never the
// measurements behind them (g, SD distances, raw JSON, sensor state): the reading must rest on what happened when.
import type { IncidentRecord, TelemetryTick } from '@/modules/safety-native';
import type { Incident, IncidentEvent } from '@/lib/types';
import { parseJsonObject, type ChatMessage } from '@/lib/llm';
import { fmtClock } from '@/components/telemetry/labels';
import { EVENT_LABEL } from './labels';

export type RiskLevel = 'low' | 'elevated' | 'high' | 'critical';
export type Urgency = 'info' | 'warn' | 'urgent';
export type ChainStep = { t: string; id: number | null; note: string };
export type Analysis = {
  risk: RiskLevel;
  headline: string;
  analysis: string;
  chain: ChainStep[];
  benign: string;
  watchFor: string;
  reminders: { text: string; urgency: Urgency }[];
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
  previous: { risk: RiskLevel; headline: string; atMs: number } | null;
  shownReminders: string[];
};

const MAX_RECORDS = 40;
const MAX_EVENTS = 25;
/** Engine events that are reports in their own right (escalation steps); the rest repeat the log or are sensor housekeeping. */
const REPORT_EVENTS = new Set(['check_requested', 'heads_up', 'unlock_location', 'snatch_detected', 'call_option', 'resolved', 'incident_log_cleared']);

const SYSTEM = `You are the forensic analyst on a friend-safety console. One person (the subject) carries a phone running an on-device rule engine that flags incidents on a night out. Their friends watch this console. You read the engine's incident reports as a sequence and tell the friends what it adds up to. You get only the reports: which kinds of incident happened, in what order, at what times and how far apart, and whether each one cleared or was answered. You never get the sensor measurements behind them, so reason from the kinds, their order and their timing alone.

Incident kinds (tier in brackets: context = logged only, watch = counts toward a check-in, danger = asks "You okay?" on its own):
- falls: phone_drop (phone fell, person likely fine), possible_fall, fall_recovered (got back up), down_after_fall (still down/motionless after a fall), hard_impact (violent jolt: hit, shove, collision)
- gait vs the person's own baseline: unsteady_gait, stumble, repeated_stumbles, slowed_walk (impairment, intoxication, possible drugging)
- phone: grab (phone snatched/yanked from them), phone_left_behind
- location: separated (apart from their friends), stopped_on_way_home (stopped somewhere unexpected while heading home), in_vehicle
- device/check-in: battery_critical, check_in_missed (did not answer "You okay?" in time), typing_off (answered but typing did not match their normal rhythm: impaired or not them)
- audio (only labels, never recordings): scream_shout, snoring_while_down (snoring-like breathing while down: possible loss of consciousness)
"+12 s" = time since the previous report. "seq #n" = reports the engine grouped into one episode. "cleared" = condition ended. "answered" = they acknowledged a check-in.
Escalation ladder: idle -> check (asked "You okay?", 2 min to answer) -> heads_up (friends notified) -> unlocked (location released to friends) ; snatch = grab detected.

How to analyze:
- Read the reports together in time order; the gaps matter (an impact, a scream 12 s later and a fall a minute after that is one event; the same three spread over two hours are not). Look for chains such as: impairment (unsteady gait, slowed walk, stumbles) then separated or in_vehicle or stopped_on_way_home late at night (possible drugging / being led away); hard_impact or grab followed by scream_shout, down_after_fall or no motion (possible assault or robbery); down_after_fall with snoring_while_down or missed check-ins (incapacitation); typing_off on a check-in (impaired, or someone else answering).
- Also weigh the benign reading: dancing, a dropped phone, a bus or rideshare home, a recovered fall, an answered check-in, incidents that cleared quickly. Say which reading the evidence favors and why.
- Never claim certainty or invent facts. There are no measurements, no location, no audio and no video here; do not make up numbers, places or people. Say "consistent with", not "is".
- Cite incidents by clock time and #id.
- Risk: low (nothing concerning or fully explained), elevated (worth keeping an eye on / a text), high (a concerning chain is active: contact them now), critical (engine escalated to heads_up/unlocked/snatch, or a danger chain with no response: act now).
- Reminders are short pop-ups shown to the friends right now (max 110 characters each, 0-3 of them). Make them concrete actions or facts using the subject's name, e.g. "Call Alex now: no answer to the check-in for 90 s." Use urgency "urgent" only for high/critical risk, "warn" for elevated, "info" otherwise. Do not repeat a reminder already shown unless the situation got worse.

Answer with one JSON object only, no prose around it:
{"risk":"low|elevated|high|critical","headline":"one line, max 90 chars","analysis":"3-6 sentences for the friends","chain":[{"t":"HH:MM:SS","id":12,"note":"what this step means"}],"benign":"the most plausible innocent explanation, one sentence","watch_for":"what would change your read, one sentence","reminders":[{"text":"...","urgency":"info|warn|urgent"}]}`;

const age = (fromMs: number, toMs: number) => {
  const s = Math.max(0, Math.round((toMs - fromMs) / 1000));
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

const gap = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `+${s} s` : s < 5400 ? `+${Math.round(s / 60)} min` : `+${(s / 3600).toFixed(1)} h`;
};

/** One report line: id, time, gap since the previous report, kind, tier and its state. No measurements. */
function describeRecord(r: IncidentRecord, prevMs: number | null): string {
  const flags = [
    r.clearedMs > 0 ? `cleared ${fmtClock(r.clearedMs)} (lasted ${age(r.tMs, r.clearedMs)})` : 'still active',
    r.acknowledged ? 'answered' : '',
    r.sequenceId > 0 ? `seq #${r.sequenceId}` : '',
    r.watched ? 'engine watching' : '',
  ].filter(Boolean).join(', ');
  return `#${r.id} ${fmtClock(r.tMs)}${prevMs != null ? ` (${gap(r.tMs - prevMs)})` : ''} ${r.kind} [${r.tier}] — ${flags}`;
}

export function buildMessages(input: AnalysisInput): ChatMessage[] {
  const { tick, phoneNow } = input;
  const lines: string[] = [];
  lines.push(`Subject: ${input.subjectName}. Phone clock now: ${fmtClock(phoneNow)} (local hour ${new Date(phoneNow).getHours()}).`);
  if (tick) {
    lines.push(`Escalation now: ${tick.escalation}.`);
    if (tick.checkPhrase) {
      const left = tick.checkDeadlineMs ? Math.max(0, Math.round((tick.checkDeadlineMs - phoneNow) / 1000)) : null;
      lines.push(`A "You okay?" check-in is pending on the phone${left != null ? `, ${left} s left to answer` : ''}.`);
    }
  } else {
    lines.push('No live engine state (the phone is not streaming right now); only the log below is known.');
  }

  const recs = [...input.records].sort((a, b) => a.tMs - b.tMs).slice(-MAX_RECORDS);
  lines.push('', `Incident log, oldest first (${recs.length} of ${input.records.length} records, last 8 h):`);
  lines.push(...(recs.length ? recs.map((r, i) => describeRecord(r, i > 0 ? recs[i - 1].tMs : null)) : ['(empty)']));

  const evs = input.events.filter((e) => REPORT_EVENTS.has(e.name)).slice(-MAX_EVENTS);
  if (evs.length) lines.push('', `Escalation steps, oldest first: ${evs.map((e) => `${fmtClock(e.t)} ${e.name}`).join(' · ')}`);

  if (input.serverIncidents.length) {
    lines.push('', 'Escalations the friends were already notified about:');
    for (const i of input.serverIncidents) lines.push(`- ${i.level} opened ${age(new Date(i.opened_at).getTime(), Date.now())} ago`);
  }
  if (input.friendEvents.length) {
    lines.push(`Friend actions so far: ${input.friendEvents.map((e) => `${e.actorName} ${EVENT_LABEL[e.kind] ?? e.kind} (${age(new Date(e.created_at).getTime(), Date.now())} ago)`).join('; ')}.`);
  }
  if (input.previous) lines.push('', `Your previous read (${age(input.previous.atMs, Date.now())} ago): ${input.previous.risk} — ${input.previous.headline}`);
  if (input.shownReminders.length) lines.push(`Reminders already shown to the friends: ${input.shownReminders.map((r) => `"${r}"`).join(' ')}`);

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ];
}

const RISKS: RiskLevel[] = ['low', 'elevated', 'high', 'critical'];
const URGENCIES: Urgency[] = ['info', 'warn', 'urgent'];
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Parses the model's answer; a non-JSON answer still shows up as the analysis text. */
export function parseAnalysis(text: string): Analysis {
  const o = parseJsonObject(text);
  if (!o) return { risk: 'elevated', headline: 'AI answer was not structured', analysis: text.slice(0, 1500), chain: [], benign: '', watchFor: '', reminders: [] };
  const risk = RISKS.includes(o.risk as RiskLevel) ? (o.risk as RiskLevel) : 'elevated';
  const chain = (Array.isArray(o.chain) ? o.chain : [])
    .map((c: unknown) => {
      const s = (c ?? {}) as Record<string, unknown>;
      const id = typeof s.id === 'number' ? s.id : Number.parseInt(String(s.id ?? '').replace('#', ''), 10);
      return { t: str(s.t, 12), id: Number.isFinite(id) ? id : null, note: str(s.note, 300) };
    })
    .filter((c) => c.note)
    .slice(0, 12);
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
    headline: str(o.headline, 140) || 'Analysis',
    analysis: str(o.analysis),
    chain,
    benign: str(o.benign, 400),
    watchFor: str(o.watch_for ?? o.watchFor, 400),
    reminders,
  };
}
