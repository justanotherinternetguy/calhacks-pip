import React, { useEffect, useRef } from 'react';
import { ActivityIndicator } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { P, Screen } from '@/components/ui';
import { SafetyNative } from '@/modules/safety-native';
import { DEBUG_ENABLED } from '@/lib/debug';
import { colors } from '@/lib/theme';

/**
 * safe://debug/inject?trace=<name> — replays a named trace through SafetyNative.injectTrace and lands on
 * the home tab. `trace=friend-view` opens the local friend view instead. Redirects home in release builds.
 */
export default function DebugInject() {
  const router = useRouter();
  const { trace } = useLocalSearchParams<{ trace?: string }>();
  const fired = useRef(false);

  useEffect(() => {
    if (!DEBUG_ENABLED || fired.current) return;
    fired.current = true;
    const name = (Array.isArray(trace) ? trace[0] : trace) || 'check';
    if (name === 'friend-view') { router.replace('/debug/friend-view'); return; }
    // Native resolves only when the replay ends; do not await it.
    SafetyNative.injectTrace(JSON.stringify({ scenario: name, trace: name, speed: 10 })).catch((e) => console.warn('injectTrace', e));
    router.replace('/home');
  }, [trace, router]);

  if (!DEBUG_ENABLED) return <Redirect href="/home" />;
  return (
    <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator color={colors.accent} />
      <P muted>Injecting trace {String(trace ?? 'check')}…</P>
    </Screen>
  );
}
