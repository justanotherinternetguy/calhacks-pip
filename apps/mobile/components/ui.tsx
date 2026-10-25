// The shared kit for the plainer screens (settings, groups, history, onboarding, incident): cream ground, paper
// cards, Fredoka headings, ledge buttons. Thin wrappers over components/pip/kit so every screen speaks one language.
import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, TextInputProps, View, ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Btn, Card as KitCard, Chip, D, Switch, T, type BtnKind } from '@/components/pip/kit';
import { fontFor, ht, ui } from '@/lib/theme';

export function Screen({ children, scroll = true, style, testID }: { children: React.ReactNode; scroll?: boolean; style?: ViewProps['style']; testID?: string }) {
  const inner = <View testID={testID} style={[styles.inner, style]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      {scroll ? <ScrollView contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">{inner}</ScrollView> : inner}
    </SafeAreaView>
  );
}
export const H1 = ({ children, style }: { children: React.ReactNode; style?: any }) => <D accessibilityRole="header" style={[styles.h1, style]}>{children}</D>;
export const H2 = ({ children, style }: { children: React.ReactNode; style?: any }) => <D accessibilityRole="header" style={[styles.h2, style]}>{children}</D>;
export const P = ({ children, muted, style, testID, numberOfLines }: { children: React.ReactNode; muted?: boolean; style?: any; testID?: string; numberOfLines?: number }) => (
  <T testID={testID} numberOfLines={numberOfLines} style={[styles.p, muted && { color: ui.quiet }, style]}>{children}</T>
);
export const Card = ({ children, style, tint, padded }: { children: React.ReactNode; style?: ViewProps['style']; tint?: string; padded?: boolean }) => (
  <KitCard tint={tint} style={style} padded={padded}>{children}</KitCard>
);
export const Row = ({ children, style }: { children: React.ReactNode; style?: ViewProps['style'] }) => <View style={[styles.row, style]}>{children}</View>;

const KIND: Record<'primary' | 'danger' | 'ghost' | 'ok', BtnKind> = { primary: 'main', danger: 'coral', ghost: 'paper', ok: 'mint' };

/** Ledge buttons: `primary` is ink, `danger` coral, `ok` mint, `ghost` paper. */
export function Button({ title, onPress, kind = 'primary', disabled, loading, style, testID, icon }: {
  title: string; onPress: () => void; kind?: keyof typeof KIND; disabled?: boolean; loading?: boolean; style?: ViewProps['style']; testID?: string; icon?: React.ReactNode;
}) {
  return (
    <Btn title={title} onPress={onPress} kind={KIND[kind]} disabled={disabled} testID={testID} style={style} icon={icon}
      iconRight={loading ? <ActivityIndicator size="small" color={KIND[kind] === 'main' ? ht.cream : ht.ink} /> : undefined} />
  );
}
export const Input = (props: TextInputProps) => {
  const [focus, setFocus] = useState(false);
  return (
    <TextInput placeholderTextColor={ui.muted} selectionColor={ht.sky} cursorColor={ht.ink} {...props}
      onFocus={(e) => { setFocus(true); props.onFocus?.(e); }} onBlur={(e) => { setFocus(false); props.onBlur?.(e); }}
      style={[styles.input, fontFor('400'), focus && { borderColor: ht.ink }, props.style]} />
  );
};
/** A small outlined tag in the given colour (status words). */
export const Pill = ({ text, color }: { text: string; color: string }) => <Chip small fill={ui.panel} color={color} style={{ borderColor: color }}>{text}</Chip>;
export const Toggle = ({ label, value, onChange, hint, testID }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string; testID?: string }) => (
  <Switch label={label} hint={hint} value={value} onChange={onChange} testID={testID} />
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.ground },
  inner: { padding: 20, gap: 14, flex: 1 },
  h1: { color: ui.text, fontSize: 38, lineHeight: 42 },
  h2: { color: ui.text, fontSize: 21, lineHeight: 26, marginTop: 2 },
  p: { color: ui.text, fontSize: 16, lineHeight: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { backgroundColor: ui.panel, color: ui.text, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 13, fontSize: 16, borderWidth: 2, borderColor: ui.line },
});
