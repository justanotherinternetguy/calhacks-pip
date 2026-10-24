import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { EngineEventEntry } from '@/lib/telemetry';
import { colors, radius } from '@/lib/theme';
import { engineEventColor, engineEventLabel, fmtClock } from './labels';

const SHOW = 20;

/** The last 20 engine events (tick.events), newest first, stamped with the phone's clock. */
export function EventTicker({ events }: { events: EngineEventEntry[] }) {
  const rows = events.slice(-SHOW).reverse();
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        <Text style={styles.title}>Engine events</Text>
        <Text style={styles.meta}>last {SHOW}</Text>
      </View>
      <View style={styles.box}>
        {rows.length === 0 && <Text style={styles.meta}>No engine events yet.</Text>}
        {rows.map((e) => (
          <View key={e.key} style={styles.row}>
            <Text style={styles.time}>{fmtClock(e.t)}</Text>
            <View style={[styles.dot, { backgroundColor: engineEventColor(e.name) }]} />
            <Text style={[styles.label, { color: engineEventColor(e.name) === colors.muted ? colors.text : engineEventColor(e.name) }]} numberOfLines={1}>{engineEventLabel(e.name)}</Text>
            <Text style={styles.meta}>#{e.seq}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  box: { backgroundColor: colors.card, borderRadius: radius - 4, padding: 10, gap: 6, borderWidth: 1, borderColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  time: { color: colors.muted, fontSize: 12, width: 62, fontVariant: ['tabular-nums'] },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: { flex: 1, fontSize: 13, fontWeight: '600' },
});
