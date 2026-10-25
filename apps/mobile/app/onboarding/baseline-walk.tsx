import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@/components/ui';
import { Icon, Mono, T } from '@/components/pip/kit';
import { SafetyNative } from '@/modules/safety-native';
import { ht, ui } from '@/lib/theme';

export default function BaselineWalk() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const toggle = async () => {
    if (!running) { await SafetyNative.startBaselineWalk(); setSeconds(0); setRunning(true); }
    else { const r = await SafetyNative.stopBaselineWalk(); setRunning(false); setTotal((t) => t + r.seconds); }
  };

  return (
    <Screen style={{ justifyContent: 'center', maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      <H1>Baseline walk</H1>
      <P muted>Put the phone in your pocket and walk normally for a minute or two. pip learns your usual rhythm so it can notice when it changes. It keeps learning on normal days too.</P>
      <Card style={{ alignItems: 'center', paddingVertical: 32, backgroundColor: running ? ht.mint : ui.panel }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {Icon.walk(ui.text, 28)}
          <Mono style={{ fontSize: 56, lineHeight: 62, fontWeight: '500' }}>{seconds}s</Mono>
        </View>
        <T style={{ color: running ? ui.text2 : ui.quiet }}>{total ? `${total}s collected` : 'nothing collected yet'}</T>
      </Card>
      <Button title={running ? 'Stop' : 'Start walking'} kind={running ? 'danger' : 'primary'} onPress={toggle} />
      <Button title={total >= 60 ? 'Continue' : 'Skip (uses population baseline)'} kind="ghost" onPress={() => router.push('/onboarding/typing-practice')} disabled={running} />
    </Screen>
  );
}
