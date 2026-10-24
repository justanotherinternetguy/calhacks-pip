import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MetricBand } from '@/modules/safety-native';
import { colors, radius } from '@/lib/theme';
import { fmtSd, fmtValue, metricLabel } from './labels';

const BAND_SD = 2.5; // band drawn as mean ± 2.5 SD
const SCALE_SD = 5; // the range bar spans mean ± 5 SD; the marker clamps at the edges

/** One live metric vs its baseline band: value, band range bar with a marker, signed SD distance. Red + "out of band" when outside. */
export function MetricTile({ b, style }: { b: MetricBand; style?: object }) {
  const { label, unit } = metricLabel(b.name);
  const out = !b.inBand;
  const tint = out ? colors.danger : colors.text;
  const pos = (sd: number) => `${((Math.max(-SCALE_SD, Math.min(SCALE_SD, sd)) + SCALE_SD) / (2 * SCALE_SD)) * 100}%` as const;
  const bandLeft = pos(-BAND_SD);
  const bandWidth = `${(2 * BAND_SD) / (2 * SCALE_SD) * 100}%` as const;
  return (
    <View style={[styles.tile, out && { borderColor: colors.danger }, style]}>
      <View style={styles.top}>
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
        {out && <Text style={styles.outLabel}>out of band</Text>}
      </View>
      <Text style={[styles.value, { color: tint }]} numberOfLines={1}>
        {fmtValue(b.name, b.value)}{unit ? <Text style={styles.unit}> {unit}</Text> : null}
      </Text>
      <View style={styles.track}>
        <View style={[styles.band, { left: bandLeft, width: bandWidth }]} />
        <View style={[styles.meanTick, { left: pos(0) }]} />
        <View style={[styles.marker, { left: pos(b.sdDistance), backgroundColor: out ? colors.danger : colors.accent }]} />
      </View>
      <View style={styles.bottom}>
        <Text style={styles.small} numberOfLines={1}>{fmtValue(b.name, b.mean)} ± {fmtValue(b.name, BAND_SD * b.sd)}</Text>
        <Text style={[styles.small, { color: out ? colors.danger : colors.muted, fontWeight: '600' }]}>{fmtSd(b.sdDistance)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { backgroundColor: colors.card, borderRadius: radius, padding: 12, gap: 8, borderWidth: 1, borderColor: colors.border },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 6 },
  label: { color: colors.muted, fontSize: 12, flexShrink: 1 },
  outLabel: { color: colors.danger, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  unit: { color: colors.muted, fontSize: 12, fontWeight: '400' },
  track: { height: 10, backgroundColor: colors.bg, borderRadius: 5, position: 'relative', overflow: 'visible', justifyContent: 'center' },
  band: { position: 'absolute', top: 0, bottom: 0, backgroundColor: colors.border, borderRadius: 5 },
  meanTick: { position: 'absolute', top: 0, bottom: 0, width: 1, marginLeft: -0.5, backgroundColor: colors.muted },
  marker: { position: 'absolute', width: 10, height: 10, borderRadius: 5, marginLeft: -5, borderWidth: 2, borderColor: colors.card },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  small: { color: colors.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
});
