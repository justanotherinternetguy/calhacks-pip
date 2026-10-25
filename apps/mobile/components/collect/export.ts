// A CollectSession as a `Recording` (tools/collect/src/schema.ts), the JSON `tools/collect` turns into
// core/traces/<scenario>/*.json for the Rust `sim` replayer. `t_ms` is relative to the first sample; the absolute
// phone time of that sample is `meta.t0_ms`. The extra top-level fields (`metrics`, `incidents`, `gaps`) are ignored
// by tools/collect and feed the calibration panel when a file is loaded back.
//
// Pure (type imports + ./session.ts) so `node --test` can run it.
import type { Activity, IncidentRecord, IncidentTier, Placement } from '@/modules/safety-native';
import { closedSegments, findSampleGaps, labelAt, sortedOrder, type BandSnap, type CollectSession, type Gap } from './session.ts';

// Mirrors of tools/collect/src/schema.ts (that package is not a dependency of the app). `rx..rz` = gyro rad/s,
// optional in the Rust MotionSample (serde default 0).
export type MotionSample = { t_ms: number; ax: number; ay: number; az: number; gx: number; gy: number; gz: number; rx: number; ry: number; rz: number };
export type ContextActivity = 'Unknown' | 'Stationary' | 'Walking' | 'Running' | 'Vehicle';
export type ContextSample = {
  t_ms: number; away_from_home: boolean; separated: boolean; hour_local: number;
  screen_on: boolean; activity: ContextActivity; battery_pct: number; speed_mps: number;
};
export type Label = { t_start_ms: number; t_end_ms: number; label: string };
export type RecordingMeta = {
  participant?: string; scenario?: string; placement?: string; device?: string; recorded_at?: string; notes?: string;
  [extra: string]: unknown;
};
export type MetricRow = {
  t_ms: number; activity: Activity; placement: Placement; evidence: string; trusted: boolean; sampling_full: boolean;
  /** operator labels at this time */
  label: string | null; placement_label: string | null;
  bands: Record<string, BandSnap>;
};
export type IncidentRow = {
  t_ms: number; id: number; kind: string; tier: IncidentTier; summary: string; sd_distance: number; placement: Placement;
  cleared_t_ms: number | null; label: string | null; raw: string;
};
export type GapRow = { kind: Gap['kind']; t_ms: number; ms: number; frames?: number };
export type CollectRecording = {
  motion: MotionSample[];
  context: ContextSample[];
  labels: Label[];
  meta: RecordingMeta;
  metrics: MetricRow[];
  incidents: IncidentRow[];
  gaps: GapRow[];
};

export const CONTEXT_ACTIVITY: Record<Activity, ContextActivity> = {
  unknown: 'Unknown', stationary: 'Stationary', walking: 'Walking', running: 'Running', vehicle: 'Vehicle',
};
/** Context rows are kept at most this often (state blocks can come faster than 1 Hz when something changes). */
const CONTEXT_MIN_MS = 900;

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function toRecording(s: CollectSession): CollectRecording {
  const m = s.motion;
  const order = sortedOrder(m.t);
  const motion: MotionSample[] = [];
  let prevT = -Infinity;
  for (const i of order) {
    const t = m.t[i];
    if (t === prevT) continue; // dedupe by phone time
    prevT = t;
    motion.push({
      t_ms: t, ax: r5(m.ax[i]), ay: r5(m.ay[i]), az: r5(m.az[i]), gx: r5(m.gx[i]), gy: r5(m.gy[i]), gz: r5(m.gz[i]),
      rx: r5(m.rx[i]), ry: r5(m.ry[i]), rz: r5(m.rz[i]),
    });
  }
  const t0 = motion.length ? motion[0].t_ms : s.t0 ?? 0;
  const tEnd = motion.length ? motion[motion.length - 1].t_ms : t0;
  for (const x of motion) x.t_ms -= t0;
  const rel = (t: number) => Math.max(0, Math.round(t - t0));
  const inside = (t: number) => t >= t0 && t <= tEnd + 1_000;

  const context: ContextSample[] = [];
  let lastCtx = -Infinity;
  for (const snap of s.metrics) {
    if (!inside(snap.t) || snap.t - lastCtx < CONTEXT_MIN_MS) continue;
    lastCtx = snap.t;
    context.push({
      t_ms: rel(snap.t), away_from_home: false, separated: false, hour_local: new Date(snap.t).getHours(),
      screen_on: false, activity: CONTEXT_ACTIVITY[snap.activity] ?? 'Unknown', battery_pct: Math.round(snap.battery), speed_mps: -1,
    });
  }

  const toLabels = (segs: CollectSession['actions']) => closedSegments(segs, tEnd)
    .map((g) => ({ label: g.label, t_start_ms: rel(g.start), t_end_ms: rel(Math.min(g.end, tEnd)) }))
    .filter((l) => l.t_end_ms > l.t_start_ms);
  const labels = [...toLabels(s.actions), ...toLabels(s.placements)].sort((a, b) => a.t_start_ms - b.t_start_ms || a.label.localeCompare(b.label));

  const metrics: MetricRow[] = s.metrics.filter((x) => inside(x.t)).map((x) => ({
    t_ms: rel(x.t), activity: x.activity, placement: x.placement, evidence: x.evidence, trusted: x.trusted, sampling_full: x.samplingFull,
    label: labelAt(s.actions, x.t), placement_label: labelAt(s.placements, x.t), bands: x.bands,
  }));
  const incidents: IncidentRow[] = s.incidents.map((r: IncidentRecord) => ({
    t_ms: Math.round(r.tMs - t0), id: r.id, kind: r.kind, tier: r.tier, summary: r.summary, sd_distance: r.sdDistance, placement: r.placement,
    cleared_t_ms: r.clearedMs > 0 ? Math.round(r.clearedMs - t0) : null, label: labelAt(s.actions, r.tMs), raw: r.rawJson,
  })).sort((a, b) => a.t_ms - b.t_ms);
  const gaps: GapRow[] = [
    ...findSampleGaps(motion.map((x) => x.t_ms)).map((g) => ({ kind: g.kind, t_ms: g.t, ms: g.ms })),
    ...s.frameGaps.map((g) => ({ kind: g.kind, t_ms: rel(g.t), ms: g.ms, frames: g.frames })),
  ].sort((a, b) => a.t_ms - b.t_ms);

  return {
    motion,
    context,
    labels,
    meta: {
      participant: s.participant,
      scenario: 'mixed',
      placement: s.placement,
      device: s.device,
      recorded_at: new Date(t0 || s.createdAt).toISOString(),
      notes: s.notes,
      t0_ms: t0,
      demo_sensitivity: s.demo,
      session_id: s.id,
      sample_gaps: gaps.filter((g) => g.kind === 'samples').length,
      frame_gaps: gaps.filter((g) => g.kind === 'frames').length,
      source: 'apps/mobile /collect',
    },
    metrics,
    incidents,
    gaps,
  };
}

/** File name for a download: participant, date and time, short id. */
export function recordingFileName(s: CollectSession): string {
  const d = new Date(s.t0 ?? s.createdAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const who = (s.participant || 'anon').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 24);
  return `collect-${who}-${stamp}-${s.id.slice(0, 6)}.json`;
}
