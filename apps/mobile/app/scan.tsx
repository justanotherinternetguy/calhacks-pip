import React, { useState } from 'react';
import { Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, H2, P, Screen } from '@/components/ui';
import { inviteMember } from '@/lib/db';
import { refreshAll } from '@/lib/native';
import { useUserId } from '@/lib/store';

export default function Scan() {
  const router = useRouter();
  const userId = useUserId();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const [perm, requestPerm] = useCameraPermissions();
  const [busy, setBusy] = useState(false);

  const onScan = async (raw: string) => {
    if (busy || !userId || !groupId) return;
    setBusy(true);
    try {
      const q = JSON.parse(raw) as { v: number; userId: string; fp: string; x: string; e: string };
      if (q.v !== 1 || !q.userId) throw new Error('Not a Safe code');
      Alert.alert('Add friend?', `Fingerprint ${q.fp}\nCheck it matches their screen.`, [
        { text: 'Cancel', style: 'cancel', onPress: () => setBusy(false) },
        {
          text: 'Add',
          onPress: async () => {
            // Their device row (with x25519/ed25519 pubs) is written by their own phone on sign-in; the scanned
            // fingerprint is what the user verifies against it, so the server can't swap keys.
            await inviteMember(groupId, q.userId, userId);
            await refreshAll();
            router.back();
          },
        },
      ]);
    } catch (e: any) { Alert.alert('Scan failed', e.message); setBusy(false); }
  };

  if (!perm?.granted) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <H2>Camera needed</H2>
        <P muted>Only used to read your friend's QR code.</P>
        <Button title="Allow camera" onPress={() => requestPerm()} />
      </Screen>
    );
  }
  return (
    <Screen scroll={false} style={{ padding: 0 }}>
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(r) => onScan(r.data)} />
      <P muted style={{ padding: 16, textAlign: 'center' }}>Point at your friend's QR code</P>
    </Screen>
  );
}
