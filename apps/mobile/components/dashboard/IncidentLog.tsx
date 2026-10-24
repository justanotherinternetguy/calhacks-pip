import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { format } from 'date-fns';
import type { IncidentRecord } from '@/modules/safety-native';
import { Pill } from '@/components/ui';
import { colors, radius } from '@/lib/theme';
import { PLACEMENT_LABEL, TIER_LABEL, fmtSd, kindLabel, tierColor } from './labels';

function prettyJson(raw: string) {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

function Entry({ r }: { r: IncidentRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((v) => !v)} style={({ pressed }) => [styles.entry, pressed && { opacity: 0.8 }]} accessibilityRole="button" accessibilityState={{ expanded: open }}>
      <View style={styles.head}>
        <Pill text={kindLabel(r.kind)} color={tierColor(r.tier)} />
        <Text style={[styles.tier, { color: tierColor(r.tier) }]}>{TIER_LABEL[r.tier] ?? r.tier}</Text>
        <Text style={styles.time}>{format(r.tMs, 'HH:mm:ss')}</Text>
        <View style={{ flex: 1 }} />
        <Text style={[styles.sd, { color: Math.abs(r.sdDistance) > 2.5 ? colors.danger : colors.muted }]}>{fmtSd(r.sdDistance)}</Text>
      </View>
      <Text style={styles.summary}>{r.summary}</Text>
      <Text style={styles.meta} numberOfLines={1}>
        {PLACEMENT_LABEL[r.placement] ?? r.placement}
        {r.clearedMs > 0 ? ` · cleared ${format(r.clearedMs, 'HH:mm:ss')}` : ''}
        {r.acknowledged ? ' · answered at check-in' : ''}
        {r.sequenceId ? ` · seq #${r.sequenceId}` : ''}
        {r.watched ? ' · watching' : ''}
      </Text>
      {open && <Text style={styles.raw} selectable>{prettyJson(r.rawJson)}</Text>}
    </Pressable>
  );
}

/** Engine incident log, newest first, coloured by tier. Tap to expand raw_json. */
export function IncidentLog({ records }: { records: IncidentRecord[] }) {
  const sorted = [...records].sort((a, b) => b.tMs - a.tMs || b.id - a.id);
  if (!sorted.length) return <View style={styles.empty}><Text style={styles.emptyText}>No signals in the last 8 hours.</Text></View>;
  return <View style={{ gap: 8 }}>{sorted.map((r) => <Entry key={`${r.id}-${r.tMs}`} r={r} />)}</View>;
}

const styles = StyleSheet.create({
  entry: { backgroundColor: colors.card, borderRadius: radius, padding: 12, gap: 6, borderWidth: 1, borderColor: colors.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tier: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  time: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  sd: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  summary: { color: colors.text, fontSize: 15, lineHeight: 20 },
  meta: { color: colors.muted, fontSize: 12 },
  raw: { color: colors.text, fontFamily: 'monospace', fontSize: 11, lineHeight: 15, backgroundColor: colors.bg, borderRadius: 8, padding: 10, marginTop: 4 },
  empty: { padding: 16, borderRadius: radius, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  emptyText: { color: colors.muted, fontSize: 14, textAlign: 'center' },
});
