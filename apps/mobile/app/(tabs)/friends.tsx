import React, { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { Button, Card, H2, Input, P, Pill, Row, Screen } from '@/components/ui';
import { SafetyNative, type Identity } from '@/modules/safety-native';
import { useStore, useUserId } from '@/lib/store';
import { createGroup, leaveGroup, rpc, updateGroup } from '@/lib/db';
import { refreshAll } from '@/lib/native';
import { colors } from '@/lib/theme';

export default function Friends() {
  const router = useRouter();
  const userId = useUserId();
  const groups = useStore((s) => s.groups);
  const members = useStore((s) => s.members);
  const profiles = useStore((s) => s.profiles);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => { SafetyNative.getIdentity().then(setIdentity).catch(() => {}); }, []);

  const create = async () => {
    if (!userId || !name.trim()) return;
    await createGroup({ name: name.trim(), owner_id: userId });
    setName('');
    await refreshAll();
  };
  const setK = (groupId: string, k: number) => updateGroup(groupId, { threshold_k: k }).then(refreshAll);
  const setCampus = (groupId: string, n: string) => updateGroup(groupId, { campus_safety_number: n || null }).then(refreshAll);
  const accept = (groupId: string) => rpc.acceptInvite(groupId).then(refreshAll).catch((e) => Alert.alert('Failed', e.message));
  const leave = (groupId: string) => userId && leaveGroup(groupId, userId).then(refreshAll);

  const qrPayload = identity ? JSON.stringify({ v: 1, userId: identity.userId, fp: identity.fingerprint, x: identity.x25519Pub, e: identity.ed25519Pub }) : '';

  return (
    <Screen>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>Your code</H2>
          <Button title={showQr ? 'Hide' : 'Show QR'} kind="ghost" onPress={() => setShowQr(!showQr)} />
        </Row>
        <P muted>Friends are added in person by scanning, so nobody can swap in a fake key.</P>
        {showQr && identity && (
          <View style={{ alignItems: 'center', gap: 8, padding: 12, backgroundColor: 'white', borderRadius: 12 }}>
            <QRCode value={qrPayload} size={200} />
            <P style={{ color: '#111', fontFamily: 'monospace', fontSize: 12 }}>{identity.fingerprint}</P>
          </View>
        )}
      </Card>

      {groups.map((g) => {
        const ms = members.filter((m) => m.group_id === g.id);
        const me = ms.find((m) => m.user_id === userId);
        const n = ms.filter((m) => m.status === 'active').length - 1;
        return (
          <Card key={g.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <H2>{g.name}</H2>
              {me?.status === 'invited' ? <Button title="Accept invite" kind="ok" onPress={() => accept(g.id)} /> : <Button title="Leave" kind="ghost" onPress={() => leave(g.id)} />}
            </Row>
            {ms.map((m) => (
              <Row key={m.user_id} style={{ justifyContent: 'space-between' }}>
                <P>{profiles[m.user_id]?.display_name ?? m.user_id.slice(0, 8)}{m.user_id === userId ? ' (you)' : ''}</P>
                <Pill text={m.status} color={m.status === 'active' ? colors.ok : colors.warn} />
              </Row>
            ))}
            <Button title="Scan a friend's QR to add" onPress={() => router.push({ pathname: '/scan', params: { groupId: g.id } })} />
            <P muted>Fallback unlock needs {g.threshold_k} of {Math.max(n, 0)} friends{n < 2 ? ' — disabled until you have 2+ friends' : ''}</P>
            <Row>
              {[2, 3, 4].map((k) => (
                <Button key={k} title={`k=${k}`} kind={g.threshold_k === k ? 'primary' : 'ghost'} onPress={() => setK(g.id, k)} style={{ flex: 1 }} />
              ))}
            </Row>
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
