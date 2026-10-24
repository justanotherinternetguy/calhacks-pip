import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/lib/theme';
import type { Reminder } from './useRiskAnalysis';
import { URGENCY_COLOR } from './AnalysisPanel';

export type Toast = Reminder & { subjectName: string };

/** How long a pop-up stays up; urgent ones stay until dismissed. */
export const TOAST_TTL_MS: Record<Reminder['urgency'], number> = { info: 15_000, warn: 30_000, urgent: Infinity };
export const toastVisible = (t: Toast, now: number) => now - t.atMs < TOAST_TTL_MS[t.urgency];

/** Pop-up reminders from the AI analysis, stacked over the top of the monitor's right column. */
export function ReminderToasts({ toasts, now, width, onDismiss }: { toasts: Toast[]; now: number; width: number; onDismiss: (id: string) => void }) {
  const shown = toasts.filter((t) => toastVisible(t, now)).slice(0, 4);
  if (!shown.length) return null;
  return (
    <View style={[styles.stack, { width }]} pointerEvents="box-none">
      {shown.map((t) => {
        const c = URGENCY_COLOR[t.urgency];
        return (
          <View key={t.id} style={[styles.toast, { borderColor: c }]} accessibilityRole="alert">
            <View style={[styles.bar, { backgroundColor: c }]} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[styles.label, { color: c }]}>{t.urgency === 'urgent' ? 'Act now' : t.urgency === 'warn' ? 'Heads-up' : 'Note'} · {t.subjectName}</Text>
              <Text style={styles.text}>{t.text}</Text>
            </View>
            <Pressable onPress={() => onDismiss(t.id)} hitSlop={10} accessibilityLabel="Dismiss reminder">
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { position: 'absolute', top: 70, right: 14, gap: 8, zIndex: 50 },
  toast: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, backgroundColor: '#1e2433',
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  bar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  label: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  text: { color: colors.text, fontSize: 14, lineHeight: 19 },
  close: { color: colors.muted, fontSize: 14, paddingHorizontal: 2 },
});
