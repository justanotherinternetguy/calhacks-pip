import React, { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@/components/ui';
import { SafetyNative } from '@/modules/safety-native';
import { getDevicesForUsers, getIncident, getUnlockRequest, insertUnlockApproval, rpc } from '@/lib/db';
import { useStore, useUserId } from '@/lib/store';
import type { Incident, UnlockRequest } from '@/lib/types';

export default function UnlockApprove() {
  const router = useRouter();
  const me = useUserId();
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const profiles = useStore((s) => s.profiles);
  const [req, setReq] = useState<UnlockRequest | null>(null);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!requestId) return;
    getUnlockRequest(requestId).then(async (r) => { setReq(r); setIncident(await getIncident(r.incident_id)); }).catch((e) => Alert.alert('Not found', e.message));
  }, [requestId]);

  const approve = async () => {
    if (!req || !incident || !me) return;
    setBusy(true);
    try {
      const [dev] = await getDevicesForUsers([req.requester_id]);
      if (!dev?.x25519_pub) throw new Error("Requester's device key not found");
      const { sealedShareB64 } = await SafetyNative.approveUnlock({ requestId: req.id, subjectUserId: incident.user_id, epochId: req.epoch_id, requesterX25519Pub: dev.x25519_pub });
      const id = await SafetyNative.getIdentity();
      await insertUnlockApproval({ request_id: req.id, approver_id: me, sealed_share: sealedShareB64, approver_ed25519_pub: id.ed25519Pub });
      await rpc.addIncidentEvent({ incident_id: incident.id, kind: 'unlock_approved' }).catch(() => {});
      router.back();
    } catch (e: any) { Alert.alert('Approval failed', e.message); } finally { setBusy(false); }
  };

  const who = req ? profiles[req.requester_id]?.display_name ?? 'A friend' : '';
  const subject = incident ? profiles[incident.user_id]?.display_name ?? 'your friend' : '';
  return (
    <Screen style={{ justifyContent: 'center' }}>
      <H1>Unlock {subject}'s location?</H1>
      <Card>
        <P><P style={{ fontWeight: '700' }}>{who}</P> is asking to see where {subject} is.</P>
        <P muted style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 }}>What triggered this{incident?.level ? ` · ${incident.level.replace('_', ' ')}` : ''}</P>
        <P style={{ fontWeight: '600' }}>{incident?.summary ?? '…'}</P>
        <P muted>{subject}'s phone is offline, so the location can only be rebuilt when enough friends agree. This is the only detail of their signals you will see.</P>
        <P muted>Your phone will hand over its piece of the key, sealed to {who} only. This is logged and shown to {subject} and the group.</P>
      </Card>
      <Button title="Approve" kind="danger" onPress={approve} loading={busy} disabled={!req || !incident} />
      <Button title="Not now" kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
