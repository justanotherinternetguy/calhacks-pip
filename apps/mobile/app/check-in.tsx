import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, H1, P, Screen } from '@/components/ui';
import { CheckInInput, SafetyNative, type CheckInResult } from '@/modules/safety-native';
import { useStore } from '@/lib/store';
import { colors } from '@/lib/theme';

export default function CheckIn() {
  const router = useRouter();
  const params = useLocalSearchParams<{ phrase?: string; deadline?: string }>();
  const pending = useStore((s) => s.pendingCheck);
  const phrase = params.phrase ?? pending?.phrase ?? '';
  const [fallbackDeadline] = useState(() => Date.now() + 90_000);
  const deadline = Number(params.deadline ?? pending?.deadlineMs ?? fallbackDeadline);
  const [left, setLeft] = useState(() => Math.max(0, Math.round((deadline - Date.now()) / 1000)));
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [deadline]);

  const finish = () => { useStore.getState().set({ pendingCheck: null }); router.replace('/home'); };
  const submit = async (r: CheckInResult) => {
    const v = await SafetyNative.submitCheckIn(r);
    if (v.accepted) { setResult("Glad you're okay."); setTimeout(finish, 900); }
    else setResult(`Hmm — ${v.reason}. Try once more, or tap "I need help".`);
  };
  const help = async () => { await SafetyNative.needHelp(); finish(); };

  return (
    <Screen style={{ justifyContent: 'center' }}>
      <H1>You okay?</H1>
      <P muted>Type the three words below. If you don't, your friends get a heads-up in {left}s.</P>
      <View style={{ alignItems: 'center', paddingVertical: 20 }}>
        <P style={{ fontSize: 34, fontWeight: '800', color: colors.accent, textAlign: 'center' }}>{phrase}</P>
      </View>
      <CheckInInput phrase={phrase} onComplete={submit} />
      {result && <P>{result}</P>}
      <View style={{ height: 12 }} />
      <Button title="I need help" kind="danger" onPress={help} />
      <P muted style={{ textAlign: 'center', fontSize: 13 }}>Tapping "I need help" alerts your friends and shares your location with them.</P>
    </Screen>
  );
}
