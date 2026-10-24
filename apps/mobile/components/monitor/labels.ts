import type { IncidentEventKind } from '@/lib/types';
import { colors } from '@/lib/theme';

/** Same wording as app/incident/[id].tsx so the dashboard and the phone screen read alike. */
export const EVENT_LABEL: Record<IncidentEventKind, string> = {
  nudge: 'asked "you okay?"', heads_up: 'friends notified', release: 'location unlocked', ring: 'rang the phone', en_route: 'is on the way',
  called_911: 'called 911', called_campus: 'called campus safety', found: 'found them', resolved: 'marked safe', unlock_requested: 'requested fallback unlock',
  unlock_approved: 'approved unlock', phone_offline: 'phone went offline', battery_dying: 'battery dying',
};

/** audit_log.kind values written by the definer triggers in supabase/migrations/0002_rls.sql. */
export const AUDIT_LABEL: Record<string, string> = {
  key_released: 'released a location key', unlock_requested: 'requested fallback unlock', unlock_approved: 'approved an unlock',
  ring: 'rang the phone', en_route: 'is on the way', called_911: 'called 911', called_campus: 'called campus safety', found: 'found them', release: 'location unlocked',
};

export const RISK_COLOR = [colors.ok, colors.accent, colors.warn, colors.danger] as const;
export const riskColor = (band: number | null | undefined) => RISK_COLOR[Math.min(3, Math.max(0, band ?? 0))];

/** Heartbeat freshness: quiet under 3 min, amber past 3, red past 10 (device heartbeats every 2 min in night mode). */
export function heartbeatAge(lastHeartbeat: string | null | undefined, nowMs: number): { text: string; color: string } {
  if (!lastHeartbeat) return { text: 'no heartbeat yet', color: colors.muted };
  const s = Math.max(0, Math.round((nowMs - new Date(lastHeartbeat).getTime()) / 1000));
  const text = s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
  const color = s > 600 ? colors.danger : s > 180 ? colors.warn : colors.ok;
  return { text, color };
}
