import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LiveMetrics } from '@/modules/safety-native';
import { colors, radius } from '@/lib/theme';
import { STATE_COLOR, STATE_LABEL } from './labels';

/** The HMM's four state probabilities as a 4-bar strip, with P(danger) = P(incident) + P(unresponsive) as the headline. */
export function StateStrip({ m, pDanger }: { m: LiveMetrics | null; pDanger: number | undefined }) {
  const ps = m ? [m.pNormal, m.pImpaired, m.pIncident, m.pUnresponsive] : [0, 0, 0, 0];
  const danger = pDanger ?? (m ? m.pIncident + m.pUnresponsive : 0);
  const dangerColor = danger >= 0.7 ? colors.danger : danger >= 0.3 ? colors.warn : colors.ok;
  return (
    <View style={styles.box}>
      <View style={styles.headline}>
        <Text style={styles.title}>State</Text>
        <Text style={styles.pLabel}>P(danger) <Text style={[styles.pValue, { color: dangerColor }]}>{(danger * 100).toFixed(0)}%</Text></Text>
      </View>
      <View style={styles.bars}>
        {ps.map((p, i) => {
          const pct = Math.max(0, Math.min(1, p));
          return (
            <View key={STATE_LABEL[i]} style={styles.col}>
              <Text style={styles.value}>{(pct * 100).toFixed(0)}%</Text>
              <View style={styles.track}>
                <View style={[styles.fill, { height: `${Math.max(2, pct * 100)}%`, backgroundColor: STATE_COLOR[i] }]} />
              </View>
              <Text style={styles.label} numberOfLines={1}>{STATE_LABEL[i]}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.card, borderRadius: radius, padding: 14, gap: 12, borderWidth: 1, borderColor: colors.border },
  headline: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pLabel: { color: colors.muted, fontSize: 13 },
  pValue: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  bars: { flexDirection: 'row', gap: 10, alignItems: 'flex-end' },
  col: { flex: 1, alignItems: 'center', gap: 6 },
  value: { color: colors.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  track: { width: '100%', height: 72, backgroundColor: colors.bg, borderRadius: 4, justifyContent: 'flex-end', overflow: 'hidden' },
  fill: { width: '100%', borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  label: { color: colors.muted, fontSize: 11 },
});
