import React, { useCallback } from 'react';
import { View } from 'react-native';
import { format } from 'date-fns';
import { Button, Card, H1, P, Screen } from '@/components/ui';
import { ConfirmItsYou, useBiometricConfirm } from '@/components/ConfirmItsYou';
import { SafetyNative } from '@/modules/safety-native';
import { useStore } from '@/lib/store';
import { goHome } from '@/lib/debug';
import { colors } from '@/lib/theme';

/** Shown the moment the snatch detector fires. Only the owner's biometric can dismiss it. */
export default function Snatch() {
  const snatch = useStore((s) => s.snatch);
  const action = useCallback(() => SafetyNative.cancelSos(), []);
  const onDone = useCallback((ok: boolean) => {
    if (!ok) return;
    useStore.getState().set({ snatch: null });
    goHome();
  }, []);
  const confirm = useBiometricConfirm(action, onDone);

  return (
    <Screen style={{ justifyContent: 'center' }}>
      <H1>Phone may have been snatched</H1>
      <P muted>
        {snatch?.summary ?? 'pip noticed a sudden grab, then running.'}
        {snatch ? ` · ${format(snatch.atMs, 'HH:mm:ss')}` : ''}
      </P>
      <Card tint={colors.danger}>
        <P style={{ fontWeight: '800', fontSize: 20 }}>Don't chase</P>
        <P>Your friends have your location from the moment it happened, and pip is telling them you may not have your phone. Stay somewhere safe and lit.</P>
        {snatch?.lat != null && snatch?.lng != null && (
          <P muted>Snatch-moment location {snatch.lat.toFixed(5)}, {snatch.lng.toFixed(5)}</P>
        )}
      </Card>
      <ConfirmItsYou state={confirm.state} what="stand this alert down" />
      <View style={{ height: 8 }} />
      {confirm.state !== 'ok' && (
        <Button title="I have my phone" kind="ok" onPress={() => void confirm.run()} loading={confirm.state === 'pending'} />
      )}
      <P muted style={{ textAlign: 'center', fontSize: 13 }}>Dismissing this takes your face or fingerprint, so whoever took the phone can't stop the alert.</P>
    </Screen>
  );
}
