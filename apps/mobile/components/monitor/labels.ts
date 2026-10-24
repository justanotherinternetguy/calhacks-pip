import type { IncidentEventKind } from '@/lib/types';

/** Same wording as app/incident/[id].tsx so the dashboard and the phone screen read alike. */
export const EVENT_LABEL: Record<IncidentEventKind, string> = {
  nudge: 'asked "you okay?"', heads_up: 'friends notified', release: 'location unlocked', ring: 'rang the phone', en_route: 'is on the way',
  called_911: 'called 911', called_campus: 'called campus safety', found: 'found them', resolved: 'marked safe', unlock_requested: 'requested fallback unlock',
  unlock_approved: 'approved unlock', phone_offline: 'phone went offline', battery_dying: 'battery dying',
};
