import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Pill } from '@/components/ui';
import { colors, radius } from '@/lib/theme';
import { actionTitle } from './actions';
import { cachedSessionStats, closedSegments, type CollectSession } from './session';

const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const when = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Saved sessions (IndexedDB): open for analysis, download as a Recording, resume an interrupted one, delete. */
export function SessionsPanel({ sessions, activeId, openId, canResume, onOpen, onDownload, onDownloadAll, onDelete, onResume, note }: {
  sessions: CollectSession[]; activeId: string | null; openId: string | null; canResume: boolean;
  onOpen: (id: string | null) => void; onDownload: (s: CollectSession) => void; onDownloadAll: () => void;
  onDelete: (s: CollectSession) => void; onResume: (s: CollectSession) => void; note?: string | null;
}) {
  const open = sessions.find((s) => s.id === openId) ?? null;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>Saved sessions</Text>
        <Text style={styles.meta}>{sessions.length} in this browser</Text>
        <View style={{ flex: 1 }} />
        {sessions.length > 0 && <Link label="Download all" onPress={onDownloadAll} />}
      </View>
      {note ? <Text style={styles.meta}>{note}</Text> : null}
      {sessions.length === 0 && <Text style={styles.meta}>Nothing saved yet. Sessions save here every 10 s while recording.</Text>}
      {sessions.map((s) => {
        const st = cachedSessionStats(s);
        const live = s.id === activeId && s.status === 'recording';
        const interrupted = s.status === 'recording' && !live;
        return (
          <View key={s.id} style={[styles.row, s.id === openId && { borderColor: colors.accent }]}>
            <View style={{ flex: 1, minWidth: 220, gap: 2 }}>
              <View style={styles.line}>
                <Text style={styles.name}>{s.participant || 'anon'}</Text>
                <Text style={styles.meta}>{when(s.t0 ?? s.createdAt)} · {s.subjectName}</Text>
                {live && <Pill text="recording" color={colors.danger} />}
                {interrupted && <Pill text="interrupted" color={colors.warn} />}
                {s.demo && <Pill text="demo thresholds" color={colors.warn} />}
              </View>
              <Text style={styles.meta}>
                {dur(st.durationMs)} · {st.samples.toLocaleString()} samples · {st.hz.toFixed(0)} Hz · {st.sampleGaps + st.frameGaps} gaps · {closedSegments(s.actions, s.lastT).length} segments · {s.incidents.length} incident{s.incidents.length === 1 ? '' : 's'}
              </Text>
            </View>
            <View style={styles.actions}>
              <Link label={s.id === openId ? 'Close' : 'Open'} onPress={() => onOpen(s.id === openId ? null : s.id)} />
              <Link label="Download" onPress={() => onDownload(s)} />
              {interrupted && canResume && <Link label="Resume" onPress={() => onResume(s)} />}
              {!live && <Link label="Delete" danger onPress={() => onDelete(s)} />}
            </View>
          </View>
        );
      })}
      {open && (
        <View style={{ gap: 4 }}>
          <Text style={styles.sub}>Segments in {open.participant || 'anon'}'s session</Text>
          {closedSegments(open.actions, open.lastT).map((g, i) => (
            <Text key={i} style={styles.seg}>
              {dur(g.start - (open.t0 ?? g.start))}  {actionTitle(g.label)}  ({dur(g.end - g.start)})
            </Text>
          ))}
          {open.notes ? <Text style={styles.meta}>Notes: {open.notes}</Text> : null}
        </View>
      )}
    </View>
  );
}

function Link({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.link, pressed && { opacity: 0.7 }]}>
      <Text style={[styles.linkText, danger && { color: colors.danger }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: 8, padding: 14, borderRadius: radius, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  sub: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 4 },
  meta: { color: colors.muted, fontSize: 12, flexShrink: 1, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  name: { color: colors.text, fontSize: 14, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  link: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  linkText: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  seg: { color: colors.text, fontSize: 12, fontVariant: ['tabular-nums'] },
});
