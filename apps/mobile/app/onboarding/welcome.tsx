import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@/components/ui';
import { Brand, CheckMark, StepNumber, T } from '@/components/pip/kit';
import { ht, ui } from '@/lib/theme';

const STEPS: { fill: string; title: string; text: string }[] = [
  { fill: ht.sky, title: 'Friends check on each other', text: 'Tap “Ask” and your friend’s phone asks “you okay?”. It stays on their screen until they answer.' },
  { fill: ht.butter, title: 'No answer? The group knows', text: 'If they don’t answer in 10 minutes, everyone in your group gets an alert, so nobody gets left behind.' },
  { fill: ht.lilac, title: 'Your phone can ask too', text: 'With night mode on, a fall or a commotion makes your phone ask “you okay?” before it tells your friends.' },
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
        <P muted style={{ flex: 1, fontSize: 14.5, lineHeight: 20 }}>Your phone encrypts your location for your friends only. We can’t read it. You add friends in person, so nobody can sneak into your group.</P>
      </View>
      <Button title="Set up (3 minutes)" onPress={() => router.push('/onboarding/permissions')} />
    </Screen>
  );
}
