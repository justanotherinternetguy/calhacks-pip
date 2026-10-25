import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, ui } from '@/lib/theme';
import { ACTIONS, ACTION_GROUPS, PLACEMENTS, type PlacementChoice } from './actions';

/** The big action buttons, grouped, each with its instruction and keyboard key; then the placement switch. */
export function ActionPad({ current, onPick, placement, onPlacement, disabled, showKeys }: {
  current: string | null; onPick: (label: string) => void;
  placement: PlacementChoice | null; onPlacement: (p: PlacementChoice) => void;
  disabled?: boolean; showKeys: boolean;
}) {
  return (
    <View style={{ gap: 12 }}>
      {ACTION_GROUPS.map((g) => (
        <View key={g.group} style={{ gap: 6 }}>
          <Text style={styles.group}>{g.title}</Text>
          <View style={styles.grid}>
            {ACTIONS.filter((a) => a.group === g.group).map((a) => {
              const on = a.label === current;
              return (
                <Pressable key={a.label} onPress={() => onPick(a.label)} disabled={disabled} accessibilityRole="button" accessibilityState={{ selected: on, disabled }}
                  testID={`collect-action-${a.label}`}
                  style={({ pressed }) => [styles.btn, on && styles.btnOn, pressed && { opacity: 0.75 }, disabled && { opacity: 0.5 }]}>
                  <View style={styles.btnHead}>
                    <Text style={[styles.btnTitle, on && { color: colors.accent }]} numberOfLines={1}>{a.title}</Text>
                    {showKeys && <Text style={styles.key}>{a.key}</Text>}
                  </View>
                  <Text style={styles.btnText} numberOfLines={3}>{a.instruction}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      <View style={{ gap: 6 }}>
        <Text style={styles.group}>Phone is in the</Text>
        <View style={styles.row}>
          {PLACEMENTS.map((p) => {
            const on = p.value === placement;
            return (
              <Pressable key={p.value} onPress={() => onPlacement(p.value)} disabled={disabled} accessibilityRole="button" accessibilityState={{ selected: on }}
                style={({ pressed }) => [styles.place, on && styles.btnOn, pressed && { opacity: 0.75 }, disabled && { opacity: 0.5 }]}>
                <Text style={[styles.btnTitle, on && { color: colors.accent }]}>{p.title}</Text>
                {showKeys && <Text style={styles.key}>{p.key}</Text>}
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  btn: { flexGrow: 1, flexBasis: 170, maxWidth: 320, minHeight: 72, padding: 10, gap: 4, borderRadius: 14, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.card },
  btnOn: { borderColor: colors.accent, backgroundColor: ui.youWash },
  btnHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  btnTitle: { color: colors.text, fontSize: 15, fontWeight: '800', flexShrink: 1 },
  btnText: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  key: { marginLeft: 'auto', color: colors.muted, fontSize: 11, fontWeight: '700', borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, fontVariant: ['tabular-nums'] },
  place: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 16, borderRadius: radius / 2, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.card, minWidth: 110 },
});
