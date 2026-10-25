// Everyone's status as a list: you, then friends who are out (worst first), then friends at home. Shared by the
// sidebar on the home screen and the full-screen Friends route.
import React from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { tones, ui } from '@/lib/theme';
import { Dot, Hairline, Icon, Row, SectionLabel, T } from './kit';
import { whereIs } from './where';
import type { Person } from './usePeople';

export type FriendsListProps = {
  me: Person | null;
  others: Person[];
  onOpen: (id: string) => void;
  onGroups: () => void;
  onHistory: () => void;
  onSettings: () => void;
  /** padding at the end of the scroll */
  bottomInset?: number;
  style?: StyleProp<ViewStyle>;
  header?: React.ReactNode;
};

export function FriendsList({ me, others, onOpen, onGroups, onHistory, onSettings, bottomInset = 24, style, header }: FriendsListProps) {
  const out = others.filter((p) => p.c.tone !== 'home');
  const home = others.filter((p) => p.c.tone === 'home');
  return (
    <ScrollView style={style} contentContainerStyle={{ paddingBottom: bottomInset }} showsVerticalScrollIndicator={false}>
      {header}
      {me && (
        <>
          <SectionLabel>YOU</SectionLabel>
          <PersonRow p={me} onOpen={() => onOpen(me.f.id)} last />
        </>
      )}
      {out.length > 0 && <SectionLabel>OUT</SectionLabel>}
      {out.map((p, i) => <PersonRow key={p.f.id} p={p} onOpen={() => onOpen(p.f.id)} last={i === out.length - 1} />)}
      {home.length > 0 && <SectionLabel>HOME</SectionLabel>}
      {home.map((p, i) => <PersonRow key={p.f.id} p={p} onOpen={() => onOpen(p.f.id)} last={i === home.length - 1} />)}
      {!others.length && (
        <T style={{ fontSize: 14, lineHeight: 20, color: ui.quiet, marginTop: 12 }}>
          Just you so far. Friends are added in person: one of you scans the other’s code.
        </T>
      )}
      <View style={{ height: 22 }} />
      <Hairline />
      <Row title="Groups and adding friends" left={Icon.people(ui.text2, 20)} onPress={onGroups} height={54} />
      <Hairline />
      <Row title="History" left={Icon.clock(ui.text2, 20)} onPress={onHistory} height={54} />
      <Hairline />
      <Row title="Settings" left={Icon.sliders(ui.text2, 20)} onPress={onSettings} height={54} />
    </ScrollView>
  );
}

function PersonRow({ p, onOpen, last }: { p: Person; onOpen: () => void; last?: boolean }) {
  const { f, c } = p;
  const strong = c.tone === 'high' || c.tone === 'mild';
  const recede = c.tone === 'home' || c.tone === 'offline';
  const where = whereIs(p);
  const sub = f.isMe
    ? f.nightMode ? 'Night mode on · location sealed' : 'Daytime'
    : [c.headline, where, f.simulated ? 'simulated' : null].filter(Boolean).join(' · ');
  const call = () => { if (f.phone) void Linking.openURL(`tel:${f.phone.replace(/[^\d+]/g, '')}`); };
  return (
    <View style={[s.row, !last && s.rowLine]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${f.name}${f.isMe ? ' (you)' : ''}: ${sub}`} onPress={onOpen}
        style={({ pressed }) => [{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, minWidth: 0 }, pressed && { opacity: 0.6 }]}>
        <Dot tone={c.tone} isMe={f.isMe} size={f.isMe ? 14 : 12} />
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <T style={{ fontSize: 16, lineHeight: 21, fontWeight: '500', color: recede ? ui.quiet : ui.text }} numberOfLines={1}>
            {f.name}{f.isMe && f.name !== 'You' ? ' (you)' : ''}
          </T>
          <T style={{ fontSize: 13, lineHeight: 17, color: strong ? tones[c.tone].text : ui.quiet }} numberOfLines={1}>{sub}</T>
        </View>
      </Pressable>
      {!f.isMe && (
        <Pressable accessibilityRole="button" accessibilityLabel={f.phone ? `Call ${f.name}` : `${f.name} has no number`} onPress={call} disabled={!f.phone}
          style={({ pressed }) => [{ width: 44, height: 44, marginRight: -10, alignItems: 'center', justifyContent: 'center', opacity: !f.phone ? 0.25 : pressed ? 0.6 : 1 }]}>
          {Icon.phone(recede ? ui.quiet : ui.text)}
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  rowLine: { borderBottomWidth: 1.5, borderBottomColor: ui.line },
});
