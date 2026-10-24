import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { IncidentRecord } from '@/modules/safety-native';
import { Pill } from '@/components/ui';
import { colors, radius } from '@/lib/theme';
import { KIND_LABEL, PLACEMENT_LABEL, fmtClock, fmtSd, kindColor, sequenceColor } from './labels';

const MAX_ROWS = 30;
const FRESH_MS = 10_000;

/**
 * The engine's incident log as received over telemetry (deltas merged by id, 8-h TTL), newest first. A coloured
 * left bar marks records that belong to the same sequence; "watching" means the engine has not escalated yet.
 */
export function LiveIncidentLog({ records, onPhone, phoneNow }: { records: IncidentRecord[]; onPhone: number; phoneNow: number }) {
  const gap = onPhone > records.length;
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        <Text style={styles.title}>Incident log</Text>
        <Text style={styles.meta}>{records.length} received{gap ? ` · ${onPhone} on phone (earlier records predate this session)` : ''}</Text>
      </View>
      {records.length === 0 && <View style={styles.empty}><Text style={styles.emptyText}>No signals flagged since this console connected.</Text></View>}
      {records.slice(0, MAX_ROWS).map((r) => {
        const fresh = phoneNow - r.tMs < FRESH_MS;
        return (
          <View key={`${r.id}-${r.tMs}`} style={[styles.row, fresh && { borderColor: kindColor(r.kind) }]}>
            <View style={[styles.seqBar, { backgroundColor: r.sequenceId ? sequenceColor(r.sequenceId) : 'transparent' }]} />
            <View style={{ flex: 1, gap: 4 }}>
              <View style={styles.line}>
                <Pill text={KIND_LABEL[r.kind] ?? r.kind} color={kindColor(r.kind)} />
                <Text style={styles.time}>{fmtClock(r.tMs)}</Text>
                {r.sequenceId > 0 && <Text style={[styles.seq, { color: sequenceColor(r.sequenceId) }]}>seq #{r.sequenceId}</Text>}
                {r.watched && <Pill text="watching" color={colors.warn} />}
                <View style={{ flex: 1 }} />
                <Text style={[styles.sd, { color: Math.abs(r.sdDistance) > 2.5 ? colors.danger : colors.muted }]}>{fmtSd(r.sdDistance)}</Text>
              </View>
              <Text style={styles.summary}>{r.summary}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                #{r.id} · {PLACEMENT_LABEL[r.placement] ?? r.placement} · P(inc) {(r.pIncident * 100).toFixed(0)}% · P(unresp) {(r.pUnresponsive * 100).toFixed(0)}%
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
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', gap: 10, backgroundColor: colors.card, borderRadius: radius - 4, padding: 10, borderWidth: 1, borderColor: colors.border },
  seqBar: { width: 4, borderRadius: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  time: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  seq: { fontSize: 12, fontWeight: '700' },
  sd: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  summary: { color: colors.text, fontSize: 14, lineHeight: 19 },
  empty: { padding: 14, borderRadius: radius - 4, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  emptyText: { color: colors.muted, fontSize: 13, textAlign: 'center' },
});
