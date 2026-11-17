import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { Button, Card, H2, Input, P, Pill, Row, Screen } from '@/components/ui';
import { Dot, Icon, Mono, T, Tabs } from '@/components/pip/kit';
import { SafetyNative, type Identity, type KeyPin } from '@/modules/safety-native';
import { DEFAULT_THRESHOLD_K, MIN_MEMBERS_FOR_FALLBACK, useStore, useUserId } from '@/lib/store';
import { createGroup, createInvite, getDevicesForUsers, leaveGroup, removeMember, subscribe, updateGroup } from '@/lib/db';
import { refreshAll } from '@/lib/native';
import { inviteQr, personQr, secondsLeft } from '@/lib/qr';
import type { Group, Uuid } from '@/lib/types';
import { colors, ht, ui } from '@/lib/theme';

/** Errors show inline on web (Alert.alert is a no-op there). */
const say = (title: string, msg: string) => (Platform.OS === 'web' ? globalThis.alert?.(`${title}\n\n${msg}`) : Alert.alert(title, msg));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Friends & groups. Joining a group only happens in person: a member shows a one-time invite QR (10 minutes, single
 * use), the new friend scans it, and both compare the fingerprint shown on each other's screens. Keys seen that way
 * are pinned as verified; keys first seen from the server are pinned on first use and flagged if they ever change.
 */
export default function Friends() {
  const router = useRouter();
  const userId = useUserId();
  const groups = useStore((s) => s.groups);
  const members = useStore((s) => s.members);
  const profiles = useStore((s) => s.profiles);
  const keyChanged = useStore((s) => s.keyChanged);
  const [fetchedIdentity, setIdentity] = useState<Identity | null>(null);
  // Never show a QR whose id is not the signed-in user (a friend scanning it would verify a stranger).
  const identity = fetchedIdentity && fetchedIdentity.userId === userId ? fetchedIdentity : null;
  const [showMine, setShowMine] = useState(false);
  const [inviting, setInviting] = useState<Uuid | null>(null);
  const [name, setName] = useState('');
  const [pins, setPins] = useState<Record<string, KeyPin>>({});

  const loadPins = useCallback(() => {
    SafetyNative.getPins().then((ps) => setPins(Object.fromEntries(ps.map((p) => [p.userId, p])))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    SafetyNative.getIdentity().then((id) => { if (alive) setIdentity(id); }).catch(() => {});
    loadPins();
    return () => { alive = false; };
  }, [userId, loadPins]);
  useEffect(loadPins, [members, loadPins]);

  const create = async () => {
    if (!userId || !name.trim()) return;
    try {
      const g = await createGroup({ name: name.trim(), owner_id: userId, threshold_k: DEFAULT_THRESHOLD_K });
      setName('');
      await refreshAll();
      setInviting(g.id);
    } catch (e) { say('Could not create the group', errText(e)); }
  };
  const setK = (groupId: string, k: number) => updateGroup(groupId, { threshold_k: k }).then(refreshAll).catch((e) => say('Could not save', errText(e)));
  const setCampus = (groupId: string, n: string) => updateGroup(groupId, { campus_safety_number: n || null }).then(refreshAll).catch((e) => say('Could not save', errText(e)));
  const leave = (g: Group) => {
    const go = () => leaveGroup(g.id).then(refreshAll).catch((e) => say('Could not leave', errText(e)));
    if (Platform.OS === 'web') { if (globalThis.confirm?.(`Leave ${g.name}? Your friends there stop seeing you.`)) void go(); return; }
    Alert.alert(`Leave ${g.name}?`, 'Your friends there stop seeing you, and you stop seeing them.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Leave', style: 'destructive', onPress: () => void go() },
    ]);
  };
  const remove = (g: Group, uid: Uuid) => removeMember(g.id, uid).then(refreshAll).catch((e) => say('Could not remove', errText(e)));
  const nameOf = (id: Uuid) => profiles[id]?.display_name || 'Friend';

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Card>
        <H2>Add friends in person</H2>
        <P muted>Open a group and tap “Show invite code”. Your friend scans it with “Scan a code” on their phone. Codes work once and expire after 10 minutes, so nobody can join from a screenshot.</P>
        <Button title="Scan a code" icon={Icon.camera(ht.cream, 18)} onPress={() => router.push('/scan')} testID="scan-code" />
      </Card>

      {keyChanged.length > 0 && (
        <Card tint={ht.coral}>
          <Row style={{ gap: 10 }}>{Icon.warning(ui.text, 20)}<H2 style={{ flex: 1 }}>Re-verify {keyChanged.map(nameOf).join(', ')}</H2></Row>
          <P>The server now has a different key for them than the one you verified. Until you scan their code in person again, pip will not share your location or escrow keys with that key.</P>
          <Button title="Verify a friend’s code" kind="ghost" icon={Icon.qr(ui.text, 16)} onPress={() => router.push('/scan')} />
        </Card>
      )}

      {groups.map((g) => {
        const ms = members.filter((m) => m.group_id === g.id);
        const isOwner = g.owner_id === userId;
        const n = ms.length - 1; // friends other than me
        const fallbackOk = ms.length >= MIN_MEMBERS_FOR_FALLBACK;
        return (
          <Card key={g.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <H2>{g.name}</H2>
                <P muted style={{ fontSize: 13 }}>{ms.length} member{ms.length === 1 ? '' : 's'}{isOwner ? ' · you own this group' : ''}</P>
              </View>
              <Button title="Leave" kind="ghost" onPress={() => leave(g)} />
            </Row>
            <View>
              {ms.map((m, i) => {
                const pin = pins[m.user_id];
                const changed = keyChanged.includes(m.user_id);
                const me = m.user_id === userId;
                return (
                  <View key={m.user_id} style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }, i < ms.length - 1 && { borderBottomWidth: 1.5, borderBottomColor: ui.line }]}>
                    <Dot tone="out" isMe={me} size={12} />
                    <T style={{ flex: 1, fontSize: 15, fontWeight: '500' }}>{me ? 'You' : nameOf(m.user_id)}{g.owner_id === m.user_id ? ' · owner' : ''}</T>
                    {!me && (changed
                      ? <Pill text="key changed" color={colors.danger} />
                      : pin?.verified ? <Pill text="verified" color={colors.ok} /> : <Pill text="not verified" color={colors.warn} />)}
                    {isOwner && !me && <Button title="Remove" kind="ghost" style={{ paddingVertical: 4 }} onPress={() => void remove(g, m.user_id)} />}
                  </View>
                );
              })}
            </View>
            {inviting === g.id
              ? <InvitePanel group={g} identity={identity} myName={(userId && profiles[userId]?.display_name) || 'A friend'} onClose={() => { setInviting(null); loadPins(); }} />
              : <Button title="Show invite code" icon={Icon.qr(ht.cream, 18)} onPress={() => setInviting(g.id)} testID={`invite-${g.id}`} />}
            {isOwner && (
              <>
                <P muted style={{ fontSize: 14, lineHeight: 20 }}>
                  Fallback unlock needs {g.threshold_k} of {Math.max(n, 0)} friends to agree.
                  {fallbackOk ? '' : ` It needs at least ${MIN_MEMBERS_FOR_FALLBACK} members, so it is off until ${MIN_MEMBERS_FOR_FALLBACK - ms.length} more join.`}
                </P>
                <Tabs items={[2, 3, 4].map((k) => ({ key: String(k), label: `${k} friends` }))} value={String(g.threshold_k)} onChange={(k) => void setK(g.id, Number(k))} />
                <Input placeholder="Campus safety number (optional)" keyboardType="phone-pad" defaultValue={g.campus_safety_number ?? ''} onEndEditing={(e) => void setCampus(g.id, e.nativeEvent.text)} />
              </>
            )}
          </Card>
        );
      })}

      <Card>
        <H2>New group</H2>
        <Input placeholder="Saturday crew" value={name} onChangeText={setName} />
        <Button title="Create group" onPress={create} disabled={!name.trim()} />
      </Card>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>My code</H2>
          <Button title={showMine ? 'Hide' : 'Show'} kind="ghost" icon={Icon.fingerprint(ui.text, 16)} onPress={() => setShowMine(!showMine)} />
        </Row>
        <P muted>Already in a group with someone? Scan each other’s code to check that pip uses the right keys. If a friend’s key ever changes, do this again in person.</P>
        {showMine && identity && (
          <View style={{ alignItems: 'center', gap: 10, padding: 16, backgroundColor: ht.paper, borderRadius: 18, borderWidth: 2, borderColor: ht.ink }}>
            <QRCode value={personQr({ userId: identity.userId, x: identity.x25519Pub, e: identity.ed25519Pub, fp: identity.fingerprint })} size={200} color={ht.ink} backgroundColor={ht.paper} />
            <Mono style={{ fontSize: 12, color: ui.quiet }}>{identity.fingerprint}</Mono>
          </View>
        )}
      </Card>
    </Screen>
  );
}

/**
 * One-time invite QR for a group. Watches its own invite row: when someone redeems it, asks the inviter to compare
 * the joiner's fingerprint with the joiner's screen (pin as verified) or remove them.
 */
function InvitePanel({ group, identity, myName, onClose }: { group: Group; identity: Identity | null; myName: string; onClose: () => void }) {
  const [invite, setInvite] = useState<{ inviteId: Uuid; token: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [joiner, setJoiner] = useState<Uuid | null>(null);

  const make = useCallback(() => {
    setError(null); setInvite(null); setJoiner(null);
    createInvite(group.id).then(setInvite).catch((e) => setError(errText(e)));
  }, [group.id]);
  useEffect(make, [make]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!invite) return;
    const ch = subscribe('group_invites', `id=eq.${invite.inviteId}`, (row) => {
      if (row.used_by) { setJoiner(row.used_by); void refreshAll(); }
    });
    return () => { ch.unsubscribe(); };
  }, [invite]);

  if (joiner) return <ConfirmJoiner group={group} userId={joiner} onDone={onClose} />;
  if (error) return (<View style={{ gap: 8 }}><P style={{ color: colors.danger }}>{error}</P><Row style={{ gap: 8 }}><Button title="Try again" onPress={make} /><Button title="Close" kind="ghost" onPress={onClose} /></Row></View>);
  if (!invite || !identity) return <P muted>Making a code…</P>;
  const left = secondsLeft(invite.expiresAt, now);
  return (
    <View style={{ alignItems: 'center', gap: 10, padding: 16, backgroundColor: ht.paper, borderRadius: 18, borderWidth: 2, borderColor: ht.ink }}>
      {left > 0 ? (
        <>
          <QRCode
            value={inviteQr({ groupId: group.id, groupName: group.name, token: invite.token, userId: identity.userId, name: myName, x: identity.x25519Pub, e: identity.ed25519Pub, fp: identity.fingerprint })}
            size={220} color={ht.ink} backgroundColor={ht.paper}
          />
          <T style={{ fontWeight: '600' }}>Your fingerprint</T>
          <Mono style={{ fontSize: 13, color: ui.text }}>{identity.fingerprint}</Mono>
          <P muted style={{ textAlign: 'center', fontSize: 13 }}>Your friend scans this with “Scan a code”. Their phone shows the same fingerprint if nothing was swapped. Works once · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left</P>
        </>
      ) : (
        <P muted>This code expired.</P>
      )}
      <Row style={{ gap: 8 }}>
        {left === 0 && <Button title="New code" onPress={make} />}
        <Button title="Done" kind="ghost" onPress={onClose} />
      </Row>
    </View>
  );
}

/** The inviter checks the joiner's fingerprint against the joiner's screen. */
function ConfirmJoiner({ group, userId, onDone }: { group: Group; userId: Uuid; onDone: () => void }) {
  const profiles = useStore((s) => s.profiles);
  const [keys, setKeys] = useState<{ x: string; e: string; fp: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = profiles[userId]?.display_name || 'Your friend';

  useEffect(() => {
    let alive = true;
    (async () => {
      for (let i = 0; i < 5 && alive; i++) {
        const [d] = await getDevicesForUsers([userId]);
        if (d?.x25519_pub && d.ed25519_pub) {
          const fp = await SafetyNative.fingerprint(userId, d.x25519_pub, d.ed25519_pub);
          if (alive) setKeys({ x: d.x25519_pub, e: d.ed25519_pub, fp });
          return;
        }
        await new Promise((r) => setTimeout(r, 1500)); // their device row can land a moment after they join
      }
      if (alive) setError(`${name} joined, but their phone has not published its keys yet. Verify them later with “My code”.`);
    })().catch((e) => alive && setError(errText(e)));
    return () => { alive = false; };
  }, [userId, name]);

  const confirm = async () => {
    if (!keys) return;
    const r = await SafetyNative.pinKeys({ userId, x25519Pub: keys.x, ed25519Pub: keys.e, verified: true });
    if (r.status === 'changed') { say('Key mismatch', `This phone already has a different key pinned for ${name}. Remove them and invite again.`); return; }
    await refreshAll();
    onDone();
  };
  const reject = async () => {
    try { await removeMember(group.id, userId); await refreshAll(); } catch (e) { say('Could not remove', errText(e)); }
    onDone();
  };

  return (
    <View style={{ gap: 10, padding: 16, backgroundColor: ht.paper, borderRadius: 18, borderWidth: 2, borderColor: ht.ink }}>
      <H2>{name} joined {group.name}</H2>
      {error ? <P>{error}</P> : !keys ? <P muted>Checking their keys…</P> : (
        <>
          <P>Does {name}’s screen show this fingerprint?</P>
          <Mono style={{ fontSize: 15, color: ui.text, textAlign: 'center' }}>{keys.fp}</Mono>
          <Button title="Yes, it matches" kind="ok" icon={Icon.check(ui.text, 16)} onPress={() => void confirm()} />
          <Button title="No, remove them" kind="danger" onPress={() => void reject()} />
        </>
      )}
      {error && <Button title="OK" kind="ghost" onPress={onDone} />}
    </View>
  );
}
