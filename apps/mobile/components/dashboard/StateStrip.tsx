import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LiveMetrics } from '@/modules/safety-native';
import { Pill } from '@/components/ui';
import { colors, radius } from '@/lib/theme';

/** Where the engine stands: sensing rate, microphone and the situational context chips. Everything is a label from the engine. */
export function StateStrip({ m }: { m: LiveMetrics | null }) {
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Status</Text>
      <View style={styles.chips}>
        <Pill text={m?.samplingFull ? 'full sensing' : 'low-rate sensing'} color={m?.samplingFull ? colors.warn : colors.muted} />
        <Pill text={m?.listening ? 'mic listening' : 'mic off'} color={m?.listening ? colors.warn : colors.muted} />
        {(m?.context ?? []).map((c) => <Pill key={c} text={c} color={colors.accent} />)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.card, borderRadius: radius, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.border },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
