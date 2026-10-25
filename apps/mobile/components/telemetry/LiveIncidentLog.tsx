import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { IncidentRecord } from '@/modules/safety-native';
import type { Assessment, OkConfirmation } from '@/components/monitor/riskAnalysis';
import { useAnchor, useFocusKey } from '@/components/monitor/ReasoningLinks';
import { Button } from '@/components/ui';
import { colors, radius } from '@/lib/theme';
import { PLACEMENT_LABEL, fmtClock, fmtSd, kindLabel, sequenceColor, tierColor } from './labels';

const MAX_ROWS = 30;
const FRESH_MS = 10_000;

/** "just now", "40 s ago", "3 min ago", "1 h 5 min ago" */
export function agoText(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''} ago`;
}
/** "under a second", "40 s", "3 min", "1 h 5 min" */
export function durationText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return 'under a second';
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** What state a record is in, in plain words: still open, over (and how long it lasted), or a one-off moment. */
function statusOf(r: IncidentRecord, now: number): { text: string; color: string; filled: boolean } {
  if (r.clearedMs === 0) return { text: `Active · ${durationText(now - r.tMs)} so far`, color: tierColor(r.tier), filled: true };
  if (r.clearedMs - r.tMs < 1000) return { text: 'Moment', color: colors.muted, filled: false };
  return { text: `Over · lasted ${durationText(r.clearedMs - r.tMs)}`, color: colors.muted, filled: false };
}

type Item = { ok: OkConfirmation } | { r: IncidentRecord };
type Block = { seq: number; items: Item[] };

/**
 * The engine's incident log as received over telemetry (upserted by id, so a record re-sent on clearing replaces
 * the earlier copy; 8-h TTL), newest first. The left edge shows how serious each incident is (red danger, amber
 * watch, grey context); incidents the engine grouped into one episode sit in one box. "Confirmed OK" rows are merged
 * in by time.
 */
export function LiveIncidentLog({ records, onPhone, phoneNow, onClear, clearNote, assessments, confirmations = [] }: {
  records: IncidentRecord[]; onPhone: number; phoneNow: number;
  /** deletes the subject's incidents for good (server, phone log, AI read); absent = no subject */
  onClear?: () => void;
  clearNote?: string;
  /** the AI read's take on each incident (points chip on the row; arrows link the row to it) */
  assessments?: Map<number, Assessment>;
  /** times the subject confirmed they are OK, shown in the log by time */
  confirmations?: OkConfirmation[];
}) {
  const [important, setImportant] = useState(false);
  const gap = onPhone > records.length;
  const visible = important ? records.filter((r) => r.tier !== 'context') : records;
  const shown = visible.slice(0, MAX_ROWS);
  const hidden = records.length - visible.length;
  // OK confirmations newer than the oldest row shown (or the 3 newest when nothing is shown), merged in by time.
  const oldest = shown.length ? shown[shown.length - 1].tMs : -Infinity;
  const oks = shown.length ? confirmations.filter((c) => c.atMs >= oldest).slice(-10) : confirmations.slice(-3);
  const items: Item[] = [...shown.map((r) => ({ r })), ...oks.map((ok) => ({ ok }))]
    .sort((x, y) => ('ok' in y ? y.ok.atMs : y.r.tMs) - ('ok' in x ? x.ok.atMs : x.r.tMs));
  // Runs of incidents from the same episode (sequenceId > 0) become one block.
  const blocks: Block[] = [];
  for (const it of items) {
    const seq = 'r' in it ? it.r.sequenceId : 0;
    const last = blocks[blocks.length - 1];
    if (seq > 0 && last && last.seq === seq) last.items.push(it);
    else blocks.push({ seq, items: [it] });
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={styles.head}>
        <Text style={styles.title}>Incident log</Text>
        <Text style={styles.meta}>{records.length} received{gap ? ` · ${onPhone} on the phone` : ''}</Text>
        <View style={{ flex: 1 }} />
        <Button title="Delete all" kind="ghost" onPress={() => onClear?.()} disabled={!onClear} style={styles.btn} testID="monitor-clear-incidents" />
      </View>
      <View style={styles.legendRow}>
        <Legend color={colors.danger} text="danger" />
        <Legend color={colors.warn} text="watch" />
        <Legend color={colors.muted} text="context (logged only)" />
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => setImportant((v) => !v)} style={[styles.filter, important && styles.filterOn]} testID="log-filter">
          <Text style={[styles.filterText, important && { color: colors.accent }]}>{important ? '✓ ' : ''}Watch & danger only</Text>
        </Pressable>
      </View>
      {gap && <Text style={styles.meta}>Older incidents on the phone happened before this console connected.</Text>}
      {clearNote ? <Text style={styles.meta}>{clearNote}</Text> : null}
      {records.length === 0 && <View style={styles.empty}><Text style={styles.emptyText}>Nothing flagged since this console connected.</Text></View>}
      {blocks.map((b, i) => b.seq > 0 && b.items.length > 1
        ? <EpisodeBlock key={`seq-${b.seq}-${i}`} block={b} phoneNow={phoneNow} assessments={assessments} />
        : <ItemRow key={keyOf(b.items[0])} it={b.items[0]} phoneNow={phoneNow} assessments={assessments} />)}
      {(visible.length > MAX_ROWS || hidden > 0) && (
        <Text style={styles.meta}>
          {visible.length > MAX_ROWS ? `${visible.length - MAX_ROWS} older incidents not shown. ` : ''}
          {hidden > 0 ? `${hidden} context ${hidden === 1 ? 'entry' : 'entries'} hidden by the filter.` : ''}
        </Text>
      )}
    </View>
  );
}

const keyOf = (it: Item) => ('ok' in it ? `ok-${it.ok.atMs}` : `${it.r.id}-${it.r.tMs}`);

function ItemRow({ it, phoneNow, assessments }: { it: Item; phoneNow: number; assessments?: Map<number, Assessment> }) {
  return 'ok' in it ? <OkRow ok={it.ok} phoneNow={phoneNow} /> : <IncidentRow r={it.r} phoneNow={phoneNow} ai={assessments?.get(it.r.id)} />;
}

/** Incidents the engine tied together (one episode): a header with how many and over what span, then the rows. */
function EpisodeBlock({ block, phoneNow, assessments }: { block: Block; phoneNow: number; assessments?: Map<number, Assessment> }) {
  const recs = block.items.flatMap((it) => ('r' in it ? [it.r] : []));
  const start = Math.min(...recs.map((r) => r.tMs));
  const end = Math.max(...recs.map((r) => r.tMs));
  const c = sequenceColor(block.seq);
  return (
    <View style={[styles.episode, { borderColor: c }]}>
      <Text style={[styles.episodeHead, { color: c }]}>
        Episode {block.seq} · {recs.length} incidents{end > start ? ` over ${durationText(end - start)}` : ''} · started {fmtClock(start)}
      </Text>
      {block.items.map((it) => <ItemRow key={keyOf(it)} it={it} phoneNow={phoneNow} assessments={assessments} />)}
    </View>
  );
}

const AI_COLOR = { up: colors.danger, down: colors.ok, none: colors.muted } as const;

function IncidentRow({ r, phoneNow, ai }: { r: IncidentRecord; phoneNow: number; ai?: Assessment }) {
  const ref = useAnchor(`inc-${r.id}`);
  const f = useFocusKey(`i${r.id}`);
  const fresh = phoneNow - r.tMs < FRESH_MS;
  const tint = tierColor(r.tier);
  const st = statusOf(r, phoneNow);
  const sd = Math.abs(r.sdDistance) >= 0.05 ? fmtSd(r.sdDistance) : null;
  return (
    <Pressable
      ref={ref as never} {...f.hover}
      style={[styles.row, { borderLeftColor: tint }, fresh && { borderColor: tint }, f.focused && { borderColor: colors.accent }, f.dimmed && ai && { opacity: 0.6 }, r.tier === 'context' && styles.rowQuiet]}
    >
      <View style={styles.line}>
        <Text style={[styles.kind, r.tier === 'context' && { color: colors.muted }]} numberOfLines={1}>{kindLabel(r.kind)}</Text>
        <View style={{ flex: 1 }} />
        <Text style={styles.when}>{agoText(r.tMs, phoneNow)}</Text>
        <Text style={styles.clock}>{fmtClock(r.tMs)}</Text>
      </View>
      <Text style={styles.summary}>{r.summary}</Text>
      <View style={styles.line}>
        <Text style={[styles.status, { color: st.filled ? '#fff' : st.color, backgroundColor: st.filled ? st.color : 'transparent', borderColor: st.color }]}>{st.text}</Text>
        {r.acknowledged && <Text style={[styles.status, { color: colors.ok, borderColor: colors.ok }]}>Answered</Text>}
        {r.watched && <Text style={[styles.status, { color: colors.warn, borderColor: colors.warn }]}>Being watched</Text>}
        {ai && <Text style={[styles.status, { color: AI_COLOR[ai.effect], borderColor: AI_COLOR[ai.effect] }]}>AI {ai.points > 0 ? `+${ai.points}` : ai.points < 0 ? `−${-ai.points}` : '0'}</Text>}
        <View style={{ flex: 1 }} />
        <Text style={styles.details} numberOfLines={1}>
          #{r.id} · {PLACEMENT_LABEL[r.placement] ?? r.placement}{sd ? ` · ${sd} from normal` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

/** "Confirmed OK" in the log: the owner answered a check-in (fingerprint / face / PIN) or tapped "I'm okay". */
function OkRow({ ok, phoneNow }: { ok: OkConfirmation; phoneNow: number }) {
  const ref = useAnchor(`ok-${ok.atMs}`);
  const f = useFocusKey('ok');
  return (
    <Pressable ref={ref as never} {...f.hover} style={[styles.row, styles.okRow]}>
      <View style={styles.line}>
        <Text style={[styles.kind, { color: colors.ok }]}>Confirmed OK</Text>
        <View style={{ flex: 1 }} />
        <Text style={styles.when}>{agoText(ok.atMs, phoneNow)}</Text>
        <Text style={styles.clock}>{fmtClock(ok.atMs)}</Text>
      </View>
      <Text style={styles.summary}>
        {ok.how === 'check_in' ? 'Answered the check-in with fingerprint, face or PIN.' : 'Tapped "I\'m okay" in the app.'} The AI risk went back to 0.
      </Text>
    </Pressable>
  );
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <View style={styles.legend}>
      <View style={[styles.legendBar, { backgroundColor: color }]} />
      <Text style={styles.meta}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { paddingVertical: 4, paddingHorizontal: 10, minHeight: 0 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendBar: { width: 4, height: 12, borderRadius: 2 },
  filter: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  filterOn: { borderColor: colors.accent },
  filterText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  row: { backgroundColor: colors.card, borderRadius: radius - 4, paddingVertical: 9, paddingHorizontal: 12, gap: 5, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 4 },
  rowQuiet: { paddingVertical: 7 },
  okRow: { borderColor: colors.ok, borderLeftColor: colors.ok },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  kind: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  when: { color: colors.text, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  clock: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  summary: { color: colors.text, fontSize: 14, lineHeight: 19 },
  status: { fontSize: 11, fontWeight: '700', borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden', fontVariant: ['tabular-nums'] },
  details: { color: colors.muted, fontSize: 11, fontVariant: ['tabular-nums'], flexShrink: 1 },
  episode: { borderWidth: 1, borderStyle: 'dashed', borderRadius: radius - 2, padding: 6, gap: 6 },
  episodeHead: { fontSize: 12, fontWeight: '700', paddingHorizontal: 4 },
  empty: { padding: 14, borderRadius: radius - 4, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  emptyText: { color: colors.muted, fontSize: 13, textAlign: 'center' },
});
