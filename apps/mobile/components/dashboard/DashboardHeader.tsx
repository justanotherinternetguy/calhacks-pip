import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LiveMetrics } from '@/modules/safety-native';
import { Pill, Row } from '@/components/ui';
import { colors, radius } from '@/lib/theme';
import { ACTIVITY_LABEL, PLACEMENT_LABEL } from './labels';

/** Placement · sampling mode · baseline trust · activity. Everything here is a label, no colour-only state. */
export function DashboardHeader({ m, live }: { m: LiveMetrics | null; live: boolean }) {
  if (!m) return <View style={styles.box}><Text style={styles.muted}>Waiting for the engine…</Text></View>;
  const baseline = m.baselineTrusted ? 'baseline trusted' : `baseline ${m.baselineWalkDays.toFixed(1).replace(/\.0$/, '')} of 7 days`;
  return (
    <View style={styles.box}>
      <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
        <Pill text={PLACEMENT_LABEL[m.placement] ?? m.placement} color={colors.accent} />
        <Pill text={m.samplingFull ? '50 Hz + gyro' : '10 Hz accel'} color={m.samplingFull ? colors.warn : colors.muted} />
        <Pill text={baseline} color={m.baselineTrusted ? colors.ok : colors.muted} />
        <Pill text={ACTIVITY_LABEL[m.activity] ?? m.activity} color={colors.muted} />
      </Row>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.muted} numberOfLines={2}>{m.evidence}</Text>
        <Row style={{ gap: 6 }}>
          <View style={[styles.dot, { backgroundColor: live ? colors.ok : colors.muted }]} />
          <Text style={styles.muted}>{live ? 'live · 1 s' : 'paused'}</Text>
        </Row>
      </Row>
      {!m.baselineTrusted && <Text style={styles.hint}>Until the engine learns 7 walking days, bands use population defaults at ±3.5 SD.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.card, borderRadius: radius, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.border },
  muted: { color: colors.muted, fontSize: 13, flexShrink: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
