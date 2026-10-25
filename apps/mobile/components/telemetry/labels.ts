// Labels and colours for the telemetry console. Status colours are the theme's reserved set and every colour
// is paired with text. Metric / kind / placement labels are shared with the personal dashboard.
import type { EscalationLevel } from '@/modules/safety-native';
import type { TelemetryConnState } from '@/lib/telemetry';
import { colors, ht } from '@/lib/theme';

export { ACTIVITY_LABEL, KIND_LABEL, PLACEMENT_LABEL, TIER_LABEL, fmtSd, fmtValue, kindLabel, metricLabel, tierColor } from '@/components/dashboard/labels';

/** Engine events as they arrive in `tick.events` (CONTRACTS §7, snake_case). */
export const ENGINE_EVENT_LABEL: Record<string, string> = {
  check_requested: 'check-in requested', heads_up: 'friends notified (heads-up)', unlock_location: 'location unlocked', snatch_detected: 'snatch detected',
  resolved: 'resolved', battery_dying: 'battery dying', sampling_rate_changed: 'sampling rate changed',
  audio_listening: 'mic listening window', signal_incident: 'incident opened', incident_cleared: 'incident cleared', incident_log_cleared: 'incident log reset', call_option: 'call option available',
};
export const engineEventLabel = (name: string) => ENGINE_EVENT_LABEL[name] ?? name.replace(/_/g, ' ');
export const engineEventColor = (name: string) =>
  ({ check_requested: colors.warn, heads_up: colors.warn, unlock_location: colors.danger, snatch_detected: colors.danger, call_option: colors.danger, battery_dying: colors.warn, resolved: colors.ok, signal_incident: colors.warn, incident_cleared: colors.ok } as Record<string, string>)[name] ?? colors.muted;
/** Events that should make the console beep (escalation steps + call option). */
export const ALERT_EVENTS = new Set(['check_requested', 'heads_up', 'unlock_location', 'snatch_detected', 'call_option']);

export const ESCALATION_LABEL: Record<EscalationLevel, string> = { idle: 'idle', check: 'check-in', heads_up: 'heads-up', unlocked: 'unlocked', snatch: 'snatch', resolved: 'resolved' };

export const CONN_LABEL: Record<TelemetryConnState, string> = {
  connecting: 'connecting', subscribed: 'subscribed · waiting', live: 'live', stale: 'stale', error: 'error', closed: 'closed',
};
export const connColor = (s: TelemetryConnState | undefined) =>
  s === 'live' ? colors.ok : s === 'stale' || s === 'subscribed' || s === 'connecting' ? colors.warn : s ? colors.danger : colors.muted;

export const batteryColor = (pct: number | null | undefined) => (pct == null ? colors.muted : pct <= 15 ? colors.danger : pct <= 30 ? colors.warn : colors.text);

/** Distinct hues for incident sequences (sequence_id > 0) so related records read as one chain. */
const SEQ_HUES = [ht.skyDeep, ht.lilacDeep, ht.coralDeep, ht.butterDeep, ht.mintDeep, ht.inkSoft];
export const sequenceColor = (seq: number) => SEQ_HUES[(Math.max(1, seq) - 1) % SEQ_HUES.length];

export const fmtClock = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
export const fmtClockMs = (ms: number) => `${fmtClock(ms)}.${String(new Date(ms).getMilliseconds()).padStart(3, '0').slice(0, 1)}`;
export const fmtCountdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
