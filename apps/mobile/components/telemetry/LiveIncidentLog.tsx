import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { IncidentRecord } from '@/modules/safety-native';
import { Button, Pill } from '@/components/ui';
import { colors, radius } from '@/lib/theme';
import { PLACEMENT_LABEL, TIER_LABEL, fmtClock, fmtSd, kindLabel, sequenceColor, tierColor } from './labels';

const MAX_ROWS = 30;
const FRESH_MS = 10_000;

/**
 * The engine's incident log as received over telemetry (upserted by id, so a record re-sent on clearing replaces
 * the earlier copy; 8-h TTL), newest first. Pill colour = tier (context / watch / danger); fresh rows are outlined.
 * A coloured left bar marks records that belong to the same sequence.
 */
export function LiveIncidentLog({ records, onPhone, phoneNow, onClear, clearNote }: {
  records: IncidentRecord[]; onPhone: number; phoneNow: number;
  /** clears this list and resets the phone's log + sensing; absent = not allowed (someone else's phone) */
  onClear?: () => void;
  clearNote?: string;
}) {
  const gap = onPhone > records.length;
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        <Text style={styles.title}>Incident log</Text>
        <Text style={styles.meta}>{records.length} received{gap ? ` · ${onPhone} on phone (earlier records predate this session)` : ''}</Text>
        <View style={{ flex: 1 }} />
        <Button title="Clear incidents" kind="ghost" onPress={() => onClear?.()} disabled={!onClear} style={styles.clear} testID="monitor-clear-incidents" />
      </View>
      {clearNote ? <Text style={styles.meta}>{clearNote}</Text> : null}
      {records.length === 0 && <View style={styles.empty}><Text style={styles.emptyText}>No signals flagged since this console connected.</Text></View>}
      {records.slice(0, MAX_ROWS).map((r) => {
        const fresh = phoneNow - r.tMs < FRESH_MS;
        const tint = tierColor(r.tier);
        return (
          <View key={`${r.id}-${r.tMs}`} style={[styles.row, fresh && { borderColor: tint }]}>
            <View style={[styles.seqBar, { backgroundColor: r.sequenceId ? sequenceColor(r.sequenceId) : 'transparent' }]} />
            <View style={{ flex: 1, gap: 4 }}>
              <View style={styles.line}>
                <Pill text={kindLabel(r.kind)} color={tint} />
                <Text style={[styles.tier, { color: tint }]}>{TIER_LABEL[r.tier] ?? r.tier}</Text>
                <Text style={styles.time}>{fmtClock(r.tMs)}</Text>
                {r.clearedMs > 0 && <Text style={styles.time}>cleared {fmtClock(r.clearedMs)}</Text>}
                {r.acknowledged && <Text style={styles.time}>answered</Text>}
                {r.sequenceId > 0 && <Text style={[styles.seq, { color: sequenceColor(r.sequenceId) }]}>seq #{r.sequenceId}</Text>}
                {r.watched && <Text style={[styles.time, { color: colors.warn }]}>watching</Text>}
                <View style={{ flex: 1 }} />
                <Text style={[styles.sd, { color: Math.abs(r.sdDistance) > 2.5 ? colors.danger : colors.muted }]}>{fmtSd(r.sdDistance)}</Text>
              </View>
              <Text style={styles.summary}>{r.summary}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                #{r.id} · {PLACEMENT_LABEL[r.placement] ?? r.placement}
              </Text>
            </View>
          </View>
        );
      })}
      {records.length > MAX_ROWS && <Text style={styles.meta}>{records.length - MAX_ROWS} older records not shown.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  clear: { paddingVertical: 4, paddingHorizontal: 10, minHeight: 0 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', gap: 10, backgroundColor: colors.card, borderRadius: radius - 4, padding: 10, borderWidth: 1, borderColor: colors.border },
  tier: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  seqBar: { width: 4, borderRadius: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  time: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  seq: { fontSize: 12, fontWeight: '700' },
  sd: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  summary: { color: colors.text, fontSize: 14, lineHeight: 19 },
  empty: { padding: 14, borderRadius: radius - 4, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  emptyText: { color: colors.muted, fontSize: 13, textAlign: 'center' },
});
