import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@/components/ui';
import { Brand, CheckMark, StepNumber, T } from '@/components/pip/kit';
import { ht, ui } from '@/lib/theme';

const STEPS: { fill: string; title: string; text: string }[] = [
  { fill: ht.sky, title: 'It starts on its own', text: 'Night mode turns on when you leave home in the evening. You don’t have to remember to start it.' },
  { fill: ht.butter, title: 'It asks you first', text: 'If your walking gets unsteady, you fall and stay still, or there’s a commotion, your phone asks “you okay?”' },
  { fill: ht.lilac, title: 'Then your friends', text: 'If you don’t answer, your friends get a heads-up. If you still don’t answer, pip shares your location with them.' },
  { fill: ht.coral, title: 'Friends decide', text: 'They call you, come find you, or ring campus safety. pip doesn’t call anyone on its own.' },
];

export default function Welcome() {
  const router = useRouter();
  return (
    <Screen style={{ justifyContent: 'center', maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      <Brand size={30} />
      <H1>How pip works</H1>
      <View style={{ gap: 10 }}>
        {STEPS.map((s, i) => (
          <Card key={s.title} style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
            <StepNumber n={i + 1} fill={s.fill} />
            <View style={{ flex: 1, gap: 2 }}>
              <T style={{ fontSize: 17, lineHeight: 22, fontWeight: '600' }}>{s.title}</T>
              <T style={{ fontSize: 14.5, lineHeight: 20, color: ui.text2 }}>{s.text}</T>
            </View>
          </Card>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 2 }}>
        <CheckMark />
        <P muted style={{ flex: 1, fontSize: 14.5, lineHeight: 20 }}>Your phone encrypts your location. We can’t read it, and no single friend can open it alone.</P>
      </View>
      <Button title="Set up (3 minutes)" onPress={() => router.push('/onboarding/permissions')} />
    </Screen>
  );
}
