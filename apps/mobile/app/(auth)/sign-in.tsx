import React, { useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Button, Card, H1, Input, P, Row, Screen } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { DEMO_MODE } from '@/lib/env';
import { makeDemoSession, setDemoFlag } from '@/lib/demo';
import { onAuthSession } from '@/lib/native';

WebBrowser.maybeCompleteAuthSession();

export default function SignIn() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try { await f(); } catch (e: any) { Alert.alert('Sign-in failed', e.message ?? String(e)); } finally { setBusy(false); }
  };

  const sendOtp = () => run(async () => {
    const { error } = await supabase.auth.signInWithOtp({ phone: phone.trim() });
    if (error) throw error;
    setSent(true);
  });
  const verify = () => run(async () => {
    const { error } = await supabase.auth.verifyOtp({ phone: phone.trim(), token: code.trim(), type: 'sms' });
    if (error) throw error;
  });
  const oauth = (provider: 'apple' | 'google') => run(async () => {
    const redirectTo = Linking.createURL('/');
    const { data, error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: Platform.OS !== 'web' } });
    if (error) throw error;
    if (Platform.OS === 'web' || !data.url) return;
    const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (res.type !== 'success') return;
    const url = new URL(res.url);
    const params = new URLSearchParams(url.hash.slice(1) || url.search);
    const code = params.get('code');
    if (code) { const { error: e2 } = await supabase.auth.exchangeCodeForSession(code); if (e2) throw e2; return; }
    const access_token = params.get('access_token'); const refresh_token = params.get('refresh_token');
    if (access_token && refresh_token) { const { error: e3 } = await supabase.auth.setSession({ access_token, refresh_token }); if (e3) throw e3; }
  });
  const demo = () => run(async () => {
    if (DEMO_MODE) {
      // No backend configured: use an offline local session (native sensing + mock still work).
      await setDemoFlag(true);
      await onAuthSession(makeDemoSession());
      return;
    }
    // Anonymous sign-in for demos (enable in Supabase Auth settings).
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
  });

  return (
    <Screen style={{ justifyContent: 'center' }}>
      <H1>Safe</H1>
      <P muted>Passive night-out safety. Your friends get told only when you can't tell them yourself.</P>
      <Card>
        {!sent ? (
          <>
            <Input placeholder="+1 555 123 4567" keyboardType="phone-pad" autoComplete="tel" value={phone} onChangeText={setPhone} />
            <Button title="Text me a code" onPress={sendOtp} loading={busy} disabled={phone.length < 8} />
          </>
        ) : (
          <>
            <P>Code sent to {phone}</P>
            <Input placeholder="123456" keyboardType="number-pad" value={code} onChangeText={setCode} autoFocus />
            <Button title="Verify" onPress={verify} loading={busy} disabled={code.length < 6} />
            <Button title="Change number" kind="ghost" onPress={() => setSent(false)} />
          </>
        )}
      </Card>
      <Row style={{ justifyContent: 'center' }}><P muted>or</P></Row>
      {Platform.OS === 'ios' && <Button title=" Sign in with Apple" kind="ghost" onPress={() => oauth('apple')} />}
      <Button title="Sign in with Google" kind="ghost" onPress={() => oauth('google')} />
      <Button title={DEMO_MODE ? 'Demo (offline)' : 'Demo (anonymous)'} kind="ghost" onPress={demo} />
    </Screen>
  );
}
