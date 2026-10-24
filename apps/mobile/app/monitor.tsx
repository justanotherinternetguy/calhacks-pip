import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import type { TelemetryTick } from '@/modules/safety-native';
import { Pill } from '@/components/ui';
import { activeIncidents, useStore, useUserId } from '@/lib/store';
import { subscribe } from '@/lib/db';
import { NO_STREAM_HINT_MS, type TickDelta } from '@/lib/telemetry';
import type { Incident, IncidentEvent, Presence } from '@/lib/types';
import { colors, levelColor } from '@/lib/theme';
import { StatusRail } from '@/components/monitor/StatusRail';
import { IncidentPanel } from '@/components/monitor/IncidentPanel';
import { QuietPanel } from '@/components/monitor/QuietPanel';
import { useActivityFeed, useDeviceStatus, useNow } from '@/components/monitor/useMonitorData';
import { beep, primeAudio } from '@/components/monitor/beep';
import { TelemetryHeader, type SubjectOption } from '@/components/telemetry/TelemetryHeader';
import { WaveformPanel } from '@/components/telemetry/WaveformPanel';
import { MetricsPanel } from '@/components/telemetry/MetricsPanel';
import { LiveIncidentLog } from '@/components/telemetry/LiveIncidentLog';
import { EventTicker } from '@/components/telemetry/EventTicker';
import { CheckInBanner } from '@/components/telemetry/CheckInBanner';
import { PUBLISHING_MS, useTelemetryFleet } from '@/components/telemetry/useTelemetry';
import { ALERT_EVENTS } from '@/components/telemetry/labels';

const SOUND_KEY = 'safe.monitor.sound';
const WIDE = 1100; // three columns
const MID = 760; // two columns: telemetry stacked | incident + rail
const RIGHT_W = 380;
const BEEP_RECORD_AGE_MS = 30_000;

/**
 * /monitor — the friend's desktop telemetry console (laptop browser). The subject's Android phone broadcasts a
 * 4 Hz tick on a private Realtime channel (CONTRACTS §7); this page subscribes as a group-mate and draws it:
 *   left   live |a| / |ω| traces, P(danger) strip, HMM probability stack (canvas, rAF)
 *   middle metric band tiles, evidence line, the engine's incident log, the engine event ticker
 *   right  the escrow-side incident panel (map after unlock, Ring / I'm going / Found / Request location) + group rail
 * Location never travels over telemetry: the map still comes from released_keys + location_blobs.
 */
export default function MonitorScreen() {
  const router = useRouter();
  const me = useUserId();
  const groups = useStore((s) => s.groups);
  const members = useStore((s) => s.members);
  const profiles = useStore((s) => s.profiles);
  const presence = useStore((s) => s.presence);
  const incidents = useStore((s) => s.incidents);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const mid = !wide && width >= MID;
  const now = useNow(500);

  const memberIds = useMemo(() => [...new Set(members.filter((m) => m.status === 'active').map((m) => m.user_id))], [members]);
  const devices = useDeviceStatus(memberIds);
  const feed = useActivityFeed(memberIds);
  const active = useMemo(() => activeIncidents(incidents), [incidents]);
  const name = useCallback((id: string | null | undefined) => (id ? profiles[id]?.display_name || `Friend ${id.slice(0, 6)}` : 'Nobody'), [profiles]);

  // Sound: on by default, remembered per browser. Toggling is the user gesture that unlocks WebAudio.
  const [soundOn, setSoundOn] = useState(() => {
    if (Platform.OS !== 'web') return false;
    try { return globalThis.localStorage?.getItem(SOUND_KEY) !== '0'; } catch { return true; }
  });
  const toggleSound = useCallback(() => {
    setSoundOn((v) => {
      const next = !v;
      try { globalThis.localStorage?.setItem(SOUND_KEY, next ? '1' : '0'); } catch {}
      if (next) { primeAudio(); beep(); }
      return next;
    });
  }, []);
  const soundRef = useRef(soundOn);
  useEffect(() => { soundRef.current = soundOn; }, [soundOn]);

  // Beep on a new incident record or an escalation event in the tick (never for records older than 30 s —
  // a reconnect can replay the tail of the log).
  const onDelta = useCallback((d: TickDelta, tick: TelemetryTick) => {
    if (Platform.OS !== 'web' || !soundRef.current) return;
    const freshRecord = d.newIncidents.some((r) => tick.t - r.tMs < BEEP_RECORD_AGE_MS);
    if (freshRecord || d.events.some((e) => ALERT_EVENTS.has(e))) beep();
  }, []);

  // Subject: pinned member, else whoever is publishing, else the first group-mate who is not me.
  const [pinned, setPinned] = useState<string | null>(null);
  const fallback = memberIds.find((id) => id !== me) ?? memberIds[0] ?? null;
  const { subjectId, manual, buffers, tick, conn, seen, publisher } = useTelemetryFleet(memberIds, { manual: pinned, fallback, preferNot: me, onDelta });
  const subjects: SubjectOption[] = memberIds.map((id) => ({ id, name: name(id), isMe: id === me, publishing: !!seen[id] && now - seen[id].at < PUBLISHING_MS }));
  const subjectName = name(subjectId);
  const phoneNow = tick && buffers.lastTickAt ? tick.t + (now - buffers.lastTickAt) : now;

  // Incident selection: newest unresolved incident, preferring the subject's. A manual pick sticks only until
  // a newer incident opens, so a fresh alert always takes the screen.
  const [manualInc, setManualInc] = useState<{ id: string; atMs: number } | null>(null);
  const newest = active.find((i) => i.user_id === subjectId) ?? active[0] ?? null;
  const manualIncOk = manualInc && active.some((i) => i.id === manualInc.id) && (!newest || manualInc.atMs > new Date(newest.opened_at).getTime());
  const selected = (manualIncOk ? active.find((i) => i.id === manualInc.id) : undefined) ?? newest;

  // Beep (web only) when a Supabase incident opens after this page loaded — never for one found on refresh.
  const [mountedAt] = useState(() => Date.now());
  const knownIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    let fresh = false;
    for (const i of active) {
      if (knownIds.current.has(i.id)) continue;
      knownIds.current.add(i.id);
      if (new Date(i.opened_at).getTime() > mountedAt - 30_000) fresh = true;
    }
    if (fresh && Platform.OS === 'web' && soundRef.current) beep();
  }, [active, mountedAt]);

  // Realtime mirrors into the store (idempotent; lib/native.ts wires the same tables at sign-in, but the
  // monitor must keep working even if that happened before the socket was up).
  useEffect(() => {
    if (!me) return;
    const st = useStore.getState();
    const chans = [
      subscribe('incidents', undefined, (row: Incident) => st.upsertIncident(row)),
      subscribe('incident_events', undefined, (row: IncidentEvent, ev) => { if (ev === 'INSERT') st.addEvent(row); }),
      subscribe('presence', undefined, (row: Presence) =>
        useStore.setState((s) => ({ presence: { ...s.presence, [row.group_id]: [row, ...(s.presence[row.group_id] ?? []).filter((p) => p.user_id !== row.user_id)] } }))),
    ];
    return () => chans.forEach((c) => c.unsubscribe());
  }, [me]);

  const groupName = groups.length ? groups.map((g) => g.name).join(' · ') : 'No group';
  const activeGroup = selected ? groups.find((g) => g.id === selected.group_id) : undefined;
  const mapHeight = wide || mid ? 320 : 280;

  // Hints: subscribed but silent for 10 s, or the stream stopped.
  const silentFor = conn?.state === 'subscribed' && conn.subscribedAt ? now - conn.subscribedAt : conn?.state === 'stale' && conn.lastTickAt ? now - conn.lastTickAt : 0;
  const notStreaming = !!subjectId && silentFor > NO_STREAM_HINT_MS;
  const rejected = conn?.state === 'error' && conn.attempts >= 2;

  const hints = (
    <>
      {!me && <Banner color={colors.warn} label="signed out" text="Sign in on this browser as a group member to watch." />}
      {me && !memberIds.length && <Banner color={colors.muted} label="no group" text="Join a group on your phone first; the console lists its members here." />}
      {notStreaming && (
        <Banner color={colors.warn} label={conn?.state === 'stale' ? 'stream stopped' : 'not streaming'}
          text={`${subjectName}'s phone is not streaming: open the app, Settings → Stream telemetry to monitor. Ticks go out at 4 Hz while on (1 Hz in night mode otherwise).`} />
      )}
      {rejected && <Banner color={colors.danger} label="channel refused" text={`Could not join telemetry:${subjectId?.slice(0, 8)}… (${conn?.error ?? 'unknown'}). Only the subject and their group-mates may read it.`} />}
      {publisher && subjectId !== publisher && !manual && (
        <Banner color={colors.accent} label="publishing" text={`${name(publisher)}'s phone is streaming; the console will switch to it.`} />
      )}
      {tick?.checkPhrase && <CheckInBanner phrase={tick.checkPhrase} deadlineMs={tick.checkDeadlineMs} phoneNow={phoneNow} subjectName={subjectName} />}
    </>
  );

  const left = <WaveformPanel buffers={buffers} tick={tick} />;
  const middle = (
    <View style={{ gap: 16 }}>
      <MetricsPanel tick={tick} buffers={buffers} now={now} />
      <LiveIncidentLog records={buffers.incidentList()} onPhone={buffers.incidentCountOnPhone} phoneNow={phoneNow} />
      <EventTicker events={buffers.events} />
    </View>
  );
  const right = (
    <View style={{ gap: 14 }}>
      {active.length > 1 && (
        <View style={styles.chips}>
          <Text style={styles.chipsLabel}>{active.length} open incidents</Text>
          {active.map((i) => (
            <Text key={i.id} onPress={() => setManualInc({ id: i.id, atMs: Date.now() })} style={[styles.chip, i.id === selected?.id && styles.chipOn]}>
              {name(i.user_id)} · {i.level.replace('_', ' ')}
            </Text>
          ))}
        </View>
      )}
      {selected ? (
        <IncidentPanel key={selected.id} incident={selected} group={activeGroup} profiles={profiles} me={me} mapHeight={mapHeight} now={now} />
      ) : (
        <QuietPanel devices={devices} profiles={profiles} me={me} feed={feed} now={now} />
      )}
      <View style={styles.divider} />
      <StatusRail groups={groups} members={members} profiles={profiles} presence={presence} devices={devices} me={me} now={now} active={selected} />
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <TelemetryHeader
        groupName={groupName} now={now} subjects={subjects} subjectId={subjectId} manual={manual} onPick={setPinned}
        conn={conn} tick={tick} soundOn={soundOn} onToggleSound={toggleSound} onHome={() => router.replace('/home')}
      />
      {wide ? (
        <View style={styles.columns}>
          <ScrollView style={styles.colLeft} contentContainerStyle={styles.pad}>{hints}{left}</ScrollView>
          <ScrollView style={styles.colMid} contentContainerStyle={styles.pad}>{middle}</ScrollView>
          <ScrollView style={styles.colRight} contentContainerStyle={styles.pad}>{right}</ScrollView>
        </View>
      ) : mid ? (
        <View style={styles.columns}>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.pad}>{hints}{left}{middle}</ScrollView>
          <ScrollView style={[styles.colRight, { width: 340 }]} contentContainerStyle={styles.pad}>{right}</ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.pad, { gap: 16 }]}>
          {hints}
          {left}
          {middle}
          <View style={styles.divider} />
          {right}
        </ScrollView>
      )}
      {selected && <View style={[styles.edge, { backgroundColor: levelColor(selected.level) }]} />}
    </SafeAreaView>
  );
}

function Banner({ color, label, text }: { color: string; label: string; text: string }) {
  return (
    <View style={[styles.banner, { borderColor: color }]}>
      <Pill text={label} color={color} />
      <Text style={styles.bannerText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  columns: { flex: 1, flexDirection: 'row' },
  colLeft: { flex: 5, minWidth: 380, borderRightWidth: 1, borderRightColor: colors.border },
  colMid: { flex: 4, minWidth: 320, borderRightWidth: 1, borderRightColor: colors.border },
  colRight: { width: RIGHT_W },
  pad: { padding: 14, paddingBottom: 40, gap: 12 },
  divider: { height: 1, backgroundColor: colors.border },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, backgroundColor: colors.card },
  bannerText: { color: colors.text, fontSize: 13, lineHeight: 18, flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  chipsLabel: { color: colors.muted, fontSize: 13, marginRight: 4 },
  chip: { color: colors.text, fontSize: 13, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  chipOn: { borderColor: colors.danger, color: colors.danger },
  edge: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 4 },
});
