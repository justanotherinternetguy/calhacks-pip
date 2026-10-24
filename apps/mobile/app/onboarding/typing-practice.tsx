import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@/components/ui';
import { CheckInInput, SafetyNative, type CheckInResult } from '@/modules/safety-native';
import { writeOnboarded } from '../_layout';
import { colors } from '@/lib/theme';

const WORDS = ['blue', 'river', 'stone', 'lamp', 'tiger', 'maple', 'cloud', 'seven', 'piano', 'green', 'coral', 'north'];
export const randomPhrase = () => Array.from({ length: 3 }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(' ');

export default function TypingPractice() {
  const router = useRouter();
  const [round, setRound] = useState(0);
  const [phrase, setPhrase] = useState(randomPhrase);
  const [last, setLast] = useState<string | null>(null);

  const done = async (r: CheckInResult) => {
    await SafetyNative.recordTypingPractice(r);
    setLast(r.typed.trim() === phrase ? 'Nice.' : 'Typo, that still counts as practice.');
    if (round + 1 >= 3) { await writeOnboarded(); router.replace('/home'); return; }
    setRound(round + 1);
    setPhrase(randomPhrase());
  };

  return (
    <Screen style={{ justifyContent: 'center' }}>
      <H1>Typing practice</H1>
      <P muted>When Safe asks "you okay?", you answer by typing three words. How you type (not what) tells it whether you're yourself. Three quick rounds.</P>
      <Card>
        <P muted>Round {round + 1} of 3 — type this:</P>
        <P style={{ fontSize: 28, fontWeight: '800', color: colors.accent }}>{phrase}</P>
        <CheckInInput key={round} phrase={phrase} onComplete={done} />
        {last && <P muted>{last}</P>}
      </Card>
      <Button title="Skip" kind="ghost" onPress={async () => { await writeOnboarded(); router.replace('/home'); }} />
    </Screen>
  );
}
