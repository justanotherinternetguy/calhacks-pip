import React, { useState } from 'react';
import { View } from 'react-native';
import { Btn, Icon, T } from '@/components/pip/kit';
import { askCheckIn, cancelCheckIn, checkInLine, latestWith } from '@/lib/checkins';
import { useStore, useUserId } from '@/lib/store';
import { ht, ui } from '@/lib/theme';

/**
 * "Ask if they're okay" for one friend: sends a sticky "You okay?" to their phone (functions/checkin). Shows the
 * latest check-in between you two, and lets you cancel while it is pending. Simulated friends can't be asked.
 */
export function AskOkay({ friendId, name, simulated, size = 56, compact }: { friendId: string; name: string; simulated?: boolean; size?: 44 | 48 | 56; compact?: boolean }) {
  const me = useUserId();
  const checkIns = useStore((s) => s.checkIns);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!me) return null;
  const last = latestWith(checkIns, me, friendId);
  const waiting = last && last.asker_id === me && last.status === 'pending' ? last : null;

  const run = (f: () => Promise<unknown>) => async () => {
    setBusy(true); setNote(null);
    try { await f(); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const ask = run(async () => {
    if (simulated) throw new Error(`${name} is a simulated friend, so there is no phone to ask.`);
    await askCheckIn(friendId);
  });

  return (
    <View style={{ gap: 6 }}>
      {last && !compact && <T style={{ fontSize: 13, lineHeight: 18, color: ui.quiet, textAlign: 'center' }}>{checkInLine(last, me)}</T>}
      {note && <T style={{ fontSize: 13, lineHeight: 18, color: ht.coralDeep, textAlign: 'center' }}>{note}</T>}
      {waiting
        ? <Btn kind="paper" size={size} title={`Waiting for ${name}… · Cancel`} loading={busy} onPress={run(() => cancelCheckIn(waiting.id))} testID={`cancel-ask-${friendId}`} />
        : <Btn kind="main" size={size} icon={Icon.bell(ht.cream, 18)} title={`Ask ${name} if they’re okay`} loading={busy} onPress={ask} testID={`ask-${friendId}`} />}
    </View>
  );
}
