// The friends map's data: everyone in my groups plus the simulated friends, each with their newest telemetry state,
// incident log and position. One feed for the whole app (mounted in the root layout), refreshed once a second.
import { useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import { create } from 'zustand';
import { SafetyNative, isCheckPending, type Activity, type EscalationLevel, type IncidentRecord, type TelemetryTick } from '@/modules/safety-native';
import { activeIncidents, useStore, useUserId } from './store';
import type { Incident } from './types';
import { setSimulatedUsers, subscribeTelemetry, type TelemetryConnState } from './telemetry';
import { SIM_FRIENDS, isSimId, setSimAnchor, simAnchor, type LatLng } from './sim';

export type { LatLng } from './sim';

export type FriendLive = {
  id: string;
  name: string;
  initial: string;
  isMe: boolean;
  /** made-up data (no sensors) */
  simulated: boolean;
  phone: string | null;
  loc: LatLng | null;
  /** local ms of the newest tick */
  lastTickAt: number | null;
  conn: TelemetryConnState | null;
  escalation: EscalationLevel;
  nightMode: boolean;
  battery: number | null;
  activity: Activity;
  listening: boolean;
  checkPending: boolean;
  checkDeadlineMs: number | null;
  checkSummary: string | null;
  /** tonight's incident records, oldest first */
  records: IncidentRecord[];
  /** when they last said "I'm okay" by hand (phone ms), if they did */
  okayAt: number | null;
  /**
   * Their newest open incident on the server (SOS, heads-up, location unlock, phone offline…), if any. This is what
   * friends act on (incident page: unlock the map, on my way, found); the telemetry log above is display only.
   */
  serverIncident: Incident | null;
};

type FeedState = { friends: FriendLive[]; anchor: LatLng; ready: boolean };
export const useFriends = create<FeedState>(() => ({ friends: [], anchor: simAnchor(), ready: false }));

const LOG_WINDOW_MS = 12 * 3_600_000;
const initialOf = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

type Roster = { id: string; name: string; phone: string | null; isMe: boolean }[];
type Acc = { tick: TelemetryTick | null; at: number | null; conn: TelemetryConnState | null; log: Map<number, IncidentRecord>; okayAt: number | null };

/** Mount once (root layout). Subscribes to every roster member and publishes a snapshot every second. */
export function useFriendsFeed() {
  const me = useUserId();
  const members = useStore((s) => s.members);
  const profiles = useStore((s) => s.profiles);
  const sensorUsers = useStore((s) => s.sensorUsers);

  const roster: Roster = useMemo(() => {
    if (!me) return [];
    const ids = [...new Set([me, ...members.filter((m) => m.status === 'active').map((m) => m.user_id)])];
    const real = ids.map((id) => ({ id, name: profiles[id]?.display_name || (id === me ? 'You' : 'Friend'), phone: profiles[id]?.phone ?? null, isMe: id === me }));
    return [...real, ...SIM_FRIENDS.map((f) => ({ ...f, isMe: false }))];
  }, [me, members, profiles]);

  // Real accounts with no phone registered get simulated data. My own phone always counts as a sensor. Until the
  // device list has loaded (or if it failed) nobody real is simulated: better "not streaming" than a made-up night.
  const simulatedReal = useMemo(() => {
    if (!sensorUsers) return [];
    const sensors = new Set(sensorUsers);
    if (me && Platform.OS !== 'web' && !SafetyNative.isMock) sensors.add(me);
    return roster.filter((r) => !isSimId(r.id) && !sensors.has(r.id)).map((r) => r.id);
  }, [roster, sensorUsers, me]);
  const simKey = simulatedReal.join(',');
  useEffect(() => { setSimulatedUsers(simKey ? simKey.split(',') : []); }, [simKey]);

  // My own position on the phone comes straight from the GPS (fresher than my telemetry echo).
  const myFix = useRef<LatLng | null>(null);
  const meIsReal = !!me && !simulatedReal.includes(me);
  useEffect(() => {
    if (Platform.OS === 'web' || !meIsReal) return;
    let sub: Location.LocationSubscription | null = null;
    let alive = true;
    (async () => {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') status = (await Location.requestForegroundPermissionsAsync()).status;
      if (status !== 'granted' || !alive) return;
      const last = await Location.getLastKnownPositionAsync().catch(() => null);
      if (last) myFix.current = { lat: last.coords.latitude, lng: last.coords.longitude };
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, distanceInterval: 10, timeInterval: 5_000 }, (p) => {
        myFix.current = { lat: p.coords.latitude, lng: p.coords.longitude };
      });
      if (!alive) sub.remove();
    })().catch((e) => console.warn('location watch', e));
    return () => { alive = false; sub?.remove(); };
  }, [meIsReal]);

  const rosterKey = roster.map((r) => r.id).join(',');
  const rosterRef = useRef(roster);
  const simRef = useRef(simulatedReal);
  useEffect(() => { rosterRef.current = roster; simRef.current = simulatedReal; }, [roster, simulatedReal]);

  useEffect(() => {
    const ids = rosterKey ? rosterKey.split(',') : [];
    const acc = new Map<string, Acc>(ids.map((id) => [id, { tick: null, at: null, conn: null, log: new Map(), okayAt: null }]));
    const unsubs = ids.map((id) => subscribeTelemetry(
      id,
      (tick, at) => {
        const a = acc.get(id)!;
        if (tick.events.includes('incident_log_cleared')) a.log.clear();
        for (const r of tick.incidents) a.log.set(r.id, r);
        a.tick = tick;
        a.at = at;
      },
      (s) => { acc.get(id)!.conn = s.state; },
      (atMs) => { acc.get(id)!.okayAt = atMs; },
      () => { const a = acc.get(id)!; a.tick = null; a.at = null; a.conn = null; a.log.clear(); },
    ));

    const flush = () => {
      const now = Date.now();
      const sims = new Set(simRef.current);
      // Anchor the simulated stories on the first real person with a position (snapped, so devices agree).
      const realFix = rosterRef.current
        .filter((r) => !isSimId(r.id) && !sims.has(r.id))
        .map((r) => (r.isMe && myFix.current) || acc.get(r.id)?.tick?.loc || null)
        .find(Boolean);
      setSimAnchor(realFix ?? null);
      // Newest first (the store keeps them sorted by opened_at desc), so the first open one per user wins.
      const open = new Map<string, Incident>();
      for (const i of activeIncidents(useStore.getState().incidents)) if (!open.has(i.user_id)) open.set(i.user_id, i);
      const friends = rosterRef.current.map((r): FriendLive => {
        const a = acc.get(r.id);
        const t = a?.tick ?? null;
        const simulated = isSimId(r.id) || sims.has(r.id);
        const records = a ? [...a.log.values()].filter((x) => now - x.tMs < LOG_WINDOW_MS).sort((x, y) => x.tMs - y.tMs || x.id - y.id) : [];
        const tickLoc = t?.loc ? { lat: t.loc.lat, lng: t.loc.lng } : null;
        return {
          id: r.id, name: r.name, initial: initialOf(r.name), isMe: r.isMe, simulated, phone: r.phone,
          loc: (r.isMe && !simulated && myFix.current) || tickLoc,
          lastTickAt: a?.at ?? null, conn: a?.conn ?? null,
          escalation: t?.escalation ?? 'idle', nightMode: t?.nightMode ?? false, battery: t?.battery ?? null,
          activity: t?.activity ?? 'unknown', listening: t?.listening ?? false,
          checkPending: isCheckPending(t), checkDeadlineMs: t?.checkDeadlineMs ?? null, checkSummary: t?.checkSummary ?? null,
          records,
          okayAt: a?.okayAt ?? null,
          serverIncident: open.get(r.id) ?? null,
        };
      });
      useFriends.setState({ friends, anchor: simAnchor(), ready: true });
    };
    flush();
    const timer = setInterval(flush, 1_000);
    return () => { clearInterval(timer); unsubs.forEach((u) => u()); };
  }, [rosterKey]);
}

export const useFriend = (id: string | null | undefined) => useFriends((s) => s.friends.find((f) => f.id === id) ?? null);

// ---- geometry ----------------------------------------------------------------------------------------

export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6_371_000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** Compass bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
/** The group's "Pip zone": a circle around the meeting point. */
export const ZONE_RADIUS_M = 150;
export const walkMinutes = (m: number) => Math.max(1, Math.round(m / 80));
