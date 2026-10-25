import React, { useMemo, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { format } from 'date-fns';
import { FriendsMap, type MapPerson } from '@/components/pip/FriendsMap';
import { fmtDist, whereIs } from '@/components/pip/where';
import { Btn, Caps, Chip, D, Hairline, Handle, Icon, IconBtn, T, TextAction } from '@/components/pip/kit';
import { Timeline } from '@/components/pip/Timeline';
import { NightModeSwitch } from '@/components/pip/NightModeSwitch';
import { usePeople, type Person } from '@/components/pip/usePeople';
import { ago, isActive, serverIncidentLine } from '@/lib/concern';
import { useFriends, walkMinutes } from '@/lib/friends';
import { useStore } from '@/lib/store';
import { ht, ui } from '@/lib/theme';

const MAX_COLUMN = 520;

/** One person: where they are on the map, how worried to be, everything flagged tonight, and what you can do. */
export default function FriendScreen() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = decodeURIComponent(String(raw ?? ''));
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const { me, myLoc, others, now, ready } = usePeople();
  const anchor = useFriends((s) => s.anchor);
  const logRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const p: Person | null = me?.f.id === id ? me : others.find((o) => o.f.id === id) ?? null;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  const column = Math.min(width, MAX_COLUMN);
  const mapH = Math.max(220, Math.round(height * 0.38));

  const mapPeople: MapPerson[] = useMemo(() => {
    const list: MapPerson[] = others.map((o) => ({ id: o.f.id, initial: o.f.initial, name: o.f.name, tone: o.c.tone, loc: o.f.loc }));
    if (me) list.push({ id: me.f.id, initial: me.f.initial, name: 'You', tone: me.c.tone, isMe: true, loc: myLoc });
    return list;
  }, [others, me, myLoc]);

  if (!p) {
    return (
      <View style={[styles.screen, { justifyContent: 'center', padding: 24, gap: 16 }]}>
        <StatusBar style="dark" />
        <T style={{ fontSize: 17, textAlign: 'center' }}>{ready ? 'This person is not in your groups.' : 'Loading…'}</T>
        <Btn title="Back" kind="paper" onPress={back} />
      </View>
    );
  }
  const { f, c } = p;
  const newest = [...f.records].reverse().find((r) => isActive(r) && r.tier !== 'context');
  const tag = f.isMe
    ? { text: f.nightMode ? 'Night mode on' : 'Daytime', fill: f.nightMode ? ht.sky : ht.paper }
    : {
      text: `${c.tone === 'high' ? 'Heads-up' : c.tone === 'mild' ? 'Watch' : c.tone === 'home' ? 'Home' : c.tone === 'offline' ? 'Quiet phone' : 'Out'}${newest ? ` · ${format(newest.tMs, 'h:mm a')}` : f.lastTickAt && c.tone !== 'offline' ? ` · ${ago(f.lastTickAt, now)}` : ''}`,
      fill: c.tone === 'high' ? ht.coral : c.tone === 'mild' ? ht.butter : c.tone === 'out' ? ht.mint : ht.paper,
    };
  const title = f.isMe
    ? f.name === 'You' ? 'You.' : `${f.name}, that’s you.`
    : c.tone === 'high' ? `${f.name} might not be okay.`
      : c.tone === 'mild' ? `Keep an eye on ${f.name}.`
        : c.tone === 'home' ? `${f.name} is home.`
          : c.tone === 'offline' ? `${f.name}’s phone is quiet.`
            : c.saidOkay ? `${f.name} says they’re okay.` : `${f.name} is out.`;
  const where = whereIs(p);
  const sub = f.isMe
    ? f.nightMode ? 'Location sealed on this phone.' : 'Night mode starts by itself when you leave home in the evening.'
    : [c.headline, where ? `${where}${p.distM != null ? ` · ${walkMinutes(p.distM)} min walk` : ''}` : null, f.simulated ? 'simulated' : null].filter(Boolean).join(' · ');

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View style={[styles.column, { width: column }]}>
        <View style={{ height: mapH + insets.top }}>
          <FriendsMap people={mapPeople} anchor={anchor} focusId={f.isMe ? null : f.id} insetTop={insets.top + 60}
            onSelect={(x) => x !== f.id && router.replace(`/friend/${encodeURIComponent(x)}`)} style={StyleSheet.absoluteFill} />
          <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
            <IconBtn label="Back" onPress={back}>{Icon.back()}</IconBtn>
            {!f.isMe && <CallButton p={p} />}
          </View>
        </View>

        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 12 }]}>
          <Handle />
          <View style={{ marginTop: 16 }}>
            <Chip fill={tag.fill} small>{tag.text}</Chip>
          </View>
          <D accessibilityRole="header" style={{ fontSize: 30, lineHeight: 34, marginTop: 8 }}>{title}</D>
          <T style={{ fontSize: 14, lineHeight: 20, color: ui.quiet, marginTop: 6 }}>{sub}</T>

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}>
            <Caps>TONIGHT</Caps>
            <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/monitor', params: { subject: f.id } })} hitSlop={10}>
              <T style={{ fontSize: 13, lineHeight: 18, color: ui.link, fontWeight: '600' }}>Full console</T>
            </Pressable>
          </View>
          <ScrollView ref={logRef} style={{ flex: 1, marginTop: 10 }} contentContainerStyle={{ paddingBottom: 8 }} onContentSizeChange={() => logRef.current?.scrollToEnd({ animated: false })}>
            <Timeline records={f.records} check={{ pending: f.checkPending, deadlineMs: f.checkDeadlineMs, summary: f.checkSummary }} now={now}
              empty={c.offline ? `${f.isMe ? 'Your' : `${f.name}’s`} phone is not streaming right now. The log shows up here when it does.` : 'Nothing flagged tonight.'} />
          </ScrollView>

          {f.serverIncident && (
            // The server incident is where friends act (unlock the map, on my way, found) and the owner stands it down.
            <Btn testID="open-incident" kind="coral" title={`Open alert · ${serverIncidentLine(f.serverIncident.level)}`}
              onPress={() => router.push(`/incident/${f.serverIncident!.id}`)} style={{ marginBottom: 10 }} />
          )}
          <Hairline style={{ marginBottom: 8 }} />
          {f.isMe
            ? <MyActions onSettings={() => router.push('/settings')} onHistory={() => router.push('/history')} />
            : <FriendActions p={p} onFriends={() => router.push('/friends')} />}
        </View>
      </View>
    </View>
  );
}

function CallButton({ p }: { p: Person }) {
  const { f } = p;
  const call = () => { if (f.phone) void Linking.openURL(`tel:${f.phone.replace(/[^\d+]/g, '')}`); };
  return (
    <IconBtn label={f.phone ? `Call ${f.name}` : `${f.name} has no number yet`} onPress={call} style={{ opacity: f.phone ? 1 : 0.4 }}>
      {Icon.phone(ui.text, 20)}
    </IconBtn>
  );
}

function FriendActions({ p, onFriends }: { p: Person; onFriends: () => void }) {
  const { f } = p;
  const groups = useStore((s) => s.groups);
  const campus = groups.find((g) => g.campus_safety_number)?.campus_safety_number ?? null;
  const [note, setNote] = useState<string | null>(null);
  const go = () => f.loc && void Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${f.loc.lat},${f.loc.lng}&travelmode=walking`);
  const call = () => {
    if (f.phone) void Linking.openURL(`tel:${f.phone.replace(/[^\d+]/g, '')}`);
    else setNote(f.simulated ? `${f.name} is a simulated friend, so there is no number to call.` : `${f.name} has not added a phone number yet.`);
  };
  const campusCall = () => {
    if (campus) void Linking.openURL(`tel:${campus.replace(/[^\d+]/g, '')}`);
    else setNote('No campus safety number yet. Add one under Groups.');
  };
  return (
    <View>
      {note && <T style={{ fontSize: 13, lineHeight: 18, color: ui.quiet, textAlign: 'center', marginBottom: 8 }}>{note}</T>}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn title={`Call ${f.name}`} kind="paper" size={44} icon={Icon.phone(ui.text, 16)} onPress={call} style={{ flex: 1 }} />
        <Btn title="Campus safety" kind="paper" size={44} onPress={campusCall} style={{ flex: 1 }} />
      </View>
      <View style={{ flexDirection: 'row' }}>
        <TextAction title="All friends" onPress={onFriends} color={ui.quiet} style={{ flex: 1 }} />
      </View>
      <Btn kind="main" size={56} iconRight={Icon.arrow(ht.cream)} title={`Go to ${f.name}${p.distM != null ? ` · ${fmtDist(p.distM)}` : ''}`} onPress={go} disabled={!f.loc} style={{ marginTop: 2 }} />
    </View>
  );
}

function MyActions({ onSettings, onHistory }: { onSettings: () => void; onHistory: () => void }) {
  return (
    <View>
      <NightModeSwitch />
      <View style={{ flexDirection: 'row' }}>
        <TextAction title="Settings" onPress={onSettings} style={{ flex: 1 }} />
        <TextAction title="History" onPress={onHistory} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.ground, alignItems: 'center' },
  column: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 14 },
  sheet: {
    flex: 1, marginTop: -26, backgroundColor: ui.panel, borderTopLeftRadius: 30, borderTopRightRadius: 30, borderWidth: 2, borderBottomWidth: 0, borderColor: ht.ink,
    paddingTop: 10, paddingHorizontal: 22,
  },
});
