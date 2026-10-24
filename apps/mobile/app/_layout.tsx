import React, { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { supabase } from '@/lib/supabase';
import { onAuthSession } from '@/lib/native';
import { hasDemoFlag, makeDemoSession } from '@/lib/demo';
import { initNotifications } from '@/lib/notifications';
import { useStore } from '@/lib/store';
import { colors } from '@/lib/theme';

export const ONBOARDED_KEY = 'safe.onboarded';
export async function readOnboarded() {
  if (Platform.OS === 'web') return globalThis.localStorage?.getItem(ONBOARDED_KEY) === '1';
  return (await SecureStore.getItemAsync(ONBOARDED_KEY)) === '1';
}
export async function writeOnboarded() {
  if (Platform.OS === 'web') globalThis.localStorage?.setItem(ONBOARDED_KEY, '1');
  else await SecureStore.setItemAsync(ONBOARDED_KEY, '1');
  useStore.getState().set({ onboarded: true });
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const session = useStore((s) => s.session);
  const onboarded = useStore((s) => s.onboarded);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    const off = initNotifications();
    readOnboarded().then((o) => useStore.getState().set({ onboarded: o }));
    supabase.auth.getSession()
      .then(async ({ data }) => onAuthSession(data.session ?? ((await hasDemoFlag()) ? makeDemoSession() : null)))
      .catch((e) => console.warn('session restore', e))
      .finally(() => setReady(true));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => void onAuthSession(s));
    return () => { sub.subscription.unsubscribe(); off(); };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const top = segments[0] as string | undefined;
    if (!session && top !== '(auth)') router.replace('/sign-in');
    else if (session && !onboarded && top !== 'onboarding') router.replace('/onboarding/welcome');
    else if (session && onboarded && (top === '(auth)' || top === 'onboarding' || top === undefined)) router.replace('/home');
  }, [ready, session, onboarded, segments, router]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="check-in" options={{ presentation: 'fullScreenModal', title: 'You okay?', headerShown: false }} />
        <Stack.Screen name="snatch" options={{ presentation: 'fullScreenModal', title: 'Snatch alert', headerShown: false }} />
        <Stack.Screen name="debug/inject" options={{ headerShown: false }} />
        <Stack.Screen name="debug/friend-view" options={{ title: 'Friend view (demo)' }} />
        <Stack.Screen name="scan" options={{ presentation: 'modal', title: 'Scan friend QR' }} />
        <Stack.Screen name="incident/[id]" options={{ title: 'Incident' }} />
        <Stack.Screen name="unlock-approve/[requestId]" options={{ presentation: 'modal', title: 'Approve location unlock' }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
