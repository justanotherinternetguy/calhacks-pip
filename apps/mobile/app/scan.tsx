import React, { useState } from 'react';
import { Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, H2, P, Screen } from '@/components/ui';
import { inviteMember } from '@/lib/db';
import { refreshAll } from '@/lib/native';
import { useUserId } from '@/lib/store';

type QrPayload = { v: 1; userId: string; fp: string; x: string; e: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The friends-tab QR (`{ v: 1, userId, fp, x, e }`). Throws a readable error for anything else, before any network call. */
function parseQr(raw: string): QrPayload {
  let q: Partial<QrPayload>;
  try { q = JSON.parse(raw) as Partial<QrPayload>; } catch { throw new Error('Not a pip code'); }
  if (!q || q.v !== 1) throw new Error('Not a pip code');
  if (typeof q.userId !== 'string' || !UUID_RE.test(q.userId)) {
    throw new Error('This code has no valid account id. On the other device, sign in, reopen Friends → Show QR, and scan again.');
  }
  if (typeof q.fp !== 'string' || typeof q.x !== 'string' || typeof q.e !== 'string') throw new Error('This pip code is incomplete');
  return q as QrPayload;
}

export default function Scan() {
  const router = useRouter();
  const userId = useUserId();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const [perm, requestPerm] = useCameraPermissions();
  const [busy, setBusy] = useState(false);

  const onScan = (raw: string) => {
    if (busy || !userId || !groupId) return;
    setBusy(true);
    const fail = (title: string, e: unknown) => {
      Alert.alert(title, e instanceof Error ? e.message : String(e), [{ text: 'OK', onPress: () => setBusy(false) }], { onDismiss: () => setBusy(false) });
    };
    let q: QrPayload;
    try { q = parseQr(raw); } catch (e) { fail('Scan failed', e); return; }
    if (q.userId === userId) { fail('Scan failed', new Error('That is your own code. Scan your friend\'s screen.')); return; }
    Alert.alert('Add friend?', `Fingerprint ${q.fp}\nCheck it matches their screen.`, [
      { text: 'Cancel', style: 'cancel', onPress: () => setBusy(false) },
      {
        text: 'Add',
        onPress: () => {
          // Their device row (with x25519/ed25519 pubs) is written by their own device on sign-in; the scanned
          // fingerprint is what the user verifies against it, so the server can't swap keys.
          void (async () => {
            try {
              await inviteMember(groupId, q.userId, userId);
              await refreshAll();
              router.back();
            } catch (e) { fail('Could not add friend', e); }
          })();
        },
      },
    ], { onDismiss: () => setBusy(false) });
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
      <P muted style={{ padding: 16, textAlign: 'center' }}>Point at your friend’s QR code</P>
    </Screen>
  );
}
