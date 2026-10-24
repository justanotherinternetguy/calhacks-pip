import React, { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@/components/ui';
import { SafetyNative } from '@/modules/safety-native';
import { colors } from '@/lib/theme';

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
    <Screen style={{ justifyContent: 'center' }}>
      <H1>Baseline walk</H1>
      <P muted>Put the phone in your pocket and walk normally for a minute or two. Safe learns your usual rhythm so it can notice when it changes. It keeps learning on normal days too.</P>
      <Card style={{ alignItems: 'center', paddingVertical: 32 }}>
        <P style={{ fontSize: 56, fontWeight: '800', color: running ? colors.ok : colors.text }}>{seconds}s</P>
        <P muted>{total ? `${total}s collected` : 'nothing collected yet'}</P>
      </Card>
      <Button title={running ? 'Stop' : 'Start walking'} kind={running ? 'danger' : 'primary'} onPress={toggle} />
      <Button title={total >= 60 ? 'Continue' : 'Skip (uses population baseline)'} kind="ghost" onPress={() => router.push('/onboarding/typing-practice')} disabled={running} />
    </Screen>
  );
}
