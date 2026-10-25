// Times the subject confirmed they are OK, as the monitor saw them: the phone's `owner_ok` engine event (a check-in
// answered after fingerprint / face / PIN, or an alert stood down with a biometric) and the manual "I'm okay"
// broadcast. Kept per subject in this browser so a refresh keeps the log; the AI read resets to 0 on a new one.
import { useEffect, useRef, useState } from 'react';
import { subscribeTelemetry } from '@/lib/telemetry';
import type { EngineEventEntry } from '@/lib/telemetry';
import type { OkConfirmation } from './riskAnalysis';
import { addConfirmation } from './okList.ts';

export { addConfirmation };

const KEY = 'safe.monitor.ok.';

function load(subject: string): OkConfirmation[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY + subject);
    const v = raw ? (JSON.parse(raw) as OkConfirmation[]) : [];
    return Array.isArray(v) ? v.filter((c) => typeof c?.atMs === 'number') : [];
  } catch {
    return [];
  }
}
function save(subject: string, list: OkConfirmation[]) {
  try { globalThis.localStorage?.setItem(KEY + subject, JSON.stringify(list)); } catch {}
}

/** Confirmations for `subjectId`, newest last, and `clear` (Delete all). `events` is the monitor's engine-event buffer
 * (scanned for owner_ok). */
export function useOkConfirmations(subjectId: string | null, events: EngineEventEntry[]): { list: OkConfirmation[]; clear: () => void } {
  const [state, setState] = useState<{ subject: string | null; list: OkConfirmation[] }>(() => ({ subject: subjectId, list: subjectId ? load(subjectId) : [] }));
  if (state.subject !== subjectId) setState({ subject: subjectId, list: subjectId ? load(subjectId) : [] });
  const seen = useRef(new Set<string>());

  const add = (subject: string, c: OkConfirmation) =>
    setState((s) => {
      if (s.subject !== subject) return s;
      const list = addConfirmation(s.list, c);
      if (list !== s.list) save(subject, list);
      return list === s.list ? s : { subject, list };
    });

  // owner_ok in the engine-event stream
  const last = events.at(-1)?.key;
  useEffect(() => {
    if (!subjectId) return;
    for (const e of events) {
      if (e.name !== 'owner_ok' || seen.current.has(`${subjectId}:${e.key}`)) continue;
      seen.current.add(`${subjectId}:${e.key}`);
      add(subjectId, { atMs: e.t, how: 'check_in' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectId, last]);

  // the manual "I'm okay" broadcast
  useEffect(() => {
    if (!subjectId) return;
    return subscribeTelemetry(subjectId, () => {}, () => {}, (atMs) => add(subjectId, { atMs, how: 'tapped' }));
  }, [subjectId]);

  const clear = () => {
    if (!subjectId) return;
    try { globalThis.localStorage?.removeItem(KEY + subjectId); } catch {}
    setState({ subject: subjectId, list: [] });
  };
  return { list: state.subject === subjectId ? state.list : [], clear };
}
