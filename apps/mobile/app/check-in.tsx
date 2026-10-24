import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, H1, P, Screen } from '@/components/ui';
import { CheckInInput, SafetyNative, type CheckInResult } from '@/modules/safety-native';
import { useStore } from '@/lib/store';
import { colors } from '@/lib/theme';

const GLAD_MS = 2500;

/**
 * On the phone the check-in is the native CheckInActivity (fingerprint / PIN first, then the phrase): this route only
 * opens it and steps back. The JS screen below is the fallback where no native screen exists (web, mock).
 */
export default function CheckIn() {
  const router = useRouter();
  const [native, setNative] = useState<boolean | null>(null);
  useEffect(() => {
    SafetyNative.openCheckIn()
      .then(() => { setNative(true); if (router.canGoBack()) router.back(); else router.replace('/home'); })
      .catch(() => setNative(false));
  }, [router]);
  if (native !== false) return <Screen style={{ justifyContent: 'center' }}><P muted style={{ textAlign: 'center' }}>Opening check-in…</P></Screen>;
  return <JsCheckIn />;
}

function JsCheckIn() {
  const router = useRouter();
  const params = useLocalSearchParams<{ phrase?: string; deadline?: string }>();
  const pending = useStore((s) => s.pendingCheck);
  const phrase = params.phrase ?? pending?.phrase ?? '';
  const [fallbackDeadline] = useState(() => Date.now() + 90_000);
  const deadline = Number(params.deadline ?? pending?.deadlineMs ?? fallbackDeadline);
  const [left, setLeft] = useState(() => Math.max(0, Math.round((deadline - Date.now()) / 1000)));
  const [result, setResult] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  // Live copy of what was typed so the explicit "Done" button can submit without the return key.
  const typed = useRef('');
  const keyTimes = useRef<number[]>([]);
  const typingStart = useRef<number | null>(null);
  const hadPending = useRef(!!pending);

  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000))), 1000);
    return () => clearInterval(t);
  }, [deadline]);

  const finish = () => { useStore.getState().set({ pendingCheck: null }); router.replace('/home'); };

  // Native escalated (heads-up / unlocked / snatch) or resolved while this was open → the check is over. Leave once:
  // a heads-up can arrive while submit() is still settling, and re-running replace() on every re-render loops.
  const exited = useRef(false);
  useEffect(() => {
    if (pending) hadPending.current = true;
    else if (hadPending.current && !accepted && !exited.current) {
      exited.current = true;
      router.replace('/home');
    }
  }, [pending, accepted, router]);

  const submit = async (r: CheckInResult) => {
    if (busy || accepted) return;
    setBusy(true);
    try {
      const v = await SafetyNative.submitCheckIn(r);
      if (v.accepted) { setAccepted(true); setTimeout(finish, GLAD_MS); }
      else setResult(`Hmm — ${v.reason}. Try once more, or tap "I need help".`);
    } finally { setBusy(false); }
  };
  const onChange = (t: string) => {
    const now = Date.now();
    typingStart.current ??= now;
    keyTimes.current.push(now - typingStart.current);
    typed.current = t;
  };
  const done = () => {
    const start = typingStart.current ?? Date.now();
    void submit({ phrase, typed: typed.current, keyTimesMs: keyTimes.current, backspaces: 0, durationMs: Date.now() - start });
  };
  const help = async () => { await SafetyNative.needHelp(); finish(); };

  if (accepted) {
    return (
      <Screen style={{ justifyContent: 'center', alignItems: 'center' }}>
        <H1>Glad you're okay</H1>
        <P muted style={{ textAlign: 'center' }}>Thanks for letting us know.</P>
      </Screen>
    );
  }

  return (
    <Screen style={{ justifyContent: 'center' }}>
      <H1>You okay?</H1>
      <P style={{ fontWeight: '700' }}>Type the 3 words</P>
      <P muted>If you don't, your friends get a heads-up in {left}s.</P>
      <View style={{ alignItems: 'center', paddingVertical: 20 }}>
        <P testID="checkin-phrase" style={{ fontSize: 34, fontWeight: '800', color: colors.accent, textAlign: 'center' }}>{phrase}</P>
      </View>
      <View testID="checkin-input" accessible={false}>
        <CheckInInput phrase={phrase} onChange={onChange} onComplete={submit} />
      </View>
      <Button title="Done" onPress={done} loading={busy} />
      {result && <P>{result}</P>}
      <View style={{ height: 12 }} />
      <Button title="I need help" kind="danger" onPress={help} />
      <P muted style={{ textAlign: 'center', fontSize: 13 }}>Tapping "I need help" alerts your friends and shares your location with them.</P>
    </Screen>
  );
}
