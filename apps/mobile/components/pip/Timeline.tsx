import React from 'react';
import { View } from 'react-native';
import { format } from 'date-fns';
import type { IncidentRecord } from '@/modules/safety-native';
import { FAMILY } from '@/components/monitor/incidentTimeline';
import { isActive, recordTitle } from '@/lib/concern';
import { fmtCountdown } from '@/components/telemetry/labels';
import { ht, ui } from '@/lib/theme';
import { Mono, T } from './kit';

type Row = { key: string; at: number; title: string; sub: string; kind: 'past' | 'check' | 'watch' | 'danger' };

const MAX_ROWS = 40;

function rowsFor(records: IncidentRecord[], check: { pending: boolean; deadlineMs: number | null; summary: string | null }, now: number): Row[] {
  // Background ("context") records that already cleared are noise here; the full log is one tap away (See more).
  const shown = records.filter((r) => r.tier !== 'context' || isActive(r) || r.kind === 'fall_recovered').slice(-MAX_ROWS);
  const rows: Row[] = shown.map((r) => {
    const active = isActive(r);
    const kind: Row['kind'] = !active ? 'past' : r.tier === 'danger' ? 'danger' : FAMILY[r.kind] === 'check_in' ? 'check' : r.tier === 'watch' ? 'watch' : 'past';
    const end = r.clearedMs > 0 ? (r.acknowledged ? ` · answered ${format(r.clearedMs, 'h:mm a')}` : r.clearedMs > r.tMs ? ` · cleared ${format(r.clearedMs, 'h:mm a')}` : '') : '';
    return { key: `${r.id}-${r.tMs}`, at: r.tMs, title: recordTitle(r.kind), sub: `${r.summary}${end}`, kind };
  });
  if (check.pending) {
    const left = check.deadlineMs ? ` · ${fmtCountdown(check.deadlineMs - now)} left to answer` : '';
    rows.push({ key: 'check', at: now, title: 'Asked “You okay?”', sub: `${check.summary ?? 'Check-in'}${left}`, kind: 'check' });
  }
  return rows;
}

/** The mark for a row: coral is danger, lilac a check-in waiting, butter on watch, hollow paper is over. */
const FILL: Record<Row['kind'], string> = { danger: ht.coral, check: ht.lilac, watch: ht.butter, past: ht.paper };
const TEXT: Record<Row['kind'], string> = { danger: ht.coralDeep, check: ht.lilacDeep, watch: ht.butterDeep, past: ui.text2 };

/** "Tonight": the friend's monitoring log as a vertical timeline, oldest first, the newest open item emphasised. */
export function Timeline({ records, check, now, empty = 'Nothing flagged tonight.' }: {
  records: IncidentRecord[]; check: { pending: boolean; deadlineMs: number | null; summary: string | null }; now: number; empty?: string;
}) {
  const rows = rowsFor(records, check, now);
  if (!rows.length) return <T style={{ fontSize: 15, lineHeight: 21, color: ui.quiet, paddingVertical: 8 }}>{empty}</T>;
  return (
    <View accessibilityRole="list">
      {rows.map((r, i) => {
        const last = i === rows.length - 1;
        const big = r.kind === 'danger';
        const d = big ? 14 : 12;
        return (
          <View key={r.key} style={{ flexDirection: 'row', gap: 12 }}>
            <Mono style={{ width: 64, fontSize: 12.5, lineHeight: 18, color: ui.quiet, paddingTop: 1 }}>{format(r.at, 'h:mm a')}</Mono>
            <View style={{ width: 14, alignItems: 'center' }}>
              <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: FILL[r.kind], borderWidth: 1.5, borderColor: r.kind === 'past' ? ui.line : ui.keyline, marginTop: big ? 2 : 3 }} />
              {!last && <View style={{ flex: 1, width: 2, backgroundColor: ui.line, marginTop: 4, borderRadius: 1 }} />}
            </View>
            <View style={{ flex: 1, gap: 1, paddingBottom: last ? 0 : 14 }}>
              <T style={{ fontSize: 15, lineHeight: 20, fontWeight: '600', color: TEXT[r.kind] }}>{r.title}</T>
              <T style={{ fontSize: 13, lineHeight: 18, color: ui.quiet }}>{r.sub}</T>
            </View>
          </View>
        );
      })}
    </View>
  );
}
