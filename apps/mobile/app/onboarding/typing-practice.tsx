import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@/components/ui';
import { D, Dot } from '@/components/pip/kit';
import { CheckInInput, SafetyNative, type CheckInResult } from '@/modules/safety-native';
import { writeOnboarded } from '../_layout';

const WORDS = ['blue', 'river', 'stone', 'lamp', 'tiger', 'maple', 'cloud', 'seven', 'piano', 'green', 'coral', 'north'];
export const randomPhrase = () => Array.from({ length: 3 }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(' ');

export default function TypingPractice() {
  const router = useRouter();
  const [round, setRound] = useState(0);
  const [phrase, setPhrase] = useState(randomPhrase);
  const [last, setLast] = useState<string | null>(null);

  const done = async (r: CheckInResult) => {
    await SafetyNative.recordTypingPractice(r);
    setLast(r.typed.trim() === phrase ? 'Nice.' : 'Typo. It still counts.');
    if (round + 1 >= 3) { await writeOnboarded(); router.replace('/home'); return; }
    setRound(round + 1);
    setPhrase(randomPhrase());
  };

  return (
    <Screen style={{ justifyContent: 'center', maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      <H1>Typing practice</H1>
      <P muted>To answer pip’s “you okay?”, you type three words. pip learns your typing rhythm in these three rounds and checks it later to tell it’s you.</P>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {[0, 1, 2].map((i) => <Dot key={i} tone={i < round ? 'out' : 'home'} size={12} />)}
          <P muted style={{ fontSize: 14 }}>Round {round + 1} of 3 · type this:</P>
        </View>
        <D style={{ fontSize: 30, lineHeight: 36 }}>{phrase}</D>
        <CheckInInput key={round} phrase={phrase} onComplete={done} />
        {last && <P muted>{last}</P>}
      </Card>
      <Button title="Skip" kind="ghost" onPress={async () => { await writeOnboarded(); router.replace('/home'); }} />
    </Screen>
  );
}
