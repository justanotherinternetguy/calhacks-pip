import '@/lib/polyfills';
import React, { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import { Platform, View } from 'react-native';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { supabase } from '@/lib/supabase';
import { adoptNativeSession, onAuthSession } from '@/lib/native';
import { hasDemoFlag, makeDemoSession } from '@/lib/demo';
import { initNotifications } from '@/lib/notifications';
import { useStore } from '@/lib/store';
import { FONT_FILES, WEB_FONTS_HREF, colors, fontFor, setNativeFontsLoaded, ui } from '@/lib/theme';
import { useFriendsFeed } from '@/lib/friends';

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

/** Keeps every friend's telemetry (real or simulated) flowing for the map while signed in. */
function FriendsFeed() {
  useFriendsFeed();
  return null;
}

/** Fredoka, Figtree and DM Mono: bundled on the phone, linked from Google Fonts on the web. Resolves true once usable. */
function useTypefaces(): boolean {
  const [loaded, error] = useFonts(Platform.OS === 'web' ? {} : FONT_FILES);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined' || document.getElementById('pip-font')) return;
    const link = document.createElement('link');
    link.id = 'pip-font';
    link.rel = 'stylesheet';
    link.href = WEB_FONTS_HREF;
    document.head.appendChild(link);
    document.body.style.backgroundColor = ui.ground;
    document.body.style.color = ui.text;
  }, []);
  const ok = Platform.OS === 'web' || loaded;
  setNativeFontsLoaded(Platform.OS !== 'web' && loaded && !error);
  return ok || !!error;
}

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const session = useStore((s) => s.session);
  const onboarded = useStore((s) => s.onboarded);
  const segments = useSegments();
  const router = useRouter();
  const fontsReady = useTypefaces();

  useEffect(() => {
    const off = initNotifications();
    readOnboarded().then((o) => useStore.getState().set({ onboarded: o }));
    adoptNativeSession()
      .catch((e) => console.warn('adoptNativeSession', e))
      .then(() => supabase.auth.getSession())
      .then(async ({ data }) => onAuthSession(data.session ?? ((await hasDemoFlag()) ? makeDemoSession() : null)))
      .catch((e) => console.warn('session restore', e?.stack ?? e))
      .finally(() => setReady(true));
    const { data: sub } = supabase.auth.onAuthStateChange((e, s) => {
      // INITIAL_SESSION / TOKEN_REFRESHED can arrive with a null session while storage is still loading;
      // only an explicit SIGNED_OUT (or a real session) should change auth state, otherwise we'd tear
      // down and reconfigure native twice per launch.
      if (!s && e !== 'SIGNED_OUT') return;
      void onAuthSession(s);
    });
    return () => { sub.subscription.unsubscribe(); off(); };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const top = segments[0] as string | undefined;
    if (!session && top !== '(auth)') router.replace('/sign-in');
    else if (session && !onboarded && top !== 'onboarding') router.replace('/onboarding/welcome');
    else if (session && onboarded && (top === '(auth)' || top === 'onboarding' || top === undefined)) router.replace('/home');
  }, [ready, session, onboarded, segments, router]);

  if (!fontsReady) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="dark" />
      {session && <FriendsFeed />}
      <Stack screenOptions={{
        headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false,
        headerTitleStyle: { ...fontFor('600', 'display'), fontSize: 20 }, headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.bg },
      }}>
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        <Stack.Screen name="home" options={{ headerShown: false }} />
        <Stack.Screen name="friends" options={{ headerShown: false }} />
        <Stack.Screen name="friend/[id]" options={{ headerShown: false }} />
        <Stack.Screen name="groups" options={{ title: 'Groups' }} />
        <Stack.Screen name="history" options={{ title: 'History' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        <Stack.Screen name="check-in" options={{ presentation: 'fullScreenModal', title: 'You okay?', headerShown: false }} />
        <Stack.Screen name="snatch" options={{ presentation: 'fullScreenModal', title: 'Snatch alert', headerShown: false }} />
        <Stack.Screen name="debug/inject" options={{ headerShown: false }} />
        <Stack.Screen name="debug/friend-view" options={{ title: 'Friend view (demo)' }} />
        <Stack.Screen name="scan" options={{ presentation: 'modal', title: 'Scan friend QR' }} />
        <Stack.Screen name="incident/[id]" options={{ title: 'Incident', headerShown: false }} />
        <Stack.Screen name="monitor" options={{ headerShown: false }} />
        <Stack.Screen name="collect" options={{ headerShown: false }} />
        <Stack.Screen name="unlock-approve/[requestId]" options={{ presentation: 'modal', title: 'Approve location unlock' }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
