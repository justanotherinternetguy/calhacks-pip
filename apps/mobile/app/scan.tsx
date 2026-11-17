import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, Card, H2, P, Screen } from '@/components/ui';
import { Icon, Mono } from '@/components/pip/kit';
import { SafetyNative, type Identity } from '@/modules/safety-native';
import { getDevicesForUsers, redeemInvite } from '@/lib/db';
import { refreshAll } from '@/lib/native';
import { parseQr, type InviteQr, type ParsedQr, type PersonQr } from '@/lib/qr';
import { useStore, useUserId } from '@/lib/store';
import { colors, ht, ui } from '@/lib/theme';

type Step =
  | { s: 'scan' }
  | { s: 'error'; title: string; msg: string }
  | { s: 'join'; q: InviteQr }
  | { s: 'joined'; q: InviteQr }
  | { s: 'verified'; q: PersonQr; name: string }
  | { s: 'busy' };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Scans a pip code.
 *   Invite code → check the fingerprint against the keys in the code (recomputed here), ask to join, pin the
 *   inviter's keys as verified, redeem the one-time token, then show MY fingerprint for the inviter to compare.
 *   Personal code → compare with the keys the server has for that friend and mark them verified.
 */
export default function Scan() {
  const router = useRouter();
  const userId = useUserId();
  const [perm, requestPerm] = useCameraPermissions();
  const [step, setStep] = useState<Step>({ s: 'scan' });
  const [me, setMe] = useState<Identity | null>(null);
  useEffect(() => { SafetyNative.getIdentity().then(setMe).catch(() => {}); }, [userId]);

  const fail = (title: string, e: unknown) => setStep({ s: 'error', title, msg: errText(e) });

  const onScan = async (raw: string) => {
    if (step.s !== 'scan' || !userId) return;
    setStep({ s: 'busy' });
    let q: ParsedQr;
    try { q = parseQr(raw); } catch (e) { fail('Scan failed', e); return; }
    if (q.userId === userId) { fail('That is your own code', new Error('Scan your friend’s screen.')); return; }
    try {
      // The code carries its keys and a fingerprint; recompute it here. A mismatch means the code was altered.
      const fp = await SafetyNative.fingerprint(q.userId, q.x, q.e);
      if (fp !== q.fp) throw new Error('The fingerprint in this code does not match its keys. Do not use it; ask for a new code.');
    } catch (e) { fail('Code rejected', e); return; }
    if (q.kind === 'invite') { setStep({ s: 'join', q }); return; }
    try { await verifyPerson(q); } catch (e) { fail('Could not verify', e); }
  };

  const verifyPerson = async (q: PersonQr) => {
    const [d] = await getDevicesForUsers([q.userId]);
    if (!d) throw new Error('You are not in a group with this person yet. To add them, open a group and show them an invite code.');
    if (d.x25519_pub !== q.x || d.ed25519_pub !== q.e) {
      throw new Error('The server has a different key for this person than their phone shows. Do not trust it: ask them to reopen the app, then scan again.');
    }
    const r = await SafetyNative.pinKeys({ userId: q.userId, x25519Pub: q.x, ed25519Pub: q.e, verified: true, replace: true });
    if (r.status === 'invalid') throw new Error('This code does not hold real keys (a demo device?).');
    await refreshAll();
    const name = useStore.getState().profiles[q.userId]?.display_name || 'Your friend';
    setStep({ s: 'verified', q, name });
  };

  const join = async (q: InviteQr) => {
    setStep({ s: 'busy' });
    try {
      const pin = await SafetyNative.pinKeys({ userId: q.userId, x25519Pub: q.x, ed25519Pub: q.e, verified: true });
      if (pin.status === 'changed') throw new Error(`You already verified a different key for ${q.name}. Ask them to verify with you again first.`);
      await redeemInvite(q.token);
      await refreshAll();
      setStep({ s: 'joined', q });
    } catch (e) { fail('Could not join', e); }
  };

  if (step.s === 'join') {
    const q = step.q;
    return (
      <Screen style={{ justifyContent: 'center', maxWidth: 640, width: '100%', alignSelf: 'center' }}>
        <Card>
          <H2>Join {q.groupName}?</H2>
          <P>{q.name} invited you. Check that their screen shows this fingerprint:</P>
          <Mono style={{ fontSize: 16, color: ui.text, textAlign: 'center' }}>{q.fp}</Mono>
          <P muted>Your group can ask if you’re okay, and sees your location only while you share it with them.</P>
          <Button title="It matches, join" kind="ok" icon={Icon.check(ui.text, 16)} onPress={() => void join(q)} testID="join-confirm" />
          <Button title="Cancel" kind="ghost" onPress={() => setStep({ s: 'scan' })} />
        </Card>
      </Screen>
    );
  }
  if (step.s === 'joined') {
    return (
      <Screen style={{ justifyContent: 'center', maxWidth: 640, width: '100%', alignSelf: 'center' }}>
        <Card>
          <H2>You’re in {step.q.groupName}</H2>
          <P>Now show {step.q.name} your fingerprint so they can check it on their phone:</P>
          <View style={{ alignItems: 'center', padding: 16, backgroundColor: ht.paper, borderRadius: 18, borderWidth: 2, borderColor: ht.ink }}>
            <Mono style={{ fontSize: 18, color: ui.text }}>{me?.fingerprint ?? '…'}</Mono>
          </View>
          <Button title="Done" onPress={() => router.replace('/groups')} />
        </Card>
      </Screen>
    );
  }
  if (step.s === 'verified') {
    return (
      <Screen style={{ justifyContent: 'center', maxWidth: 640, width: '100%', alignSelf: 'center' }}>
        <Card>
          <H2>{step.name} is verified</H2>
          <P>pip now uses only this key for {step.name}. If it ever changes, you’ll be asked to check again in person.</P>
          <Button title="Done" onPress={() => router.back()} />
        </Card>
      </Screen>
    );
  }
  if (step.s === 'error') {
    return (
      <Screen style={{ justifyContent: 'center', maxWidth: 640, width: '100%', alignSelf: 'center' }}>
        <Card>
          <H2 style={{ color: colors.danger }}>{step.title}</H2>
          <P>{step.msg}</P>
          <Button title="Scan again" onPress={() => setStep({ s: 'scan' })} />
          <Button title="Close" kind="ghost" onPress={() => router.back()} />
        </Card>
      </Screen>
    );
  }

  if (!perm?.granted) {
    return (
      <Screen style={{ justifyContent: 'center' }}>
        <H2>Camera needed</H2>
        <P muted>pip only uses it to read your friend’s code.</P>
        <Button title="Allow camera" onPress={() => requestPerm()} />
      </Screen>
    );
  }
  return (
    <Screen scroll={false} style={{ padding: 0 }}>
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={step.s === 'scan' ? (r) => void onScan(r.data) : undefined} />
      <P muted style={{ padding: 16, textAlign: 'center' }}>{step.s === 'busy' ? 'Checking…' : 'Point at your friend’s invite code or their “My code”'}</P>
    </Screen>
  );
}
