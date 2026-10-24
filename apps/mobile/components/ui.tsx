import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, TextInputProps, View, ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius } from '@/lib/theme';

export function Screen({ children, scroll = true, style }: { children: React.ReactNode; scroll?: boolean; style?: ViewProps['style'] }) {
  const inner = <View style={[styles.inner, style]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      {scroll ? <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">{inner}</ScrollView> : inner}
    </SafeAreaView>
  );
}
export const H1 = ({ children }: { children: React.ReactNode }) => <Text style={styles.h1}>{children}</Text>;
export const H2 = ({ children }: { children: React.ReactNode }) => <Text style={styles.h2}>{children}</Text>;
export const P = ({ children, muted, style }: { children: React.ReactNode; muted?: boolean; style?: any }) => (
  <Text style={[styles.p, muted && { color: colors.muted }, style]}>{children}</Text>
);
export const Card = ({ children, style, tint }: { children: React.ReactNode; style?: ViewProps['style']; tint?: string }) => (
  <View style={[styles.card, tint ? { borderColor: tint } : null, style]}>{children}</View>
);
export const Row = ({ children, style }: { children: React.ReactNode; style?: ViewProps['style'] }) => <View style={[styles.row, style]}>{children}</View>;

export function Button({ title, onPress, kind = 'primary', disabled, loading, style }: {
  title: string; onPress: () => void; kind?: 'primary' | 'danger' | 'ghost' | 'ok'; disabled?: boolean; loading?: boolean; style?: ViewProps['style'];
}) {
  const bg = { primary: colors.accent, danger: colors.danger, ghost: 'transparent', ok: colors.ok }[kind];
  return (
    <Pressable onPress={onPress} disabled={disabled || loading}
      style={({ pressed }) => [styles.btn, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }, kind === 'ghost' && { borderWidth: 1, borderColor: colors.border }, style]}>
      {loading ? <ActivityIndicator color="white" /> : <Text style={[styles.btnText, kind === 'ghost' && { color: colors.text }]}>{title}</Text>}
    </Pressable>
  );
}
export const Input = (props: TextInputProps) => <TextInput placeholderTextColor={colors.muted} {...props} style={[styles.input, props.style]} />;
export const Pill = ({ text, color }: { text: string; color: string }) => (
  <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: color + '33', borderWidth: 1, borderColor: color }}>
    <Text style={{ color, fontWeight: '600', fontSize: 12 }}>{text}</Text>
  </View>
);
export const Toggle = ({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) => (
  <Pressable onPress={() => onChange(!value)} style={[styles.row, { justifyContent: 'space-between', paddingVertical: 10 }]}>
    <View style={{ flex: 1 }}>
      <Text style={styles.p}>{label}</Text>
      {hint && <Text style={[styles.p, { color: colors.muted, fontSize: 13 }]}>{hint}</Text>}
    </View>
    <View style={{ width: 48, height: 28, borderRadius: 14, backgroundColor: value ? colors.ok : colors.border, padding: 3, alignItems: value ? 'flex-end' : 'flex-start' }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: 'white' }} />
    </View>
  </Pressable>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  inner: { padding: 20, gap: 14, flex: 1 },
  h1: { color: colors.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  h2: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 6 },
  p: { color: colors.text, fontSize: 16, lineHeight: 22 },
  card: { backgroundColor: colors.card, borderRadius: radius, padding: 16, gap: 8, borderWidth: 1, borderColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  btn: { paddingVertical: 14, paddingHorizontal: 18, borderRadius: 12, alignItems: 'center', justifyContent: 'center', minHeight: 50 },
  btnText: { color: 'white', fontWeight: '700', fontSize: 16 },
  input: { backgroundColor: colors.card, color: colors.text, borderRadius: 12, padding: 14, fontSize: 16, borderWidth: 1, borderColor: colors.border },
});
