import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MetricBand } from '@/modules/safety-native';
import type { TelemetryBuffers } from '@/lib/telemetry';
import { colors, radius } from '@/lib/theme';
import { LiveCanvas } from './LiveCanvas';
import type { DrawFn } from './LiveCanvas.types';
import { drawSdSparkline, fill } from './draw';
import { fmtSd, fmtValue, metricLabel } from './labels';

const FLASH_MS = 1_500;
const SPARK_SECONDS = 60;

/** Local ms of the newest in-band → out-of-band transition for `name` (undefined if never / not in history). */
function lastOutOfBandAt(buffers: TelemetryBuffers, name: string): number | undefined {
  const t = buffers.trend;
  let i = t.length - 1;
  if (i < 0 || t[i].inBand[name] !== false) return undefined; // currently in band (or unknown)
  while (i > 0 && t[i - 1].inBand[name] === false) i--; // walk back to the start of this out-of-band run
  return t[i].at;
}

/**
 * Telemetry variant of the dashboard MetricTile: value, signed SD distance, a 60-s sd_distance sparkline,
 * and a short flash the moment the metric leaves its band (derived from the trend history, no local state).
 */
export function TelemetryTile({ b, buffers, bandSd, now, style }: { b: MetricBand; buffers: TelemetryBuffers; bandSd: number; now: number; style?: object }) {
  const { label, unit } = metricLabel(b.name);
  const out = !b.inBand;
  const outAt = out ? lastOutOfBandAt(buffers, b.name) : undefined;
  const flashing = outAt != null && now - outAt < FLASH_MS;
  const tint = out ? colors.danger : colors.text;

  const draw = useMemo<DrawFn>(() => (ctx, w, h, nowMs) => {
    fill(ctx, w, h, colors.bg);
    const cur = buffers.tick?.metrics.bands.find((x) => x.name === b.name);
    drawSdSparkline(ctx, { x: 0, y: 2, w, h: h - 4 }, buffers.trend, b.name, nowMs, SPARK_SECONDS, bandSd, cur ? !cur.inBand : false);
  }, [buffers, b.name, bandSd]);

  return (
    <View style={[styles.tile, out && { borderColor: colors.danger }, flashing && styles.flash, style]}>
      <View style={styles.top}>
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
        {out && <Text style={styles.outLabel}>out of band</Text>}
      </View>
      <View style={styles.valueRow}>
        <Text style={[styles.value, { color: tint }]} numberOfLines={1}>
          {fmtValue(b.name, b.value)}{unit ? <Text style={styles.unit}> {unit}</Text> : null}
        </Text>
        <Text style={[styles.sd, { color: out ? colors.danger : colors.muted }]}>{fmtSd(b.sdDistance)}</Text>
      </View>
      <LiveCanvas draw={draw} height={30} fps={5} style={styles.spark} placeholder="" />
      <Text style={styles.small} numberOfLines={1}>{fmtValue(b.name, b.mean)} ± {fmtValue(b.name, bandSd * b.sd)} · 60 s</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { backgroundColor: colors.card, borderRadius: radius - 4, padding: 10, gap: 6, borderWidth: 1, borderColor: colors.border },
  flash: { backgroundColor: `${colors.danger}26`, borderColor: colors.danger },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 6 },
  label: { color: colors.muted, fontSize: 12, flexShrink: 1 },
  outLabel: { color: colors.danger, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  valueRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 },
  value: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  unit: { color: colors.muted, fontSize: 11, fontWeight: '400' },
  sd: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  spark: { borderWidth: 0, borderRadius: 6 },
  small: { color: colors.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
});
