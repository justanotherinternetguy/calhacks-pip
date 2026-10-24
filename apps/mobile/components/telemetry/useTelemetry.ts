// One subscription per group-mate so the console can tell who is publishing, plus full history buffers for the
// member currently on screen. Fleet members that are not selected only update a "last seen" table (1 Hz sync).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TelemetryTick } from '@/modules/safety-native';
import { TelemetryBuffers, subscribeTelemetry, type TelemetryConnection, type TickDelta } from '@/lib/telemetry';

export type FleetSeen = Record<string, { at: number; tick: TelemetryTick }>;
/** A member counts as "publishing" when a tick arrived this recently. */
export const PUBLISHING_MS = 10_000;

type Live = { subject: string | null; tick: TelemetryTick | null; n: number };
const idsKey = (ids: string[]) => [...new Set(ids)].sort().join(',');

/**
 * Subscribes to every member's channel. The subject on screen is `manual` (a pinned member) if set, else the
 * member whose phone is publishing (sticky auto-pick, `preferNot` = me breaks ties), else `fallback`.
 */
export function useTelemetryFleet(
  memberIds: string[],
  opts: { manual: string | null; fallback: string | null; preferNot?: string | null; onDelta?: (delta: TickDelta, tick: TelemetryTick) => void },
) {
  const buffers = useMemo(() => new TelemetryBuffers(), []);
  const [live, setLive] = useState<Live>({ subject: null, tick: null, n: 0 });
  const [conn, setConn] = useState<Record<string, TelemetryConnection>>({});
  const [seen, setSeen] = useState<FleetSeen>({});
  /** Sticky auto-pick: the member whose phone is publishing (kept while it keeps publishing). */
  const [publisher, setPublisher] = useState<string | null>(null);
  const manualOk = opts.manual && memberIds.includes(opts.manual) ? opts.manual : null;
  const subjectId = manualOk ?? (publisher && memberIds.includes(publisher) ? publisher : null) ?? opts.fallback;

  const subjectRef = useRef(subjectId);
  const preferNotRef = useRef(opts.preferNot ?? null);
  const onDeltaRef = useRef(opts.onDelta);
  useEffect(() => { subjectRef.current = subjectId; }, [subjectId]);
  useEffect(() => { preferNotRef.current = opts.preferNot ?? null; }, [opts.preferNot]);
  useEffect(() => { onDeltaRef.current = opts.onDelta; }, [opts.onDelta]);

  const key = idsKey(memberIds);
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    const seenNow: FleetSeen = {};
    let bufferedFor: string | null = null;
    let current: string | null = null;
    const unsubs = ids.map((id) => subscribeTelemetry(
      id,
      (tick, at) => {
        seenNow[id] = { at, tick };
        if (id !== subjectRef.current) return;
        if (bufferedFor !== id) { buffers.reset(); bufferedFor = id; }
        const delta = buffers.push(tick, at);
        setLive({ subject: id, tick, n: buffers.ticks });
        if (delta.newIncidents.length || delta.events.length) onDeltaRef.current?.(delta, tick);
      },
      (s) => setConn((prev) => ({ ...prev, [id]: s })),
    ));
    const sync = setInterval(() => {
      const now = Date.now();
      setSeen({ ...seenNow });
      const publishing = ids.filter((id) => seenNow[id] && now - seenNow[id].at < PUBLISHING_MS).sort((a, b) => seenNow[b].at - seenNow[a].at);
      if (!current || !publishing.includes(current)) {
        current = publishing.find((id) => id !== preferNotRef.current) ?? publishing[0] ?? null;
        setPublisher(current);
      }
    }, 1_000);
    return () => {
      unsubs.forEach((u) => u());
      clearInterval(sync);
      setConn({});
      setPublisher(null);
    };
  }, [key, buffers]);

  const tick = live.subject === subjectId ? live.tick : null;
  return {
    subjectId,
    /** true when the subject was pinned by hand rather than auto-picked */
    manual: manualOk != null,
    buffers,
    /** newest tick for the selected subject (null until one arrives / after switching) */
    tick,
    tickCount: live.subject === subjectId ? live.n : 0,
    conn: subjectId ? conn[subjectId] : undefined,
    connAll: conn,
    seen,
    publisher,
  };
}
