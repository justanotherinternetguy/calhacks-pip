import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { P, Screen } from '@/components/ui';
import { Btn, Caps, D, Icon, Mono, T } from '@/components/pip/kit';
import { fmtCountdown } from '@/components/telemetry/labels';
import { CheckInInput, SafetyNative, type CheckInResult } from '@/modules/safety-native';
import { useFriends } from '@/lib/friends';
import { useStore } from '@/lib/store';
import { fontFor, ht, ui } from '@/lib/theme';

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
  const insets = useSafeAreaInsets();
  const pending = useStore((s) => s.pendingCheck);
  const myEsc = useStore((s) => s.status?.engine.escalation ?? 'idle');
  const why = useFriends((s) => s.friends.find((f) => f.isMe)?.checkSummary) || null;
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
      else setResult(`Not accepted: ${v.reason}. Try once more, or tap “I need help”.`);
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

  const total = Math.max(1, Math.round((deadline - (fallbackDeadline - 90_000)) / 1000));
  const words = phrase.split(/\s+/).filter(Boolean);
  const told = myEsc === 'heads_up' || myEsc === 'unlocked';

  if (accepted) {
    return (
      <View style={[styles.screen, { backgroundColor: ht.mint, justifyContent: 'center', alignItems: 'center', gap: 8, padding: 24 }]}>
        <View style={styles.badge}>{Icon.check(ht.ink, 36)}</View>
        <D accessibilityRole="header" style={{ fontSize: 30, lineHeight: 34, fontWeight: '700', textAlign: 'center' }}>Glad you’re okay</D>
        <T style={{ fontSize: 16, lineHeight: 22, color: ui.text2, textAlign: 'center' }}>Your friends know you’re fine.</T>
      </View>
    );
  }

  // As on the site: a full lilac screen (coral once friends were told), the question, why, a countdown and the words.
  return (
    <View style={[styles.screen, { backgroundColor: told ? ht.coral : ht.lilac, paddingTop: insets.top + 24, paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Caps color={ui.text2} style={{ letterSpacing: 1, textAlign: 'center' }}>PIP · CHECK-IN</Caps>
        <D accessibilityRole="header" style={{ fontSize: told ? 34 : 46, lineHeight: told ? 38 : 50, fontWeight: '700', textAlign: 'center', marginTop: 10 }}>
          {told ? 'Your friends were told' : 'You okay?'}
        </D>
        <T style={{ fontSize: 15.5, lineHeight: 22, color: ui.text2, textAlign: 'center', marginTop: 6 }}>
          {told ? 'Type the words if you’re okay, and they’ll know.' : why ?? 'pip noticed something and wants to check on you.'}
        </T>

        {!told && <Countdown left={left} total={total} />}

        <T style={{ fontSize: 14, lineHeight: 18, fontWeight: '600', color: ui.text2, marginTop: told ? 28 : 22 }}>Type these words</T>
        <View testID="checkin-phrase" accessible accessibilityLabel={phrase} style={styles.words}>
          {words.map((w, i) => <Mono key={`${w}${i}`} style={styles.word}>{w}</Mono>)}
        </View>
        <View style={{ alignSelf: 'stretch', marginTop: 14 }} testID="checkin-input" accessible={false}>
          <CheckInInput phrase={phrase} placeholder="type here…" onChange={onChange} onComplete={submit} style={[styles.input, fontFor('500', 'mono')]} />
        </View>
        {result && <T style={{ fontSize: 14, lineHeight: 19, color: ui.text, fontWeight: '600', textAlign: 'center', marginTop: 10 }}>{result}</T>}
      </ScrollView>
      <View style={styles.buttons}>
        <Btn kind="main" size={48} title={busy ? 'Checking…' : 'I’m OK'} onPress={done} disabled={busy} />
        <Btn kind={told ? 'paper' : 'coral'} size={48} title="I need help" onPress={help} />
      </View>
    </View>
  );
}

/** The site's countdown: a paper disc, an ink arc that runs down, the time in mono. */
function Countdown({ left, total }: { left: number; total: number }) {
  const r = 50;
  const c = 2 * Math.PI * r;
  return (
    <View style={{ width: 116, height: 116, marginTop: 22, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="timer" accessibilityLabel={`${left} seconds before friends get a heads-up`}>
      <Svg width={116} height={116} viewBox="0 0 120 120" style={StyleSheet.absoluteFill}>
        <Circle cx={60} cy={60} r={r} fill={ht.paper} stroke="rgba(30,27,46,0.12)" strokeWidth={9} />
        <Circle cx={60} cy={60} r={r} fill="none" stroke={ht.ink} strokeWidth={9} strokeLinecap="round"
          strokeDasharray={`${c}`} strokeDashoffset={c * (1 - Math.min(1, left / total))} transform="rotate(-90 60 60)" />
      </Svg>
      <Mono style={{ fontSize: 26, lineHeight: 30, fontWeight: '500' }}>{fmtCountdown(left * 1000)}</Mono>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.ground },
  body: { alignItems: 'center', paddingHorizontal: 22, paddingBottom: 16, maxWidth: 480, width: '100%', alignSelf: 'center' },
  words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 8 },
  word: { fontSize: 16, lineHeight: 20, fontWeight: '500', paddingVertical: 7, paddingHorizontal: 11, borderRadius: 10, overflow: 'hidden', backgroundColor: ht.paper, borderWidth: 1.5, borderColor: ht.ink },
  input: { borderColor: ht.ink, textAlign: 'center', fontSize: 18 },
  buttons: { gap: 8, paddingHorizontal: 22, maxWidth: 480, width: '100%', alignSelf: 'center' },
  badge: { width: 74, height: 74, borderRadius: 37, backgroundColor: ht.paper, borderWidth: 2.5, borderColor: ht.ink, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
});
