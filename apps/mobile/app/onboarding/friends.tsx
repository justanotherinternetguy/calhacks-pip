import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { Button, Card, H1, Input, P, Screen } from '@/components/ui';
import { Icon } from '@/components/pip/kit';
import { createGroup } from '@/lib/db';
import { refreshAll } from '@/lib/native';
import { DEFAULT_THRESHOLD_K, useStore, useUserId } from '@/lib/store';
import { ht } from '@/lib/theme';

/** Onboarding step 3: friends first. Start a group (then show its invite code) or scan a friend's code to join one. */
export default function OnboardingFriends() {
  const router = useRouter();
  const userId = useUserId();
  const groups = useStore((s) => s.groups);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!userId || !name.trim()) return;
    setError(null);
    try {
      await createGroup({ name: name.trim(), owner_id: userId, threshold_k: DEFAULT_THRESHOLD_K });
      await refreshAll();
      router.push('/groups');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Screen style={{ justifyContent: 'center', maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      <H1>Your people</H1>
      <P muted>pip is for friends who look out for each other. Add them in person: one of you shows an invite code, the other scans it, and you both check the fingerprint on each other’s screen.</P>
      {groups.length > 0 && <Card><P>You’re in {groups.map((g) => g.name).join(', ')}.</P></Card>}
      <Card>
        <P style={{ fontWeight: '600' }}>Start a group</P>
        <Input placeholder="Saturday crew" value={name} onChangeText={setName} />
        <Button title="Create and show invite code" onPress={() => void create()} disabled={!name.trim()} />
      </Card>
      <Button title="Scan a friend’s invite code" kind="ghost" icon={Icon.camera(ht.ink, 18)} onPress={() => router.push('/scan')} />
      {error && <P style={{ color: ht.coralDeep }}>{error}</P>}
      <Button title={groups.length ? 'Continue' : 'Later'} onPress={() => router.push('/onboarding/home-places')} />
    </Screen>
  );
}
