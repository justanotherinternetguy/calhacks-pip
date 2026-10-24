import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { TelemetryTick } from '@/modules/safety-native';
import { Pill } from '@/components/ui';
import type { TelemetryBuffers } from '@/lib/telemetry';
import { colors, radius } from '@/lib/theme';
import { TelemetryTile } from './TelemetryTile';
import { ACTIVITY_LABEL, PLACEMENT_LABEL } from './labels';

/** Under the motion waveforms: the eight metric bands as compact tiles (4 per row) and the engine's notes. */
export function MetricsPanel({ tick, buffers, now }: { tick: TelemetryTick | null; buffers: TelemetryBuffers; now: number }) {
  const m = tick?.metrics ?? null;
  const bandSd = m ? (m.baselineTrusted ? 2.5 : 3.5) : 2.5;
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.head}>
        <Text style={styles.title}>Metrics vs baseline</Text>
        <Text style={styles.meta}>band = mean ± {bandSd} SD{m && !m.baselineTrusted ? ' (population defaults)' : ''}</Text>
      </View>
      <View style={styles.grid}>
        {m ? m.bands.map((b) => <TelemetryTile key={b.name} b={b} buffers={buffers} bandSd={bandSd} now={now} style={styles.cell} />) : (
          <Text style={styles.meta}>Metric tiles appear with the first tick.</Text>
        )}
      </View>
      <View style={styles.evidence}>
        <View style={styles.pills}>
          {m && <Pill text={PLACEMENT_LABEL[m.placement] ?? m.placement} color={colors.accent} />}
          {m && <Pill text={ACTIVITY_LABEL[m.activity] ?? m.activity} color={colors.muted} />}
          {m && <Pill text={m.baselineTrusted ? 'baseline trusted' : `baseline ${m.baselineWalkDays.toFixed(1).replace(/\.0$/, '')} / 7 days`} color={m.baselineTrusted ? colors.ok : colors.muted} />}
          {tick && <Text style={styles.meta}>seq {tick.seq}</Text>}
        </View>
        <Text style={styles.evidenceText}>{m?.evidence || 'Evidence line: what the engine currently believes and why.'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cell: { flexBasis: '23%', flexGrow: 1, minWidth: 120 },
  evidence: { backgroundColor: colors.card, borderRadius: radius, paddingVertical: 8, paddingHorizontal: 10, gap: 6, borderWidth: 1, borderColor: colors.border },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  evidenceText: { color: colors.text, fontSize: 13, lineHeight: 18 },
});
