import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { P, Screen } from '@/components/ui';
import { Brand, Btn, Caps, D, Dot, Mono, T } from '@/components/pip/kit';
import { fmtCountdown } from '@/components/telemetry/labels';
import { CheckInInput, SafetyNative, type CheckInResult } from '@/modules/safety-native';
import { useStore } from '@/lib/store';
import { ht, ui } from '@/lib/theme';

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
      else setResult(`Not accepted: ${v.reason}. Try once more, or tap "Need help".`);
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
  const ring = 2 * Math.PI * 18;

  if (accepted) {
    return (
      <View style={[styles.screen, { justifyContent: 'center', alignItems: 'center', gap: 10, padding: 24 }]}>
        <Dot tone="out" size={28} />
        <D accessibilityRole="header" style={{ fontSize: 40, lineHeight: 44 }}>Glad you’re okay.</D>
        <T style={{ fontSize: 16, color: ui.quiet, textAlign: 'center' }}>Thanks for letting your friends know.</T>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.youWrap}>
        <View style={{ position: 'absolute', top: 56 }}><Brand size={26} /></View>
        <View style={styles.youGlow} />
        <Dot tone="out" isMe size={20} />
      </View>
      <ScrollView style={styles.card} contentContainerStyle={{ gap: 16, padding: 22, paddingTop: 24, maxWidth: 560, width: '100%', alignSelf: 'center' }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Svg width={44} height={44} viewBox="0 0 44 44" accessibilityRole="image" accessibilityLabel={`${left} seconds left`}>
            <Circle cx={22} cy={22} r={18} fill="none" stroke={ui.line} strokeWidth={3} />
            <Circle cx={22} cy={22} r={18} fill="none" stroke={ht.butter} strokeWidth={6} strokeLinecap="round"
              strokeDasharray={`${ring}`} strokeDashoffset={ring * (1 - Math.min(1, left / total))} transform="rotate(-90 22 22)" />
            <Circle cx={22} cy={22} r={18} fill="none" stroke={ht.ink} strokeWidth={1.5} />
          </Svg>
          <T style={{ flex: 1, fontSize: 14, color: ui.quiet }}>
            Friends get a heads-up in <Mono style={{ color: ui.text, fontWeight: '500' }}>{fmtCountdown(left * 1000)}</Mono>
          </T>
        </View>
        <View style={{ gap: 6 }}>
          <D accessibilityRole="header" style={{ fontSize: 44, lineHeight: 48 }}>You okay?</D>
          <T style={{ fontSize: 17, lineHeight: 25, color: ui.text2 }}>Type the words below so your friends know you’re good.</T>
        </View>
        <View style={{ alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 18, backgroundColor: ui.sunk }}>
          <D testID="checkin-phrase" style={{ fontSize: 28, lineHeight: 34, letterSpacing: 0 }}>{phrase}</D>
        </View>
        <View style={{ gap: 6 }} testID="checkin-input" accessible={false}>
          <Caps>TYPE IT HERE</Caps>
          <CheckInInput phrase={phrase} placeholder={phrase} onChange={onChange} onComplete={submit} />
        </View>
        {result && <T style={{ fontSize: 14, color: ht.coralDeep }}>{result}</T>}
        <View style={{ gap: 10, marginTop: 8 }}>
          <Btn kind="main" size={56} title={busy ? 'Checking…' : 'Okay'} onPress={done} disabled={busy} />
          <Btn kind="coral" title="Need help" onPress={help} />
          <T style={{ fontSize: 12.5, lineHeight: 17, color: ui.quiet, textAlign: 'center', marginTop: -4 }}>Alerts your friends now and shares your location with them.</T>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.ground },
  youWrap: { height: 250, alignItems: 'center', justifyContent: 'center' },
  youGlow: { position: 'absolute', width: 84, height: 84, borderRadius: 42, backgroundColor: ui.youWash },
  card: {
    position: 'absolute', left: 0, right: 0, top: 230, bottom: 0, backgroundColor: ui.panel, borderTopLeftRadius: 30, borderTopRightRadius: 30,
    borderWidth: 2, borderBottomWidth: 0, borderColor: ht.ink,
  },
});
