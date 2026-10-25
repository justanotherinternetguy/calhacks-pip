// Display labels for the §6 personal dashboard. Status colours are reserved (danger/warn/ok) and every
// colour is paired with text, so nothing is encoded by colour alone.
import type { Activity, IncidentKind, IncidentTier, Placement } from '@/modules/safety-native';
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
  phone_drop: 'Phone dropped', possible_fall: 'Possible fall', fall_recovered: 'Got up after fall', down_after_fall: 'Down after fall',
  hard_impact: 'Hard impact', unsteady_gait: 'Unsteady walking', stumble: 'Stumble', repeated_stumbles: 'Repeated stumbles',
  slowed_walk: 'Slow walking', phone_left_behind: 'Phone left behind', grab: 'Phone grabbed', separated: 'Separated from group',
  stopped_on_way_home: 'Stopped on the way home', in_vehicle: 'In a vehicle', battery_critical: 'Battery critical',
  check_in_missed: 'Check-in missed', typing_off: 'Typing off', scream_shout: 'Scream / shout', snoring_while_down: 'Snoring while down',
};
export const kindLabel = (k: string) => KIND_LABEL[k as IncidentKind] ?? k.replace(/_/g, ' ');

export const TIER_LABEL: Record<IncidentTier, string> = { context: 'context', watch: 'watch', danger: 'danger' };
export const tierColor = (t: IncidentTier | undefined) => (t === 'danger' ? colors.danger : t === 'watch' ? colors.warn : colors.muted);

export const PLACEMENT_LABEL: Record<Placement, string> = { unknown: 'placement unknown', pocket: 'in pocket', hand: 'in hand', bag: 'in bag' };
export const ACTIVITY_LABEL: Record<Activity, string> = { unknown: 'unknown', stationary: 'stationary', walking: 'walking', running: 'running', vehicle: 'in a vehicle' };
