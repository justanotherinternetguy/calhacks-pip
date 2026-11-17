import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, Card, H1, P, Screen } from '@/components/ui';
import { Icon, Mono } from '@/components/pip/kit';
import { answerCheckIn, cancelCheckIn, checkInLine } from '@/lib/checkins';
import { getCheckIn } from '@/lib/db';
import { useStore, useUserId } from '@/lib/store';
import { colors, ui } from '@/lib/theme';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A friend check-in (opened from its sticky notification or a friend's row).
 *   Asked of me → I'm OK / I need help (help also raises the SOS on this phone).
 *   I asked     → status, cancel while pending.
 *   Anyone else in the group → status.
 */
export default function CheckInScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const me = useUserId();
  const profiles = useStore((s) => s.profiles);
  const stored = useStore((s) => s.checkIns.find((c) => c.id === id) ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!id || stored) return;
    getCheckIn(id).then((c) => { if (c) useStore.getState().upsertCheckIn(c); else setError('This check-in is gone.'); }).catch((e) => setError(errText(e)));
  }, [id, stored]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  const run = (label: string, f: () => Promise<unknown>) => async () => {
    setBusy(label); setError(null);
    try { await f(); } catch (e) { setError(errText(e)); } finally { setBusy(null); }
  };

  const c = stored;
  if (!c || !me) {
    return <Screen style={{ justifyContent: 'center' }}><P muted>{error ?? 'Loading…'}</P><Button title="Close" kind="ghost" onPress={close} /></Screen>;
  }
  const nameOf = (uid: string) => (uid === me ? 'You' : profiles[uid]?.display_name || 'A friend');
  const toMe = c.target_id === me;
  const answerable = toMe && (c.status === 'pending' || c.status === 'missed');
  const left = Math.max(0, Math.round((Date.parse(c.deadline_at) - now) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  return (
    <Screen style={{ justifyContent: 'center', maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <Card>
        <H1>{toMe ? `${nameOf(c.asker_id)} asks: you okay?` : c.asker_id === me ? `You asked ${nameOf(c.target_id)}` : `${nameOf(c.asker_id)} asked ${nameOf(c.target_id)}`}</H1>
        <P muted>{checkInLine(c, me, now)}</P>
        {c.status === 'pending' && (
          <View style={{ alignItems: 'center', gap: 4 }}>
            <Mono style={{ fontSize: 28, color: left < 60 ? colors.danger : ui.text }}>{clock}</Mono>
            <P muted style={{ textAlign: 'center' }}>{toMe ? 'Answer before the timer runs out, or your group gets an alert.' : 'If there is no answer by then, the whole group gets an alert.'}</P>
          </View>
        )}
        {c.status === 'missed' && <P>{toMe ? 'You didn’t answer in time, so your group was alerted. Let them know you’re okay:' : 'No answer in time. The group was alerted.'}</P>}
        {answerable && (
          <>
            <Button title="I’m OK" kind="ok" icon={Icon.check(ui.text, 18)} loading={busy === 'ok'} onPress={run('ok', () => answerCheckIn(c.id, 'ok').then(close))} testID="answer-ok" />
            <Button title="I need help" kind="danger" loading={busy === 'help'} onPress={run('help', () => answerCheckIn(c.id, 'help'))} testID="answer-help" />
          </>
        )}
        {c.asker_id === me && c.status === 'pending' && (
          <Button title="Cancel check-in" kind="ghost" loading={busy === 'cancel'} onPress={run('cancel', () => cancelCheckIn(c.id))} />
        )}
        {c.incident_id && <Button title="Open the group alert" kind="ghost" onPress={() => router.push(`/incident/${c.incident_id}`)} />}
        {error && <P style={{ color: colors.danger }}>{error}</P>}
        <Button title="Close" kind="ghost" onPress={close} />
      </Card>
    </Screen>
  );
}
