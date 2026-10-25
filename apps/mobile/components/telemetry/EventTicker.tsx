import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { EngineEventEntry } from '@/lib/telemetry';
import { colors, radius } from '@/lib/theme';
import { engineEventColor, engineEventLabel, fmtClock } from './labels';
import { agoText } from './LiveIncidentLog';

const SHOW = 20;
/** Sensor housekeeping: shown dimmed, it says nothing about the person. */
const HOUSEKEEPING = new Set(['sampling_rate_changed', 'location_interval_changed', 'audio_listening']);

type Row = { key: string; t: number; name: string; count: number };

/** Consecutive repeats of one event fold into a single row ("×3", time of the newest). */
function fold(events: EngineEventEntry[]): Row[] {
  const rows: Row[] = [];
  for (const e of events) {
    const last = rows[rows.length - 1];
    if (last && last.name === e.name) { last.count += 1; last.t = e.t; last.key = e.key; }
    else rows.push({ key: e.key, t: e.t, name: e.name, count: 1 });
  }
  return rows;
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The engine's recent events, newest first, on the phone's clock. */
export function EventTicker({ events, now }: { events: EngineEventEntry[]; now?: number }) {
  const rows = fold(events).slice(-SHOW).reverse();
  const at = now ?? events.at(-1)?.t ?? 0;
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        <Text style={styles.title}>Engine events</Text>
        <Text style={styles.meta}>newest first · grey = sensor housekeeping</Text>
      </View>
      <View style={styles.box}>
        {rows.length === 0 && <Text style={styles.meta}>No engine events yet.</Text>}
        {rows.map((e) => {
          const quiet = HOUSEKEEPING.has(e.name);
          const c = engineEventColor(e.name);
          return (
            <View key={e.key} style={[styles.row, quiet && { opacity: 0.55 }]}>
              <View style={[styles.dot, { backgroundColor: c }]} />
              <Text style={[styles.label, { color: c === colors.muted ? colors.text : c }, quiet && styles.labelQuiet]} numberOfLines={1}>
                {sentence(engineEventLabel(e.name))}{e.count > 1 ? <Text style={styles.meta}>{`  ×${e.count}`}</Text> : null}
              </Text>
              <Text style={styles.when}>{agoText(e.t, at)}</Text>
              <Text style={styles.time}>{fmtClock(e.t)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  box: { backgroundColor: colors.card, borderRadius: radius - 4, padding: 10, gap: 7, borderWidth: 1, borderColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { flex: 1, fontSize: 13, fontWeight: '700' },
  labelQuiet: { fontWeight: '500' },
  when: { color: colors.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  time: { color: colors.muted, fontSize: 12, width: 62, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
