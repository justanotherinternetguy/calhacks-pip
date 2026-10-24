// Data the monitor cannot get over realtime:
//  - `device_status` is a security-barrier VIEW over `devices`; `devices` is not in the supabase_realtime
//    publication and its RLS is self-only, so a friend never receives change events for a group-mate's
//    row. We poll the view instead (default 15 s).
//  - `audit_log` is likewise outside the publication; polled on the same tick.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useStore } from '@/lib/store';
import type { AuditLog, IncidentEvent, Uuid } from '@/lib/types';

export type DeviceStatus = {
  device_id: Uuid; user_id: Uuid; platform: 'ios' | 'android'; last_heartbeat: string | null; night_mode: boolean;
  battery_pct: number | null; status_level: string;
};

/** Wall clock that ticks every `everyMs`, for live ages / the header clock. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** Stable key for a list of ids so effects don't re-run on every render. */
const idsKey = (ids: Uuid[]) => [...new Set(ids)].sort().join(',');
const NO_DEVICES: Record<Uuid, DeviceStatus> = {};
const NO_FEED: FeedItem[] = [];

export function useDeviceStatus(userIds: Uuid[], intervalMs = 15_000): Record<Uuid, DeviceStatus> {
  const key = idsKey(userIds);
  const [byUser, setByUser] = useState<Record<Uuid, DeviceStatus>>(NO_DEVICES);
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    if (!ids.length) return;
    let alive = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('device_status')
        .select('device_id,user_id,platform,last_heartbeat,night_mode,battery_pct,status_level')
        .in('user_id', ids);
      if (!alive || error || !data) { if (error) console.warn('device_status', error.message); return; }
      const next: Record<Uuid, DeviceStatus> = {};
      for (const row of data as DeviceStatus[]) {
        // One row per user in practice; keep the freshest heartbeat if there are more.
        const cur = next[row.user_id];
        if (!cur || (row.last_heartbeat ?? '') > (cur.last_heartbeat ?? '')) next[row.user_id] = row;
      }
      setByUser(next);
    };
    void load();
    const t = setInterval(() => void load(), intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [key, intervalMs]);
  return key ? byUser : NO_DEVICES;
}

export type FeedItem = {
  id: string; at: string; kind: string; actor_id: Uuid | null; subject_id: Uuid | null; source: 'audit' | 'event'; incident_id: Uuid | null;
};

/**
 * Last-24h activity across the group: audit_log rows for every member (polled) merged with incident_events
 * for incidents opened in the window (polled + whatever realtime has pushed into the store). Newest first.
 */
export function useActivityFeed(userIds: Uuid[], intervalMs = 15_000, hours = 24): FeedItem[] {
  const key = idsKey(userIds);
  const incidents = useStore((s) => s.incidents);
  const storeEvents = useStore((s) => s.events);
  const [audit, setAudit] = useState<AuditLog[]>([]);
  const [polledEvents, setPolledEvents] = useState<IncidentEvent[]>([]);
  // The window edge only needs minute precision; a ticking value keeps render pure.
  const nowMs = useNow(60_000);
  const sinceMs = nowMs - hours * 3_600_000;
  const recentIncidentKey = useMemo(
    () => idsKey(incidents.filter((i) => new Date(i.opened_at).getTime() >= sinceMs).map((i) => i.id)),
    [incidents, sinceMs],
  );

  useEffect(() => {
    const ids = key ? key.split(',') : [];
    const incidentIds = recentIncidentKey ? recentIncidentKey.split(',') : [];
    if (!ids.length) return;
    let alive = true;
    const load = async () => {
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      const [a, e] = await Promise.all([
        supabase.from('audit_log').select('*').in('subject_user_id', ids).gte('created_at', since).order('created_at', { ascending: false }).limit(200),
        incidentIds.length
          ? supabase.from('incident_events').select('*').in('incident_id', incidentIds).gte('created_at', since).order('created_at', { ascending: false }).limit(200)
          : Promise.resolve({ data: [] as IncidentEvent[], error: null }),
      ]);
      if (!alive) return;
      if (a.error) console.warn('audit_log', a.error.message); else setAudit((a.data ?? []) as AuditLog[]);
      if (e.error) console.warn('incident_events', e.error.message); else setPolledEvents((e.data ?? []) as IncidentEvent[]);
    };
    void load();
    const t = setInterval(() => void load(), intervalMs);
    return () => { alive = false; clearInterval(t); };
  }, [key, recentIncidentKey, intervalMs, hours]);

  const feed = useMemo(() => {
    const subjectOf = new Map(incidents.map((i) => [i.id, i.user_id] as const));
    const seen = new Set<string>();
    const out: FeedItem[] = [];
    for (const a of audit) {
      if (seen.has(`a:${a.id}`)) continue;
      seen.add(`a:${a.id}`);
      const inc = typeof a.payload?.incident_id === 'string' ? a.payload.incident_id : null;
      out.push({ id: `a:${a.id}`, at: a.created_at, kind: a.kind, actor_id: a.actor_id, subject_id: a.subject_user_id, source: 'audit', incident_id: inc });
    }
    const live = recentIncidentKey ? recentIncidentKey.split(',').flatMap((id) => storeEvents[id] ?? []) : [];
    for (const e of [...polledEvents, ...live]) {
      if (seen.has(`e:${e.id}`) || new Date(e.created_at).getTime() < sinceMs) continue;
      seen.add(`e:${e.id}`);
      out.push({ id: `e:${e.id}`, at: e.created_at, kind: e.kind, actor_id: e.actor_id, subject_id: subjectOf.get(e.incident_id) ?? null, source: 'event', incident_id: e.incident_id });
    }
    return out.sort((x, y) => y.at.localeCompare(x.at));
  }, [audit, polledEvents, storeEvents, incidents, recentIncidentKey, sinceMs]);
  return key ? feed : NO_FEED;
}
