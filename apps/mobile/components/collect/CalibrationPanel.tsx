import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { kindLabel } from '@/components/telemetry/labels';
import { colors, radius } from '@/lib/theme';
import { actionTitle } from './actions';
import {
  DEFAULT_SIM, GAIT_METRICS, MIN_BASELINE_WINDOWS, SWEEP_K, SWEEP_P, UNSTEADY_METRICS, labelStats, personalBaseline,
  segmentWindows, simulateLabels, sweep, type LabelSim, type SimParams, type SweepCell, type UnsteadyMetric,
} from './analysis';
import type { CollectSession } from './session';

const DIGITS: Record<string, number> = { stride_cv: 3, regularity: 2, sway: 3, wobble: 1, cadence: 0 };
const fmt = (m: string, v: number) => (Number.isFinite(v) ? v.toFixed(DIGITS[m] ?? 2) : '-');
const pct = (v: number | null) => (v == null ? '-' : `${v.toFixed(0)}%`);
const secs = (s: number) => (s >= 90 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);

/**
 * Calibration over recorded sessions (the open one or all saved ones): per-label gait statistics, a personal baseline
 * from normal walking, and a replay of the unsteady-walking rule with other thresholds (components/collect/analysis.ts).
 * `version` changes whenever the data grew, so a live session re-analyses as it records.
 */
export function CalibrationPanel({ sessions, version, scopeLabel }: { sessions: CollectSession[]; version: string; scopeLabel: string }) {
  const [p, setP] = useState<SimParams>(DEFAULT_SIM);
  const segs = useMemo(() => segmentWindows(sessions), [sessions, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const stats = useMemo(() => labelStats(segs), [segs]);
  const base = useMemo(() => personalBaseline(segs), [segs]);
  const sim = useMemo(() => simulateLabels(segs, p, base), [segs, p, base]);
  const grid = useMemo(() => sweep(segs, base, p), [segs, base, p]);
  const set = (o: Partial<SimParams>) => setP((x) => ({ ...x, ...o }));
  const toggleMetric = (m: UnsteadyMetric) => set({ metrics: p.metrics.includes(m) ? p.metrics.filter((x) => x !== m) : [...p.metrics, m] });
  const basePlacements = Object.keys(base);
  const noBase = p.source === 'personal' && !basePlacements.length;

  if (!segs.length) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Calibration</Text>
        <Text style={styles.meta}>No labelled data in {scopeLabel}. Record a session, or open a saved one.</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>Per action</Text>
          <Text style={styles.meta}>{scopeLabel} · walking windows only for the metrics · p10 / median / p90 · out of band = phone's current config</Text>
        </View>
        <ScrollView horizontal>
          <View>
            <Row header cells={['Action', 'Time', 'Walk win.', 'Out of band', ...GAIT_METRICS, 'Incidents']} widths={W_STATS} />
            {stats.map((s) => (
              <Row key={s.label} widths={W_STATS} cells={[
                actionTitle(s.label), secs(s.seconds), String(s.walking), pct(s.oobPct),
                ...GAIT_METRICS.map((m) => {
                  const x = s.metrics[m];
                  if (!x.n) return '-';
                  return `${fmt(m, x.p10)} / ${fmt(m, x.median)} / ${fmt(m, x.p90)}${x.oobPct != null && x.oobPct > 0 ? `  (${x.oobPct.toFixed(0)}%)` : ''}`;
                }),
                Object.entries(s.incidents).map(([k, n]) => `${kindLabel(k)} ×${n}`).join(', ') || '-',
              ]} />
            ))}
          </View>
        </ScrollView>
      </View>

      <View style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>Personal baseline</Text>
          <Text style={styles.meta}>mean ± SD over normal walking, per placement</Text>
        </View>
        {basePlacements.length === 0 && <Text style={styles.meta}>No normal walking recorded yet. Record a few minutes of it with the phone where it will be at night.</Text>}
        {basePlacements.length > 0 && (
          <ScrollView horizontal>
            <View>
              <Row header cells={['Placement', 'Windows', ...GAIT_METRICS]} widths={W_BASE} />
              {basePlacements.map((pl) => (
                <Row key={pl} widths={W_BASE} warn={base[pl].n < MIN_BASELINE_WINDOWS} cells={[
                  pl, `${base[pl].n}${base[pl].n < MIN_BASELINE_WINDOWS ? ` (need ${MIN_BASELINE_WINDOWS})` : ''}`,
                  ...GAIT_METRICS.map((m) => { const x = base[pl].stats[m]; return x.n ? `${fmt(m, x.mean)} ± ${fmt(m, x.sd)}` : '-'; }),
                ]} />
              ))}
            </View>
          </ScrollView>
        )}
      </View>

      <View style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>Unsteady walking rule</Text>
          <Text style={styles.meta}>replays the engine's rule on the recorded 1 Hz windows; each action segment on its own</Text>
        </View>
        <View style={styles.controls}>
          <Stepper label="k (SD)" value={p.k} step={0.5} min={0.5} onChange={(k) => set({ k })} />
          <Stepper label="Persist (s)" value={p.persistS} step={5} min={1} onChange={(persistS) => set({ persistS })} />
          <Stepper label="Clear (s)" value={p.clearS} step={30} min={30} onChange={(clearS) => set({ clearS })} />
          <View style={styles.group}>
            <Text style={styles.groupLabel}>Metrics</Text>
            {UNSTEADY_METRICS.map((m) => <Chip key={m} label={m} on={p.metrics.includes(m)} onPress={() => toggleMetric(m)} />)}
          </View>
          <View style={styles.group}>
            <Text style={styles.groupLabel}>Off at once</Text>
            {[1, 2].map((n) => <Chip key={n} label={`${n}+`} on={p.requireN === n} onPress={() => set({ requireN: n })} />)}
          </View>
          <View style={styles.group}>
            <Text style={styles.groupLabel}>Band from</Text>
            <Chip label="personal baseline" on={p.source === 'personal'} onPress={() => set({ source: 'personal' })} />
            <Chip label="phone's band" on={p.source === 'phone'} onPress={() => set({ source: 'phone' })} />
          </View>
          <Pressable onPress={() => setP(DEFAULT_SIM)} style={({ pressed }) => [styles.reset, pressed && { opacity: 0.7 }]}>
            <Text style={styles.resetText}>Reset</Text>
          </Pressable>
        </View>
        {noBase && <Text style={[styles.meta, { color: colors.warn }]}>No personal baseline yet: windows use the phone's recorded band instead.</Text>}
        <ScrollView horizontal>
          <View>
            <Row header cells={['Action', 'Segments', 'Walking', 'Off windows', 'Fired', 'Fires / min', 'First fire', 'Verdict']} widths={W_SIM} />
            {sim.map((r) => <Row key={r.label} widths={W_SIM} tone={verdictTone(r)} cells={[
              actionTitle(r.label), String(r.segments), secs(r.walkingS), pct(r.offPct), `${r.segmentsFired} / ${r.segments}`,
              r.firesPerMin == null ? '-' : r.firesPerMin.toFixed(2), r.firstFireS == null ? '-' : `${Math.round(r.firstFireS)} s`, verdict(r),
            ]} />)}
          </View>
        </ScrollView>
      </View>

      <View style={styles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>Sweep</Text>
          <Text style={styles.meta}>false alarms on steady walking (per min, % of segments) vs detection on unsteady and stumbling (% of segments, median time). Tap a cell to use it.</Text>
        </View>
        <ScrollView horizontal>
          <View>
            <View style={styles.row}>
              <Text style={[styles.cell, styles.th, { width: 64 }]}>k \ P</Text>
              {SWEEP_P.map((ps) => <Text key={ps} style={[styles.cell, styles.th, { width: W_CELL + 4, paddingLeft: 8 }]}>{ps} s</Text>)}
            </View>
            {grid.map((line, i) => (
              <View key={SWEEP_K[i]} style={styles.row}>
                <Text style={[styles.cell, styles.th, { width: 64 }]}>{SWEEP_K[i]}</Text>
                {line.map((c) => <SweepCellView key={c.persistS} c={c} on={c.k === p.k && c.persistS === p.persistS} onPress={() => set({ k: c.k, persistS: c.persistS })} />)}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const W_STATS = [150, 70, 80, 90, 190, 150, 170, 150, 120, 260];
const W_BASE = [100, 120, 150, 150, 150, 150, 120];
const W_SIM = [150, 80, 90, 100, 80, 90, 90, 140];
const W_CELL = 150;

function verdict(r: LabelSim): string {
  if (!r.walkingS) return 'no walking';
  if (r.kind === 'steady') return r.fires ? 'false alarm' : 'ok';
  if (r.kind === 'unsteady') return r.segmentsFired === r.segments ? 'caught' : r.segmentsFired ? 'partly missed' : 'missed';
  return r.fires ? 'fired' : '-';
}
const verdictTone = (r: LabelSim): 'bad' | 'good' | undefined => {
  if (!r.walkingS || r.kind === 'other') return undefined;
  if (r.kind === 'steady') return r.fires ? 'bad' : 'good';
  return r.segmentsFired === r.segments ? 'good' : 'bad';
};

function SweepCellView({ c, on, onPress }: { c: SweepCell; on: boolean; onPress: () => void }) {
  const good = (c.faPerMin ?? 0) === 0 && (c.detPct == null || c.detPct === 100);
  const fa = c.faPerMin == null ? 'FA -' : `FA ${c.faPerMin.toFixed(2)}/min · ${pct(c.faSegPct)}`;
  const det = c.detPct == null ? 'Det -' : `Det ${pct(c.detPct)}${c.detFirstS != null ? ` · ${Math.round(c.detFirstS)} s` : ''}`;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.sweep, { width: W_CELL }, on && { borderColor: colors.accent }, pressed && { opacity: 0.7 }]}>
      <Text style={[styles.sweepText, (c.faPerMin ?? 0) > 0 && { color: colors.danger }]}>{fa}</Text>
      <Text style={[styles.sweepText, good && { color: colors.ok }]}>{det}</Text>
    </Pressable>
  );
}

function Row({ cells, widths, header, warn, tone }: { cells: string[]; widths: number[]; header?: boolean; warn?: boolean; tone?: 'bad' | 'good' }) {
  return (
    <View style={[styles.row, header && styles.headRow]}>
      {cells.map((c, i) => (
        <Text key={i} style={[styles.cell, header && styles.th, { width: widths[i] ?? 120 },
          warn && i < 2 && { color: colors.warn },
          tone && i === cells.length - 1 && { color: tone === 'bad' ? colors.danger : colors.ok, fontWeight: '700' }]}>{c}</Text>
      ))}
    </View>
  );
}

function Stepper({ label, value, step, min, onChange }: { label: string; value: number; step: number; min: number; onChange: (v: number) => void }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <Chip label="−" on={false} onPress={() => onChange(Math.max(min, +(value - step).toFixed(2)))} />
      <Text style={styles.value}>{value}</Text>
      <Chip label="+" on={false} onPress={() => onChange(+(value + step).toFixed(2))} />
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && { opacity: 0.7 }]}>
      <Text style={[styles.chipText, on && { color: colors.accent }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: 10, padding: 14, borderRadius: radius, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 12, flexShrink: 1 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border },
  headRow: { borderBottomColor: colors.muted },
  cell: { color: colors.text, fontSize: 12, paddingVertical: 6, paddingRight: 10, fontVariant: ['tabular-nums'] },
  th: { color: colors.muted, fontWeight: '700' },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center' },
  group: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  groupLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  value: { color: colors.text, fontSize: 14, fontWeight: '800', minWidth: 30, textAlign: 'center', fontVariant: ['tabular-nums'] },
  chip: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  chipOn: { borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  reset: { paddingVertical: 5, paddingHorizontal: 10 },
  resetText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  sweep: { paddingVertical: 6, paddingHorizontal: 8, marginRight: 4, marginVertical: 2, borderRadius: 8, borderWidth: 1, borderColor: 'transparent', gap: 2 },
  sweepText: { color: colors.text, fontSize: 11, fontVariant: ['tabular-nums'] },
});
