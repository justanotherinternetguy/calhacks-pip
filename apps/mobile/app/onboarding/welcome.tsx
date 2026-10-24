import React from 'react';
import { useRouter } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@/components/ui';

export default function Welcome() {
  const router = useRouter();
  return (
    <Screen style={{ justifyContent: 'center' }}>
      <H1>How Safe works</H1>
      <Card>
        <P>1. It runs quietly on nights you're out, with nothing to set up.</P>
        <P>2. If your walking gets unsteady, you fall and stay still, or there's a commotion, it asks "you okay?"</P>
        <P>3. If you can't answer, your friends get a heads-up. Your location is only unlocked for them when things look serious.</P>
        <P>4. Friends decide what to do. The app never calls police by itself.</P>
      </Card>
      <P muted>Location is encrypted on your phone. No single friend (and not us) can see it alone.</P>
      <Button title="Set up (3 minutes)" onPress={() => router.push('/onboarding/permissions')} />
    </Screen>
  );
}
