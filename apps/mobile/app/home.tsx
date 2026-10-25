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
import { Brand, Btn, Chip, D, Dot, Hairline, Handle, Icon, T } from '@/components/pip/kit';
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
 * rises over the bottom with your own check-in or alert (if any), the hold-for-help button and "I'm okay". The friends
 * sidebar opens with how your friends stand ("Keep an eye on …"), then lists everyone's status.
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
  const line = myLine({ alarmed, sosActive, checkOpen, myEsc });
  const friendsNote = friendsLine({ worst, others });

  const column = Math.min(width, MAX_COLUMN);
  const okayCaption = checkOpen ? 'Unlock first, then type a short phrase.'
    : alarmed ? (standDown.state === 'pending' ? 'Confirm it’s you…' : standDown.state === 'failed' ? 'Could not confirm. Try again.' : 'Stands the alert down. Needs your fingerprint.')
    : saidOkayAt ? `Friends told you’re okay · ${ago(saidOkayAt, now)}`
    : null;
  const nightLabel = Platform.OS === 'web' ? 'Web preview' : `Night mode · ${nightOn ? 'on' : 'off'}`;
  const calm = calmLine({ nightOn, worst, others });
  const headerH = insets.top + 56;

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <View style={[styles.column, { width: column }]}>
        <FriendsMap testID="friends-map" people={mapPeople} anchor={anyPlaced ? anchor : null} onSelect={open} insetTop={headerH} insetBottom={sheetH} style={StyleSheet.absoluteFill} />

        <View style={[styles.header, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <View style={styles.pill}><Brand size={24} /></View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {/* Night mode's own switch (with what it pauses) lives on your page. */}
            <Pressable accessibilityRole="button" accessibilityLabel={`${nightLabel}. Open your page`} hitSlop={4}
              onPress={() => (me ? open(me.f.id) : router.push('/settings'))} style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}>
              <View style={[styles.pillDot, nightOn && { backgroundColor: ht.mint }]} />
              <D style={styles.pillText}>{nightLabel}</D>
            </Pressable>
            <Pressable accessibilityRole="button" hitSlop={4} onPress={openDrawer}
              accessibilityLabel={`Friends${worst ? `: ${worst.f.name} ${worst.c.tone === 'high' ? 'needs you' : 'is on watch'}` : ''}`}
              style={({ pressed }) => [styles.pill, { paddingHorizontal: 12 }, pressed && styles.pillPressed]}>
              {Icon.people(ui.text2, 19)}
              {others.length > 0 && <D style={styles.pillText}>{counts.out}</D>}
              {worst ? <Dot tone={worst.c.tone} size={11} style={{ position: 'absolute', right: -2, top: -2 }} /> : null}
            </Pressable>
          </View>
        </View>

        <View style={{ flex: 1 }} pointerEvents="none" />

        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) + 10 }]} onLayout={(e) => setSheetH(Math.round(e.nativeEvent.layout.height))}>
          <Handle />
          {line ? (
            <>
              <Pressable
                accessibilityRole={line.onPress ? 'button' : undefined}
                onPress={line.onPress === 'check' ? () => router.push('/check-in') : line.onPress === 'snatch' ? () => router.push('/snatch') : undefined}
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
              <Hairline style={{ marginTop: 14, marginBottom: 14 }} />
            </>
          ) : (
            <Pressable accessibilityRole={calm.onPress ? 'button' : undefined} disabled={!calm.onPress}
              onPress={calm.onPress ? () => open(calm.onPress!) : undefined}
              style={({ pressed }) => [styles.calmRow, pressed && { opacity: 0.7 }]}>
              {calm.tone ? <Dot tone={calm.tone} size={11} /> : null}
              <D accessibilityRole="header" style={{ flex: 1, fontSize: 18, lineHeight: 23, color: ui.text }}>{calm.text}</D>
              {calm.onPress ? Icon.chevron(ui.muted) : null}
            </Pressable>
          )}

          <HoldForHelp active={alarmed} pending={standDown.state === 'pending'} onTrigger={onSos} onStandDown={() => void standDown.run()} />

          <Btn
            testID="okay-button" kind="mint" size={48}
            title={checkOpen ? 'I’m okay' : alarmed ? 'I’m okay · stand down' : saidOkayAt ? 'Still okay' : 'I’m okay'}
            icon={checkOpen || alarmed ? Icon.fingerprint(ht.ink) : saidOkayAt ? Icon.check(ht.ink) : undefined}
            onPress={onOkay}
            disabled={standDown.state === 'pending'}
            style={{ marginTop: 10 }}
          />
          {okayCaption ? <T style={{ textAlign: 'center', fontSize: 12.5, lineHeight: 17, color: ui.quiet, marginTop: 8 }}>{okayCaption}</T> : null}
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
            <>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 14 }}>
                <D accessibilityRole="header" style={{ fontSize: 26, lineHeight: 30 }}>Friends</D>
                <T style={{ fontSize: 13, lineHeight: 18, color: ui.quiet }}>{counts.out} out · {counts.home} home</T>
              </View>
              {friendsNote && (
                <Pressable
                  accessibilityRole={friendsNote.onPress ? 'button' : undefined}
                  onPress={friendsNote.onPress ? () => open(friendsNote.onPress!) : undefined}
                  disabled={!friendsNote.onPress}
                  style={({ pressed }) => [styles.lineRow, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
                    {friendsNote.tag && <Chip fill={friendsNote.tag.fill} small>{friendsNote.tag.text}</Chip>}
                    <D style={{ fontSize: 22, lineHeight: 26 }}>{friendsNote.title}</D>
                    {friendsNote.sub ? <T style={{ fontSize: 13.5, lineHeight: 18, color: ui.quiet }} numberOfLines={3}>{friendsNote.sub}</T> : null}
                  </View>
                  {friendsNote.onPress ? <View style={{ marginTop: 10 }}>{Icon.chevron(ui.muted)}</View> : null}
                </Pressable>
              )}
            </>
          )}
        />
      </FriendsDrawer>
    </View>
  );
}

type Line = { tag?: { text: string; fill: string }; title: string; sub: string; onPress?: string };

const MINE: Record<string, { title: string; sub: string; tag: string }> = {
  check: { title: 'You okay?', sub: 'pip hasn’t told anyone yet. Answer the check-in so your friends know you’re good.', tag: 'Check-in' },
  heads_up: { title: 'Your friends got a heads-up.', sub: 'pip hasn’t shared your location yet. Answer the check-in if you’re fine.', tag: 'No answer' },
  unlocked: { title: 'Your location is open.', sub: 'Your friends can see where you are and decide what to do.', tag: 'Location opened' },
  snatch: { title: 'Someone may have snatched your phone.', sub: 'Don’t chase. pip told your friends.', tag: 'Snatch' },
  sos: { title: 'pip told your friends.', sub: 'They can see your location now.', tag: 'Help called' },
};

/** Your own state for the sheet: a check-in, SOS or snatch. Nothing when you're fine. */
function myLine(a: { alarmed: boolean; sosActive: boolean; checkOpen: boolean; myEsc: string }): Line | null {
  if (!a.alarmed && !a.checkOpen) return null;
  const key = a.sosActive ? 'sos' : a.myEsc === 'snatch' ? 'snatch' : a.myEsc === 'heads_up' || a.myEsc === 'unlocked' ? a.myEsc : 'check';
  const m = MINE[key];
  return { tag: { text: m.tag, fill: key === 'check' ? ht.lilac : ht.coral }, title: m.title, sub: m.sub, onPress: key === 'snatch' ? 'snatch' : key === 'sos' ? undefined : 'check' };
}

const names = (xs: string[]) => (xs.length <= 3 ? xs.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`);

/** The sheet's one line when nothing of yours is open: how the night stands, in a sentence (as on the site). */
function calmLine(a: { nightOn: boolean; worst: Person | null; others: Person[] }): { text: string; tone?: Person['c']['tone']; onPress?: string } {
  if (a.worst) {
    const { f, c } = a.worst;
    return { text: c.tone === 'high' ? `${f.name} might not be okay.` : `Keep an eye on ${f.name}.`, tone: c.tone, onPress: f.id };
  }
  const out = a.others.filter((p) => p.c.tone === 'out');
  const together = out.filter((p) => p.c.headline === 'Together').map((p) => p.f.name);
  if (!a.nightOn) return { text: out.length ? `Night mode is off. ${names(out.map((p) => p.f.name))} ${out.length === 1 ? 'is' : 'are'} out.` : 'You’re home. Have a good night.' };
  if (together.length) return { text: `Out with ${names(together)}. Everyone’s okay.` };
  if (out.length) return { text: `${names(out.map((p) => p.f.name))} ${out.length === 1 ? 'is' : 'are'} out too. Everyone’s okay.` };
  return { text: a.others.length ? 'Night mode is on. Your friends are home.' : 'Night mode is on. Add a friend to look out for you.' };
}

/** How your friends stand, shown at the top of the Friends drawer. `onPress` is the friend to open. */
function friendsLine(a: { worst: Person | null; others: Person[] }): Line | null {
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
  if (!a.others.length) return null; // the list already says how to add friends
  const okay = a.others.filter((p) => p.c.saidOkay).map((p) => p.f.name);
  return {
    tag: { text: 'All quiet', fill: ht.mint },
    title: 'All quiet.',
    sub: okay.length ? `${okay.join(', ')} said they’re okay` : '',
  };
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.ground, alignItems: 'center' },
  column: { flex: 1, maxWidth: MAX_COLUMN, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 },
  // the site's status pill: paper on a thin line, Fredoka in ink-mid
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 14, borderRadius: 999,
    backgroundColor: ui.panel, borderWidth: 1.5, borderColor: ui.line,
    shadowColor: ht.ink, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  pillPressed: { backgroundColor: ui.sunk },
  pillDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: ui.panel, borderWidth: 1.5, borderColor: ht.ink },
  pillText: { fontSize: 14, lineHeight: 18, color: ui.text2 },
  sheet: {
    backgroundColor: ui.panel, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1.5, borderBottomWidth: 0, borderColor: ui.line,
    paddingTop: 10, paddingHorizontal: 18,
    shadowColor: ht.ink, shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: -4 }, elevation: 8,
  },
  calmRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, marginBottom: 14, minHeight: 46 },
  lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 16 },
});
