import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Btn, Caps, Chip, D, Dot, Icon, T } from '@/components/pip/kit';
import type { Person } from '@/components/pip/usePeople';
import { answerCheckIn, askCheckIn, cancelCheckIn, checkInLine, latestWith, openQuestionsForMe } from '@/lib/checkins';
import { useStore, useUserId } from '@/lib/store';
import { ht, ui } from '@/lib/theme';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A friend asked me "You okay?": the first thing on the home sheet until I answer. */
export function QuestionsForMe() {
  const me = useUserId();
  const checkIns = useStore((s) => s.checkIns);
  const profiles = useStore((s) => s.profiles);
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!me) return null;
  const open = openQuestionsForMe(checkIns, me);
  if (!open.length) return null;
  const q = open[0];
  const who = profiles[q.asker_id]?.display_name || 'A friend';
  const ok = async () => {
    setBusy('ok'); setNote(null);
    try { await answerCheckIn(q.id, 'ok'); } catch (e) { setNote(errText(e)); } finally { setBusy(null); }
  };
  return (
    <View style={{ gap: 8, marginBottom: 14 }} testID="question-for-me">
      <Chip fill={q.status === 'missed' ? ht.coral : ht.lilac} small>{q.status === 'missed' ? 'Group alerted' : 'Check-in'}</Chip>
      <D accessibilityRole="header" style={{ fontSize: 26, lineHeight: 30 }}>{who} asks: you okay?</D>
      {open.length > 1 && <T style={{ fontSize: 13, color: ui.quiet }}>{open.length - 1} more friend{open.length > 2 ? 's' : ''} asked too.</T>}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn kind="mint" size={48} title="I’m OK" icon={Icon.check(ht.ink)} loading={busy === 'ok'} onPress={() => void ok()} style={{ flex: 1 }} testID="home-answer-ok" />
        <Btn kind="paper" size={48} title="I need help" onPress={() => router.push(`/checkin/${q.id}`)} style={{ flex: 1 }} />
      </View>
      {note && <T style={{ fontSize: 13, color: ht.coralDeep }}>{note}</T>}
    </View>
  );
}

/** "Check on your friends": each friend with where the last check-in stands and a one-tap "Ask". */
export function CheckOnFriends({ others, onOpen, max = 4 }: { others: Person[]; onOpen: (id: string) => void; max?: number }) {
  const me = useUserId();
  const checkIns = useStore((s) => s.checkIns);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!me) return null;
  const shown = others.slice(0, max);
  const run = (id: string, f: () => Promise<unknown>) => async () => {
    setBusy(id); setNote(null);
    try { await f(); } catch (e) { setNote(errText(e)); } finally { setBusy(null); }
  };

  return (
    <View style={{ marginBottom: 12 }}>
      <Caps>CHECK ON YOUR FRIENDS</Caps>
      {shown.length === 0 && <T style={{ fontSize: 14, lineHeight: 20, color: ui.quiet, marginTop: 6 }}>Add friends in person (Friends → Show invite code) so you can check on each other.</T>}
      {shown.map(({ f, c }) => {
        const last = latestWith(checkIns, me, f.id);
        const waiting = last && last.asker_id === me && last.status === 'pending' ? last : null;
        const sub = last ? checkInLine(last, me) : c.headline;
        return (
          <View key={f.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 }}>
            <Pressable accessibilityRole="button" onPress={() => onOpen(f.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
              <Dot tone={c.tone} size={11} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T style={{ fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{f.name}</T>
                {sub ? <T style={{ fontSize: 12.5, lineHeight: 16, color: ui.quiet }} numberOfLines={1}>{sub}</T> : null}
              </View>
            </Pressable>
            {waiting
              ? <Btn kind="paper" size={44} title="Cancel" loading={busy === f.id} onPress={run(f.id, () => cancelCheckIn(waiting.id))} />
              : <Btn kind="main" size={44} title="Ask" icon={Icon.bell(ht.cream, 15)} loading={busy === f.id} testID={`home-ask-${f.id}`}
                  onPress={run(f.id, async () => { if (f.simulated) throw new Error(`${f.name} is simulated, so there is no phone to ask.`); await askCheckIn(f.id); })} />}
          </View>
        );
      })}
      {note && <T style={{ fontSize: 13, color: ht.coralDeep }}>{note}</T>}
    </View>
  );
}
