// Turns a friend's live state into what the map shows: a colour family, an 8-dot meter, one line of text.
// Display only; the engine (Rust) still decides escalation.
import type { IncidentKind, IncidentRecord } from '@/modules/safety-native';
import { KIND_LABEL } from '@/components/dashboard/labels';
import type { Tone } from './theme';
import { tones } from './theme';
import type { FriendLive } from './friends';
import { OKAY_SHOWN_MS } from './telemetry';

/** A real phone that has not sent anything for this long is shown as not streaming. */
export const STALE_FRIEND_MS = 90_000;

const TITLE: Partial<Record<IncidentKind, string>> = {
  possible_fall: 'Large fall detected',
  down_after_fall: 'Still down after the fall',
  fall_recovered: 'Got back up',
  separated: 'Left the group',
  unsteady_gait: 'Stumbling',
  stumble: 'Stumbled',
  check_in_missed: 'Typing check-in missed',
  in_vehicle: 'In a car',
  slowed_walk: 'Walking slowly',
};
export const recordTitle = (k: IncidentKind | string) => TITLE[k as IncidentKind] ?? KIND_LABEL[k as IncidentKind] ?? String(k).replace(/_/g, ' ');
/** Short form for the one-line headline under a name. */
const SHORT: Partial<Record<IncidentKind, string>> = { possible_fall: 'Large fall', down_after_fall: 'Down after a fall', unsteady_gait: 'Unsteady walk', check_in_missed: 'Missed check-in', separated: 'Left the group' };
const shortTitle = (k: IncidentKind) => SHORT[k] ?? recordTitle(k);

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60 ? `${m % 60} min ` : ''}ago`;
}

export const isActive = (r: IncidentRecord) => r.clearedMs === 0;

/** Server incident levels (see lib/types IncidentLevel): how worried to be, and the line under a name. */
const SERVER_SCORE: Record<string, number> = { check: 4, battery_dying: 3, offline: 5, heads_up: 6, unlocked: 7, sos: 7, snatch: 8 };
const SERVER_LINE: Record<string, string> = {
  check: 'Check-in pending', battery_dying: 'Battery dying', offline: 'Phone went offline', heads_up: 'Friends got a heads-up',
  unlocked: 'Location shared with friends', sos: 'Called for help', snatch: 'Phone may have been snatched',
};
export const serverIncidentLine = (level: string) => SERVER_LINE[level] ?? level.replace(/_/g, ' ');

export type Concern = { tone: Tone; dots: number; headline: string; label: string; offline: boolean; /** said "I'm okay" by hand, recently and after anything that is open */ saidOkay: boolean };

export function concernOf(f: FriendLive, now: number, opts: { inZone?: boolean } = {}): Concern {
  const offline = !f.simulated && (!f.lastTickAt || now - f.lastTickAt > STALE_FRIEND_MS);
  const active = f.records.filter((r) => isActive(r) && r.tier !== 'context');
  const danger = active.filter((r) => r.tier === 'danger');

  let score: number = ({ idle: 0, resolved: 0, check: 4, heads_up: 6, unlocked: 7, snatch: 8 } as Record<string, number>)[f.escalation] ?? 0;
  if (danger.length) score = Math.max(score, 6);
  if (active.length) score = Math.max(score, Math.min(4, 1 + active.length));
  if (f.checkPending) score = Math.max(score, 4);
  const srv = f.serverIncident;
  const srvAt = srv ? Date.parse(srv.opened_at) : 0;
  if (srv) score = Math.max(score, SERVER_SCORE[srv.level] ?? 4);

  const newest = active[active.length - 1];
  const saidOkay = f.okayAt != null && now - f.okayAt < OKAY_SHOWN_MS && (!newest || f.okayAt > newest.tMs) && (!srv || f.okayAt > srvAt) && !f.checkPending;
  let tone: Tone;
  let headline: string;
  if (score >= 5) tone = 'high';
  else if (score >= 2) tone = 'mild';
  else if (offline) tone = 'offline';
  else tone = f.nightMode ? 'out' : 'home';

  // An open server incident at least as serious as the telemetry is what friends act on, so it leads.
  const srvLeads = !!srv && (SERVER_SCORE[srv.level] ?? 4) >= (newest ? (newest.tier === 'danger' ? 6 : 4) : 0);
  if (srv && srvLeads) headline = `${serverIncidentLine(srv.level)} · ${ago(srvAt, now)}`;
  else if (newest && saidOkay) headline = `${shortTitle(newest.kind)} · says they’re okay · ${ago(f.okayAt!, now)}`;
  else if (newest) headline = `${shortTitle(newest.kind)} · ${ago(newest.tMs, now)}`;
  else if (f.checkPending) headline = 'Check-in pending';
  else if (f.escalation === 'heads_up') headline = 'Friends got a heads-up';
  else if (f.escalation === 'unlocked') headline = 'Location shared with friends';
  else if (f.escalation === 'snatch') headline = 'Phone may have been snatched';
  else if (saidOkay) headline = `Said they’re okay · ${ago(f.okayAt!, now)}`;
  else if (tone === 'offline') headline = f.lastTickAt ? `Last seen ${ago(f.lastTickAt, now)}` : 'Not streaming';
  else if (tone === 'home') headline = 'Home';
  else headline = opts.inZone ? 'Together' : 'Out tonight';

  const dots = tone === 'high' || tone === 'mild' ? score : tone === 'out' ? 1 : 0;
  return { tone, dots, headline, label: tones[tone].label, offline, saidOkay };
}

/** Worst first: tone, then score. */
export const toneRank: Record<Tone, number> = { high: 4, mild: 3, out: 2, home: 1, offline: 0 };
