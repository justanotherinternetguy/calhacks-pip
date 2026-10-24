import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Pill } from '@/components/ui';
import { colors, radius } from '@/lib/theme';
import { fmtCountdown } from './labels';

const CHECK_WINDOW_MS = 120_000; // model-v1.toml check_deadline_s

/**
 * Shown while the tick carries `checkPhrase`: the phone is asking its owner to type the phrase before the
 * deadline. `phoneNow` is the phone's clock estimated from the newest tick, so the countdown ignores browser skew.
 */
export function CheckInBanner({ phrase, deadlineMs, phoneNow, subjectName }: { phrase: string; deadlineMs: number | undefined; phoneNow: number; subjectName: string }) {
  const remaining = deadlineMs != null ? deadlineMs - phoneNow : null;
  const urgent = remaining != null && remaining < 30_000;
  const tint = urgent ? colors.danger : colors.warn;
  const frac = remaining == null ? 0 : Math.max(0, Math.min(1, remaining / CHECK_WINDOW_MS));
  return (
    <View style={[styles.box, { borderColor: tint }]}>
      <View style={styles.row}>
        <Pill text="check-in pending" color={tint} />
        <Text style={styles.title}>{subjectName} has to type "{phrase}"</Text>
        <View style={{ flex: 1 }} />
        <Text style={[styles.count, { color: tint }]}>{remaining == null ? '—' : remaining <= 0 ? 'overdue' : fmtCountdown(remaining)}</Text>
      </View>
      <View style={styles.track}><View style={[styles.fill, { width: `${frac * 100}%`, backgroundColor: tint }]} /></View>
      <Text style={styles.meta}>No answer by the deadline logs a missed check-in and sends the group a heads-up (no location); location unlocks 2 min later if the trigger still holds.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.card, borderRadius: radius, padding: 12, gap: 8, borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  count: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  track: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  meta: { color: colors.muted, fontSize: 12, lineHeight: 16 },
});
