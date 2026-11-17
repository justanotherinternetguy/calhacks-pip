// Server state → the sticky notifications that should be open on this phone (FriendAlerts.kt via
// SafetyNative.syncSticky). Pure, so node --test runs it; lib/native.ts calls it after every refresh.
import type { StickyItem } from '@/modules/safety-native/src/SafetyNative.types';
import type { CheckIn, Incident, Uuid } from './types';

/** A missed check-in can still be answered for this long (a late "I'm OK" closes the group alert). */
export const LATE_ANSWER_MS = 2 * 3_600_000;
/** Friend incident levels that stay pinned until they resolve. */
export const STICKY_LEVELS = new Set<Incident['level']>(['heads_up', 'unlocked', 'snatch', 'offline', 'battery_dying', 'sos', 'missed_check_in']);

export function incidentTitle(level: Incident['level'], name: string): string {
  switch (level) {
    case 'sos': return `${name} needs help`;
    case 'missed_check_in': return `${name} didn't answer a check-in`;
    case 'offline': return `${name}'s phone went offline`;
    case 'battery_dying': return `${name}'s phone is about to die`;
    case 'snatch': return `${name}'s phone may have been grabbed`;
    case 'unlocked': return `${name}'s location is shared with you`;
    default: return `${name} might not be okay`;
  }
}

export function stickyItems(me: Uuid, checkIns: CheckIn[], incidents: Incident[], nameOf: (id: Uuid) => string, nowMs: number): StickyItem[] {
  const out: StickyItem[] = [];
  for (const c of checkIns) {
    const deadlineMs = Date.parse(c.deadline_at);
    if (c.target_id === me && (c.status === 'pending' || (c.status === 'missed' && nowMs - deadlineMs < LATE_ANSWER_MS))) {
      out.push({
        key: `in:${c.id}`, title: `${nameOf(c.asker_id)} asks: you okay?`, critical: true, deadlineMs,
        body: c.status === 'missed'
          ? 'Your group was alerted because you did not answer. Tap I\'m OK to let them know.'
          : 'Tap I\'m OK to let them know. If you don\'t answer, your group gets an alert.',
      });
    } else if (c.asker_id === me && c.status === 'pending') {
      out.push({ key: `out:${c.id}`, title: `Waiting for ${nameOf(c.target_id)}`, body: 'You asked if they\'re okay. Your group is alerted if they don\'t answer.', deadlineMs });
    }
  }
  for (const i of incidents) {
    if (i.user_id === me || i.resolved_at || !STICKY_LEVELS.has(i.level)) continue;
    const name = nameOf(i.user_id);
    out.push({ key: `inc:${i.id}`, title: incidentTitle(i.level, name), body: i.summary ? `${name} ${i.summary}`.trim() : 'Tap to see what your group is doing.', critical: i.level !== 'battery_dying' });
  }
  return out;
}
