import React, { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { Button, Card, H2, Input, P, Pill, Row, Screen } from '@/components/ui';
import { Dot, Icon, Mono, T, Tabs } from '@/components/pip/kit';
import { SafetyNative, type Identity } from '@/modules/safety-native';
import { DEFAULT_THRESHOLD_K, MIN_MEMBERS_FOR_FALLBACK, useStore, useUserId } from '@/lib/store';
import { createGroup, leaveGroup, rpc, updateGroup } from '@/lib/db';
import { refreshAll } from '@/lib/native';
import { colors, ht, ui } from '@/lib/theme';

export default function Friends() {
  const router = useRouter();
  const userId = useUserId();
  const groups = useStore((s) => s.groups);
  const members = useStore((s) => s.members);
  const profiles = useStore((s) => s.profiles);
  const [fetchedIdentity, setIdentity] = useState<Identity | null>(null);
  // Never show a QR whose id is not the signed-in user (a friend scanning it would invite a stranger or fail).
  const identity = fetchedIdentity && fetchedIdentity.userId === userId ? fetchedIdentity : null;
  const [showQr, setShowQr] = useState(false);
  const [name, setName] = useState('');

  // Re-read on account change (the first read can land before sign-in finished configuring).
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    SafetyNative.getIdentity().then((id) => { if (alive) setIdentity(id); }).catch(() => {});
    return () => { alive = false; };
  }, [userId]);

  const create = async () => {
    if (!userId || !name.trim()) return;
    await createGroup({ name: name.trim(), owner_id: userId, threshold_k: DEFAULT_THRESHOLD_K });
    setName('');
    await refreshAll();
  };
  const setK = (groupId: string, k: number) => updateGroup(groupId, { threshold_k: k }).then(refreshAll);
  const setCampus = (groupId: string, n: string) => updateGroup(groupId, { campus_safety_number: n || null }).then(refreshAll);
  const accept = (groupId: string) => rpc.acceptInvite(groupId).then(refreshAll).catch((e) => Alert.alert('Could not accept invite', e.message));
  const leave = (groupId: string) => userId && leaveGroup(groupId, userId).then(refreshAll);

  const qrPayload = identity ? JSON.stringify({ v: 1, userId: identity.userId, fp: identity.fingerprint, x: identity.x25519Pub, e: identity.ed25519Pub }) : '';

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>Your code</H2>
          <Button title={showQr ? 'Hide' : 'Show QR'} kind="ghost" icon={Icon.qr(ui.text, 16)} onPress={() => setShowQr(!showQr)} />
        </Row>
        <P muted>You add friends in person by scanning, so nobody can swap in a fake key.</P>
        {showQr && identity && (
          <View style={{ alignItems: 'center', gap: 10, padding: 16, backgroundColor: ht.paper, borderRadius: 18, borderWidth: 2, borderColor: ht.ink }}>
            <QRCode value={qrPayload} size={200} color={ht.ink} backgroundColor={ht.paper} />
            <Mono style={{ fontSize: 12, color: ui.quiet }}>{identity.fingerprint}</Mono>
          </View>
        )}
      </Card>

      {groups.map((g) => {
        const ms = members.filter((m) => m.group_id === g.id);
        const me = ms.find((m) => m.user_id === userId);
        const active = ms.filter((m) => m.status === 'active').length;
        const n = active - 1; // friends other than me
        const fallbackOk = active >= MIN_MEMBERS_FOR_FALLBACK;
        return (
          <Card key={g.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <H2>{g.name}</H2>
                <P muted style={{ fontSize: 13 }}>{active} active member{active === 1 ? '' : 's'}{ms.length > active ? ` · ${ms.length - active} invited` : ''}</P>
              </View>
              {me?.status === 'invited' ? <Button title="Accept invite" kind="ok" onPress={() => accept(g.id)} /> : <Button title="Leave" kind="ghost" onPress={() => leave(g.id)} />}
            </Row>
            <View>
              {ms.map((m, i) => (
                <View key={m.user_id} style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }, i < ms.length - 1 && { borderBottomWidth: 1.5, borderBottomColor: ui.line }]}>
                  <Dot tone={m.status === 'active' ? 'out' : 'home'} isMe={m.user_id === userId} size={12} />
                  <T style={{ flex: 1, fontSize: 15, fontWeight: '500' }}>{profiles[m.user_id]?.display_name || m.user_id.slice(0, 8)}{m.user_id === userId ? ' (you)' : ''}</T>
                  <Pill text={m.status} color={m.status === 'active' ? colors.ok : colors.warn} />
                </View>
              ))}
            </View>
            <Button title="Scan a friend’s QR to add" icon={Icon.camera(ht.cream, 18)} onPress={() => router.push({ pathname: '/scan', params: { groupId: g.id } })} />
            <P muted style={{ fontSize: 14, lineHeight: 20 }}>
              Fallback unlock needs {g.threshold_k} of {Math.max(n, 0)} friends to agree.
              {fallbackOk ? '' : ` It needs at least ${MIN_MEMBERS_FOR_FALLBACK} active members, so it is off until ${MIN_MEMBERS_FOR_FALLBACK - active} more join.`}
            </P>
            <Tabs items={[2, 3, 4].map((k) => ({ key: String(k), label: `${k} friends` }))} value={String(g.threshold_k)} onChange={(k) => setK(g.id, Number(k))} />
            <Input placeholder="Campus safety number (optional)" keyboardType="phone-pad" defaultValue={g.campus_safety_number ?? ''} onEndEditing={(e) => setCampus(g.id, e.nativeEvent.text)} />
          </Card>
        );
      })}

      <Card>
        <H2>New group</H2>
        <Input placeholder="Saturday crew" value={name} onChangeText={setName} />
        <Button title="Create group" onPress={create} disabled={!name.trim()} />
      </Card>
    </Screen>
  );
}
