// Display labels for the §6 personal dashboard. Status colours are reserved (danger/warn/ok) and every
// colour is paired with text, so nothing is encoded by colour alone.
import type { Activity, IncidentKind, Placement } from '@/modules/safety-native';
import { colors } from '@/lib/theme';

export const METRIC_LABEL: Record<string, { label: string; unit: string; digits: number }> = {
  cadence: { label: 'Cadence', unit: 'steps/min', digits: 0 },
  stride_cv: { label: 'Stride variability', unit: 'CV', digits: 3 },
  regularity: { label: 'Regularity', unit: '', digits: 2 },
  sway: { label: 'Sway', unit: '', digits: 3 },
  wobble: { label: 'Wobble', unit: '', digits: 3 },
  jerk: { label: 'Jerk', unit: 'g/s', digits: 1 },
  rotation: { label: 'Rotation', unit: '°/s', digits: 0 },
  peak_g: { label: 'Peak accel', unit: 'g', digits: 2 },
};
export const metricLabel = (name: string) => METRIC_LABEL[name] ?? { label: name.replace(/_/g, ' '), unit: '', digits: 2 };
export const fmtValue = (name: string, v: number) => {
  const d = metricLabel(name).digits;
  return Number.isFinite(v) ? v.toFixed(d) : '—';
};
export const fmtSd = (sd: number) => `${sd > 0 ? '+' : ''}${sd.toFixed(1)} SD`;

export const KIND_LABEL: Record<IncidentKind, string> = {
  gait_drift: 'gait drift', impact: 'impact', grab: 'grab', stillness: 'stillness', separated: 'separated', typing_off: 'typing off',
};
export const kindColor = (k: IncidentKind) =>
  ({ gait_drift: colors.warn, impact: colors.danger, grab: colors.danger, stillness: colors.danger, separated: colors.warn, typing_off: colors.warn })[k] ?? colors.muted;

export const PLACEMENT_LABEL: Record<Placement, string> = { unknown: 'placement unknown', pocket: 'in pocket', hand: 'in hand', bag: 'in bag' };
export const ACTIVITY_LABEL: Record<Activity, string> = { unknown: 'unknown', stationary: 'stationary', walking: 'walking', running: 'running', vehicle: 'in a vehicle' };

export const STATE_LABEL = ['Normal', 'Impaired', 'Incident', 'Unresponsive'] as const;
export const STATE_COLOR = [colors.ok, colors.warn, colors.danger, colors.danger] as const;
