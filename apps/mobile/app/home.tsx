import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { format } from 'date-fns';
import { SafetyNative } from '@/modules/safety-native';
import { useBiometricConfirm } from '@/components/ConfirmItsYou';
import { FriendsDrawer } from '@/components/pip/FriendsDrawer';
import { FriendsList } from '@/components/pip/FriendsList';
import { FriendsMap, type MapPerson } from '@/components/pip/FriendsMap';
import { HoldForHelp } from '@/components/pip/HoldForHelp';
import { NightModeSwitch } from '@/components/pip/NightModeSwitch';
import { Brand, Btn, Chip, D, Dot, Hairline, Handle, Icon, IconBtn, T } from '@/components/pip/kit';
import { whereIs } from '@/components/pip/where';
import { usePeople, type Person } from '@/components/pip/usePeople';
import { ago, isActive } from '@/lib/concern';
import { sos, tellFriendsOkay } from '@/lib/native';
import { useFriends } from '@/lib/friends';
import { useStore } from '@/lib/store';
import { OKAY_SHOWN_MS } from '@/lib/telemetry';
import { ht, ui } from '@/lib/theme';

const MAX_COLUMN = 520;

/**
 * Home. The map fills the screen: you in sky, friends placed where they are, the group's zone in lilac. A paper sheet
 * rises over the bottom with one line on how things stand, the hold-for-help button and "I'm okay". A sidebar lists
 * everyone's status.
 */
export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { me, myLoc, others, counts, now } = usePeople();
  const anchor = useFriends((s) => s.anchor);
  const [drawer, setDrawer] = useState(false);
  const [sheetH, setSheetH] = useState(300);
  const openDrawer = useCallback(() => setDrawer(true), []);
  const closeDrawer = useCallback(() => setDrawer(false), []);

  // My own state comes from native directly (faster than my telemetry echo).
  const status = useStore((s) => s.status);
  const sosActive = useStore((s) => s.sosActive);
  const snatch = useStore((s) => s.snatch);
  const pendingCheck = useStore((s) => s.pendingCheck);
  const myEsc = snatch ? 'snatch' : status?.engine.escalation ?? me?.f.escalation ?? 'idle';
  // A manual SOS (or a snatch) is stood down with a fingerprint; the engine's own escalation is answered with a check-in.
  const alarmed = sosActive || myEsc === 'snatch';
  const checkOpen = !alarmed && (!!pendingCheck || myEsc === 'check' || myEsc === 'heads_up' || myEsc === 'unlocked');
  const nightOn = status ? status.nightMode.active : me?.f.nightMode ?? false;

  // "I'm okay" said by hand: shown here at once, and to friends through the feed.
  const [okaySentAt, setOkaySentAt] = useState<number | null>(null);
  const saidOkayAt = useMemo(() => {
    const feed = me?.f.okayAt ?? null;
    const t = Math.max(okaySentAt ?? 0, feed ?? 0);
    return t && now - t < OKAY_SHOWN_MS && !checkOpen && !alarmed ? t : null;
  }, [me?.f.okayAt, okaySentAt, now, checkOpen, alarmed]);

  const standDownAction = useCallback(() => SafetyNative.cancelSos(), []);
  const standDown = useBiometricConfirm(standDownAction, undefined, 1500);
  useEffect(() => { if (!alarmed && standDown.state !== 'idle') standDown.reset(); }, [alarmed, standDown]);

  const onOkay = () => {
    if (alarmed) { void standDown.run(); return; }
    if (checkOpen) { router.push('/check-in'); return; }
    setOkaySentAt(Date.now());
    void tellFriendsOkay();
  };
  const onSos = () => { void sos(); };
  const open = useCallback((id: string) => { setDrawer(false); router.push(`/friend/${encodeURIComponent(id)}`); }, [router]);

  const mapPeople: MapPerson[] = useMemo(() => {
    const list: MapPerson[] = others.map((p) => ({ id: p.f.id, initial: p.f.initial, name: p.f.name, tone: p.c.tone, loc: p.f.loc }));
    if (me) list.push({ id: me.f.id, initial: me.f.initial, name: 'You', tone: me.c.tone, isMe: true, loc: myLoc });
    return list;
  }, [others, me, myLoc]);
  const anyPlaced = mapPeople.some((p) => p.loc);
  const worst = others[0] && (others[0].c.tone === 'high' || others[0].c.tone === 'mild') ? others[0] : null;
  const line = headline({ alarmed, sosActive, checkOpen, myEsc, worst, others, counts, now, saidOkayAt });

  const column = Math.min(width, MAX_COLUMN);
  const okayCaption = checkOpen ? 'Unlock first, then type a short phrase.'
    : alarmed ? (standDown.state === 'pending' ? 'Confirm it’s you…' : standDown.state === 'failed' ? 'Could not confirm. Try again.' : 'Stands the alert down. Needs your fingerprint.')
    : saidOkayAt ? `Friends told · ${ago(saidOkayAt, now)}`
    : 'Tells your friends you’re fine. Nothing else changes.';
  const headerH = insets.top + 62;

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View style={[styles.column, { width: column }]}>
        <FriendsMap testID="friends-map" people={mapPeople} anchor={anyPlaced ? anchor : null} onSelect={open} insetTop={headerH} insetBottom={sheetH} style={StyleSheet.absoluteFill} />

        <View style={[styles.header, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <IconBtn label="You and settings" onPress={() => router.push('/settings')}>{Icon.sliders(ui.text)}</IconBtn>
          <View style={styles.brandPill}>
            <Brand size={22} />
            <T style={{ fontSize: 12.5, lineHeight: 16, color: ui.quiet, fontWeight: '500' }}>
              {Platform.OS === 'web' ? 'Web' : nightOn ? 'Night mode on' : 'Night mode off'}
              {counts.out ? ` · ${counts.out} out` : ''}
            </T>
          </View>
          <IconBtn label={`Friends${worst ? `: ${worst.f.name} ${worst.c.tone === 'high' ? 'needs you' : 'is on watch'}` : ''}`} onPress={openDrawer}
            badge={worst ? <Dot tone={worst.c.tone} size={12} style={{ position: 'absolute', right: -3, top: -3 }} /> : undefined}>
            {Icon.people(ui.text)}
          </IconBtn>
        </View>

        <View style={{ flex: 1 }} pointerEvents="none" />

        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 10 }]} onLayout={(e) => setSheetH(Math.round(e.nativeEvent.layout.height))}>
          <Handle />
          <Pressable
            accessibilityRole={line.onPress ? 'button' : undefined}
            onPress={line.onPress === 'friends' ? openDrawer : line.onPress === 'groups' ? () => router.push('/groups') : line.onPress === 'check' ? () => router.push('/check-in') : line.onPress === 'snatch' ? () => router.push('/snatch') : line.onPress ? () => open(line.onPress!) : undefined}
            disabled={!line.onPress}
            style={({ pressed }) => [styles.lineRow, pressed && { opacity: 0.7 }]}
          >
            <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
              {line.tag && <Chip fill={line.tag.fill} small>{line.tag.text}</Chip>}
              <D accessibilityRole="header" style={{ fontSize: 28, lineHeight: 32 }}>{line.title}</D>
              <T style={{ fontSize: 14, lineHeight: 19, color: ui.quiet }} numberOfLines={2}>{line.sub}</T>
            </View>
            {line.onPress ? <View style={{ marginTop: 12 }}>{Icon.chevron(ui.muted)}</View> : null}
          </Pressable>
          <Hairline style={{ marginTop: 16, marginBottom: 16 }} />

          <HoldForHelp active={alarmed} pending={standDown.state === 'pending'} onTrigger={onSos} onStandDown={() => void standDown.run()} />

          <Btn
            testID="okay-button" kind="main" size={56}
            title={checkOpen ? 'I’m okay' : alarmed ? 'I’m okay · stand down' : saidOkayAt ? 'Still okay' : 'I’m okay'}
            icon={checkOpen || alarmed ? Icon.fingerprint(ht.cream) : Icon.check(ht.cream)}
            onPress={onOkay}
            disabled={standDown.state === 'pending'}
            style={{ marginTop: 12 }}
          />
          <T style={{ textAlign: 'center', fontSize: 12.5, lineHeight: 17, color: ui.quiet, marginTop: 8 }}>{okayCaption}</T>

          <NightModeSwitch style={{ marginTop: 6 }} />
        </View>
      </View>

      <FriendsDrawer open={drawer} onClose={closeDrawer}>
        <FriendsList
          me={me} others={others}
          onOpen={open}
          onGroups={() => { setDrawer(false); router.push('/groups'); }}
          onHistory={() => { setDrawer(false); router.push('/history'); }}
          onSettings={() => { setDrawer(false); router.push('/settings'); }}
          header={(
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 14 }}>
              <D accessibilityRole="header" style={{ fontSize: 26, lineHeight: 30 }}>Friends</D>
              <T style={{ fontSize: 13, lineHeight: 18, color: ui.quiet }}>{counts.out} out · {counts.home} home</T>
            </View>
          )}
        />
      </FriendsDrawer>
    </View>
  );
}

type Line = { tag?: { text: string; fill: string }; title: string; sub: string; onPress?: string };

const MINE: Record<string, { title: string; sub: string; tag: string }> = {
  check: { title: 'You okay?', sub: 'Nobody has been told yet. Answer the check-in so your friends know you’re good.', tag: 'Check-in' },
  heads_up: { title: 'Your friends got a heads-up.', sub: 'No location shared yet. Answer the check-in if you’re fine.', tag: 'No answer' },
  unlocked: { title: 'Your location is open.', sub: 'Your friends can see where you are and decide what to do.', tag: 'Location opened' },
  snatch: { title: 'Phone may have been snatched.', sub: 'Don’t chase. Your friends have been told.', tag: 'Snatch' },
  sos: { title: 'Friends were told.', sub: 'Your location is open to them right now.', tag: 'Help called' },
};

function headline(a: {
  alarmed: boolean; sosActive: boolean; checkOpen: boolean; myEsc: string; worst: Person | null; others: Person[];
  counts: { out: number; home: number }; now: number; saidOkayAt: number | null;
}): Line {
  if (a.alarmed || a.checkOpen) {
    const key = a.sosActive ? 'sos' : a.myEsc === 'snatch' ? 'snatch' : a.myEsc === 'heads_up' || a.myEsc === 'unlocked' ? a.myEsc : 'check';
    const m = MINE[key];
    return { tag: { text: m.tag, fill: key === 'check' ? ht.lilac : ht.coral }, title: m.title, sub: m.sub, onPress: key === 'snatch' ? 'snatch' : key === 'sos' ? undefined : 'check' };
  }
  if (a.worst) {
    const { f, c } = a.worst;
    const newest = [...f.records].reverse().find((r) => isActive(r) && r.tier !== 'context');
    const since = newest ? format(newest.tMs, 'h:mm a') : f.checkDeadlineMs ? 'check-in' : null;
    const where = whereIs(a.worst);
    const more = a.others.filter((p) => p !== a.worst && (p.c.tone === 'high' || p.c.tone === 'mild')).map((p) => p.f.name);
    return {
      tag: { text: `${c.tone === 'high' ? 'Heads-up' : 'Watch'}${since ? ` · ${since}` : ''}`, fill: c.tone === 'high' ? ht.coral : ht.butter },
      title: c.tone === 'high' ? `${f.name} might not be okay.` : `Keep an eye on ${f.name}.`,
      sub: [c.headline, where, more.length ? `also ${more.join(', ')}` : null].filter(Boolean).join(' · '),
      onPress: f.id,
    };
  }
  if (!a.others.length) return { title: 'Just you so far.', sub: 'Add friends in person: one of you scans the other’s code.', onPress: 'groups' };
  const okay = a.others.filter((p) => p.c.saidOkay).map((p) => p.f.name);
  return {
    tag: { text: 'All quiet', fill: ht.mint },
    title: 'All quiet.',
    sub: [`${a.counts.out} out · ${a.counts.home} home`, okay.length ? `${okay.join(', ')} said they’re okay` : null].filter(Boolean).join(' · '),
    onPress: 'friends',
  };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.ground, alignItems: 'center' },
  column: { flex: 1, maxWidth: MAX_COLUMN, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 14 },
  brandPill: {
    flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, paddingLeft: 12, paddingRight: 16, borderRadius: 999,
    backgroundColor: ui.panel, borderWidth: 2, borderColor: ht.ink,
  },
  sheet: {
    backgroundColor: ui.panel, borderTopLeftRadius: 30, borderTopRightRadius: 30, borderWidth: 2, borderBottomWidth: 0, borderColor: ht.ink,
    paddingTop: 10, paddingHorizontal: 22,
  },
  lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 16 },
});
