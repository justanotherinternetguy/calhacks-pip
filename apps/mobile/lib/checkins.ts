// Friends check in on each other (functions/checkin, 0021_check_ins.sql). UI calls these; no detection logic.
import { fn } from './db';
import { sos, syncSticky } from './native';
import { useStore } from './store';
import type { CheckIn, Uuid } from './types';

/** "You okay?" to a friend: a sticky notification on their phone until they answer. */
export async function askCheckIn(targetId: Uuid): Promise<CheckIn> {
  const { checkIn } = await fn.checkin({ action: 'ask', targetId });
  useStore.getState().upsertCheckIn(checkIn);
  syncSticky(); // "Waiting for …" on this phone right away
  return checkIn;
}

/** Answer a friend's question. "help" raises the SOS on this phone too (location release lives on the phone). */
export async function answerCheckIn(checkInId: Uuid, status: 'ok' | 'help'): Promise<CheckIn> {
  if (status === 'help') await sos().catch((e) => console.warn('sos', e));
  const { checkIn } = await fn.checkin({ action: 'answer', checkInId, status });
  useStore.getState().upsertCheckIn(checkIn);
  syncSticky();
  return checkIn;
}

export async function cancelCheckIn(checkInId: Uuid): Promise<CheckIn> {
  const { checkIn } = await fn.checkin({ action: 'cancel', checkInId });
  useStore.getState().upsertCheckIn(checkIn);
  syncSticky();
  return checkIn;
}

/** The newest check-in between me and this friend (either direction), for the friend's row. */
export function latestWith(checkIns: CheckIn[], me: Uuid, friend: Uuid): CheckIn | null {
  return checkIns.find((c) => (c.asker_id === me && c.target_id === friend) || (c.asker_id === friend && c.target_id === me)) ?? null;
}

/** Check-ins addressed to me that still want an answer (a missed one can be answered late). */
export function openQuestionsForMe(checkIns: CheckIn[], me: Uuid, nowMs = Date.now()): CheckIn[] {
  return checkIns.filter((c) => c.target_id === me && (c.status === 'pending' || (c.status === 'missed' && nowMs - Date.parse(c.deadline_at) < 2 * 3_600_000)));
}

/** "asked 3 min ago" / "okay at 01:12" / "didn't answer" — one line for a friend's row. */
export function checkInLine(c: CheckIn, me: Uuid, nowMs = Date.now()): string {
  const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  const mins = Math.max(0, Math.round((nowMs - Date.parse(c.created_at)) / 60_000));
  const iAsked = c.asker_id === me;
  switch (c.status) {
    case 'pending': return iAsked ? `You asked ${mins < 1 ? 'just now' : `${mins} min ago`} · waiting` : 'Asked if you\'re okay';
    case 'ok': return iAsked ? `Okay at ${clock(c.answered_at)}` : `You said you're okay at ${clock(c.answered_at)}`;
    case 'help': return iAsked ? `Needs help (${clock(c.answered_at)})` : 'You asked for help';
    case 'missed': return iAsked ? 'Didn\'t answer · group alerted' : 'You didn\'t answer in time';
    default: return iAsked ? 'You cancelled your check-in' : 'Check-in cancelled';
  }
}
