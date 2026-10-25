// Friend actions on an escalated incident, shared by the incident screen and the monitor's escalation dock.
// Every action logs an incident_events row (the subject and the group see it in the timeline, sensitive ones are
// audited) before it does anything else. Calls are the friend's own: the app never dials on its own.
import { Linking } from 'react-native';
import { format } from 'date-fns';
import { fn, rpc } from '@/lib/db';
import { sendTelemetryCommand } from '@/lib/telemetry';
import type { DecryptedLocation } from '@/modules/safety-native';
import type { Incident, IncidentEventKind, Uuid } from '@/lib/types';

export type IncidentActionContext = {
  incident: Pick<Incident, 'id' | 'user_id' | 'summary' | 'level'>;
  subjectName: string;
  /** the friend acting, for "requested by …" on the subject's phone */
  myName: string;
  /** other friends to alert (never the subject or me) */
  friendIds: Uuid[];
};

const event = (incidentId: Uuid, kind: IncidentEventKind, payload: Record<string, unknown> = {}) =>
  rpc.addIncidentEvent({ incident_id: incidentId, kind, payload });

export const dial = (number: string) => Linking.openURL(`tel:${number.replace(/[^\d+]/g, '')}`);

/** Loud alarm on the subject's phone (critical push, alarm channel). */
export async function ringPhone(c: IncidentActionContext) {
  await fn.push({ incidentId: c.incident.id, kind: 'ring', title: 'Your friends are ringing you', body: `${c.myName} is trying to reach you`, recipients: [c.incident.user_id], critical: true, data: { route: '/home' } });
  await event(c.incident.id, 'ring');
}

/** Critical push to every other friend in the group. */
export async function alertGroup(c: IncidentActionContext) {
  if (!c.friendIds.length) throw new Error('No other friends in the group to alert');
  await event(c.incident.id, 'escalated');
  await fn.push({
    incidentId: c.incident.id, kind: 'escalated', title: `${c.subjectName} needs help`,
    body: `${c.myName} escalated: ${c.incident.summary ?? 'no response'}. Open the app.`, recipients: c.friendIds, critical: true,
  });
}

export async function callPerson(c: IncidentActionContext, phone: string | null | undefined) {
  if (!phone) throw new Error(`No phone number on ${c.subjectName}'s profile`);
  await dial(phone);
}

export async function call911(c: IncidentActionContext) {
  await event(c.incident.id, 'called_911');
  await dial('911');
}

export async function callCampus(c: IncidentActionContext, number: string) {
  await event(c.incident.id, 'called_campus');
  await dial(number);
}

export const enRoute = (c: IncidentActionContext) => event(c.incident.id, 'en_route');

/** Resolve on the server, then tell the phone (instantly over telemetry-cmd; its heartbeat poll is the backstop). */
export async function markSafe(c: IncidentActionContext) {
  await event(c.incident.id, 'found');
  await rpc.resolveIncident(c.incident.id);
  await sendTelemetryCommand(c.incident.user_id, { cmd: 'friend_marked_safe', incidentId: c.incident.id, by: c.myName });
}

/**
 * Ask the phone to release its location now. The request is logged (audited) first; the phone checks the incident is
 * open and escalated, releases the current hour keys to the group and tells its owner who asked. Keys then arrive
 * over Realtime (released_keys). Resolves to the command send status ('ok' or why it could not be sent; the phone's
 * heartbeat poll still picks the logged request up within ~2 min).
 */
export async function requestLocation(c: IncidentActionContext): Promise<string> {
  const requestId = await event(c.incident.id, 'location_requested');
  return sendTelemetryCommand(c.incident.user_id, { cmd: 'release_location', incidentId: c.incident.id, requestId: requestId ?? undefined, by: c.myName });
}

/** What to tell a dispatcher (shown and copyable next to the call buttons). */
export function dispatcherText(c: Pick<IncidentActionContext, 'subjectName' | 'incident'>, last: DecryptedLocation | undefined) {
  const where = last
    ? `Last location ${last.lat.toFixed(5)}, ${last.lng.toFixed(5)} (±${Math.round(last.accuracyM)} m) at ${format(last.tMs, 'HH:mm')}.`
    : 'Location not available yet.';
  return `${c.subjectName} may need help. ${c.incident.summary ?? 'No response to a safety check-in'}. ${where} Reported by the Pip app.`;
}
