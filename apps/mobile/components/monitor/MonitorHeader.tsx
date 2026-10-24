import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { format } from 'date-fns';
import { colors } from '@/lib/theme';

export function MonitorHeader({ groupName, now, soundOn, onToggleSound, onHome, live }: {
  groupName: string; now: number; soundOn: boolean; onToggleSound: () => void; onHome: () => void; live: boolean;
}) {
  return (
    <View style={styles.bar}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.kicker}>Safety monitor</Text>
        <Text style={styles.title} numberOfLines={1}>{groupName}</Text>
      </View>
      <View style={styles.right}>
        <View style={styles.liveRow}>
          <View style={[styles.dot, { backgroundColor: live ? colors.ok : colors.muted }]} />
          <Text style={styles.clock}>{format(now, 'HH:mm:ss')}</Text>
        </View>
        <Pressable onPress={onToggleSound} accessibilityRole="button" style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.7 }, soundOn && { borderColor: colors.accent }]}>
          <Text style={[styles.ghostText, soundOn && { color: colors.accent }]}>{soundOn ? 'Sound on' : 'Sound off'}</Text>
        </Pressable>
        <Pressable onPress={onHome} accessibilityRole="button" style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.7 }]}>
          <Text style={styles.ghostText}>Home</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bg },
  kicker: { color: colors.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  clock: { color: colors.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  ghost: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  ghostText: { color: colors.text, fontWeight: '600', fontSize: 13 },
});
