// Recorded-trace JSON written by the debug trace recorder (PLAN M2) and the
// collect build flavor. Field names mirror docs/CONTRACTS.md §1 Rust records.

/** `rx..rz`: gyroscope (rad/s), present in recordings from the /collect page; the Rust side defaults them to 0. */
export type MotionSample = { t_ms: number; ax: number; ay: number; az: number; gx: number; gy: number; gz: number; rx?: number; ry?: number; rz?: number };
export type Activity = 'Unknown' | 'Stationary' | 'Walking' | 'Running' | 'Vehicle';
export type ContextSample = {
  t_ms: number; away_from_home: boolean; separated: boolean; hour_local: number;
  screen_on: boolean; activity: Activity; battery_pct: number; speed_mps: number;
};
/** One ~1 s listening-window frame: YAMNet scores + estimated level (dB SPL). Older files may carry `glass` instead. */
export type AudioSample = { t_ms: number; scream: number; shout: number; snore?: number; level_db?: number; distress?: number };
export type UserAction =
  | 'DismissOk' | 'DismissWrongPhrase' | 'NeedHelp' | 'ManualSos'
  | 'BiometricDismiss' | 'FriendMarkedSafe' | 'CheckTimeout';
export type ActionSample = { t_ms: number; action: UserAction };
export type Label = { t_start_ms: number; t_end_ms: number; label: string };

export type Recording = {
  motion: MotionSample[];
  context: ContextSample[];
  audio?: AudioSample[];
  actions?: ActionSample[];
  labels?: Label[];
  meta?: { participant?: string; scenario?: string; placement?: string; device?: string; recorded_at?: string; notes?: string };
};

// M7 study scenarios → folder name, and what the sim gate expects per scenario.
// `max_escalation` is the highest EscalationLevel the pipeline may reach without
// counting as a false alarm; `min_escalation` is what it must reach (detection).
export const SCENARIOS = {
  normal_walking:     { max_escalation: 'Idle',    min_escalation: null },
  impairment_goggles: { max_escalation: 'Check',   min_escalation: null },
  padded_fall:        { max_escalation: 'Unlocked', min_escalation: 'Check' },
  phone_drop:         { max_escalation: 'Idle',    min_escalation: null },
  dancing:            { max_escalation: 'Check',   min_escalation: null },
  sitting:            { max_escalation: 'Idle',    min_escalation: null },
  transit:            { max_escalation: 'Idle',    min_escalation: null },
  // Actions labelled on the /collect page (apps/mobile/app/collect.tsx).
  slow_walking:       { max_escalation: 'Idle',    min_escalation: null },
  fast_walking:       { max_escalation: 'Idle',    min_escalation: null },
  stairs_up:          { max_escalation: 'Idle',    min_escalation: null },
  stairs_down:        { max_escalation: 'Idle',    min_escalation: null },
  running:            { max_escalation: 'Idle',    min_escalation: null },
  standing:           { max_escalation: 'Idle',    min_escalation: null },
  lying_down:         { max_escalation: 'Idle',    min_escalation: null },
  vehicle:            { max_escalation: 'Idle',    min_escalation: null },
  unsteady_walking:   { max_escalation: 'Check',   min_escalation: null },
  stumbling:          { max_escalation: 'Check',   min_escalation: null },
  fall:               { max_escalation: 'Unlocked', min_escalation: 'Check' },
  phone_grab:         { max_escalation: 'Snatch',  min_escalation: 'Snatch' },
} as const;
export type Scenario = keyof typeof SCENARIOS;
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as Scenario[];

// Extra segment labels allowed inside a recording (besides scenario names).
export const EXTRA_LABELS = ['stumble', 'impact', 'still', 'pickup', 'in_hand', 'in_pocket', 'in_bag', 'screen_on', 'noise', 'transition'] as const;
export const ALL_LABELS: readonly string[] = [...SCENARIO_NAMES, ...EXTRA_LABELS];

// One file the sim consumes: core/traces/<scenario>/<id>.json
export type SimTrace = {
  version: 1;
  id: string;
  scenario: Scenario;
  expect: { max_escalation: string; min_escalation: string | null };
  /** Recording meta plus what the Rust sim reads (synth::TraceMeta): expect, night_mode, hour_local, incident_t_ms, seed. */
  meta: NonNullable<Recording['meta']> & {
    scenario: string; expect: 'quiet' | 'unlock' | 'snatch'; night_mode: boolean; hour_local: number; incident_t_ms: number | null; seed: number;
  };
  motion: MotionSample[];
  context: ContextSample[];
  audio: AudioSample[];
  actions: ActionSample[];
  labels: Label[];
};

export function isRecording(x: unknown): x is Recording {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return Array.isArray(r.motion) && Array.isArray(r.context);
}

export function isScenario(s: string): s is Scenario {
  return (SCENARIO_NAMES as string[]).includes(s);
}
