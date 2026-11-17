import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { isCheckPending, type TelemetryTick } from '@/modules/safety-native';
import { Pill } from '@/components/ui';
import { activeIncidents, useStore, useUserId } from '@/lib/store';
import { rpc, subscribe } from '@/lib/db';
import { NO_STREAM_HINT_MS, sendTelemetryCommand, type TickDelta } from '@/lib/telemetry';
import type { Incident, IncidentEvent } from '@/lib/types';
import { colors, levelColor } from '@/lib/theme';
import { SIM_FRIENDS, isSimId } from '@/lib/sim';
import { isSimulatedUser } from '@/lib/telemetry';
import { useNow } from '@/components/monitor/useMonitorData';
import { EscalationDock } from '@/components/monitor/EscalationDock';
import { useOkConfirmations } from '@/components/monitor/okConfirmations';
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
const WIDE = 900; // two columns: telemetry | incident log
const BEEP_RECORD_AGE_MS = 30_000;

/**
 * /monitor — the friend's desktop telemetry console (laptop browser). The subject's Android phone broadcasts
 * 10 Hz frames on a private Realtime channel (CONTRACTS §7); this page subscribes as a group-mate and draws it:
 *   left   live |a| / |ω| traces + mic listening window (canvas, rAF)
 *   right  the engine's incident log, "I'm OK" confirmations, the engine event ticker
 * Everything shown comes from the phone's Rust engine; this page only draws it.
 */
export default function MonitorScreen() {
  const router = useRouter();
  const me = useUserId();
  const groups = useStore((s) => s.groups);
  const members = useStore((s) => s.members);
  const profiles = useStore((s) => s.profiles);
  const incidents = useStore((s) => s.incidents);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const now = useNow(500);

  // Everyone is public on the map, simulated friends included; `?subject=` picks who is on screen.
  const params = useLocalSearchParams<{ subject?: string }>();
  const memberIds = useMemo(
    () => [...new Set([...(me ? [me] : []), ...members.filter((m) => m.status === 'active').map((m) => m.user_id), ...SIM_FRIENDS.map((f) => f.id)])],
    [members, me],
  );
  const active = useMemo(() => activeIncidents(incidents), [incidents]);
  const name = useCallback((id: string | null | undefined) => (
    !id ? 'Nobody' : isSimId(id) ? SIM_FRIENDS.find((f) => f.id === id)?.name ?? 'Friend' : profiles[id]?.display_name || `Friend ${id.slice(0, 6)}`
  ), [profiles]);

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
  const [picked, setPinned] = useState<string | null>(null);
  const pinned = picked ?? (typeof params.subject === 'string' ? params.subject : null);
  const fallback = memberIds.find((id) => id !== me && !isSimulatedUser(id)) ?? memberIds.find((id) => !isSimulatedUser(id)) ?? memberIds.find((id) => id !== me) ?? null;
  const { subjectId, manual, buffers, tick, conn, seen, publisher } = useTelemetryFleet(memberIds, { manual: pinned, fallback, preferNot: me, onDelta });
  const subjects: SubjectOption[] = memberIds.map((id) => ({ id, name: name(id), isMe: id === me, publishing: !!seen[id] && now - seen[id].at < PUBLISHING_MS }));
  const subjectName = name(subjectId);
  const phoneNow = tick && buffers.lastTickAt ? tick.t + (now - buffers.lastTickAt) : now;

  // Newest unresolved escalation, preferring the subject's: colours the left edge.
  const newest = active.find((i) => i.user_id === subjectId) ?? active[0] ?? null;

  const records = buffers.incidentList();
  const subjectServer = useMemo(() => active.filter((i) => i.user_id === subjectId), [active, subjectId]);
  const escalation = tick?.escalation ?? null;
  // "I'm OK" confirmations (answered check-in / tapped I'm okay), shown in the incident list.
  const { list: confirmations, clear: clearConfirmations } = useOkConfirmations(subjectId, buffers.events);

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
      subscribe('incidents', undefined, (row: Incident, ev) => (ev === 'DELETE' ? st.removeIncident(row.id) : st.upsertIncident(row))),
      subscribe('incident_events', undefined, (row: IncidentEvent, ev) => { if (ev === 'INSERT') st.addEvent(row); }),
    ];
    return () => chans.forEach((c) => c.unsubscribe());
  }, [me]);

  const groupName = groups.length ? groups.map((g) => g.name).join(' · ') : 'No group';

  // Hints: subscribed but silent for 10 s, or the stream stopped.
  const silentFor = conn?.state === 'subscribed' && conn.subscribedAt ? now - conn.subscribedAt : conn?.state === 'stale' && conn.lastTickAt ? now - conn.lastTickAt : 0;
  const notStreaming = !!subjectId && silentFor > NO_STREAM_HINT_MS;
  const rejected = conn?.state === 'error' && conn.attempts >= 2;

  const hints = (
    <>
      {!me && <Banner color={colors.warn} label="signed out" text="Sign in on this browser as a group member to watch." />}
      {me && !memberIds.length && <Banner color={colors.muted} label="no group" text="Join a group on your phone first. The console lists its members here." />}
      {notStreaming && (
        <Banner color={colors.warn} label={conn?.state === 'stale' ? 'stream stopped' : 'not streaming'}
          text={`${subjectName}'s phone isn't streaming. On that phone, turn on Settings → Stream telemetry. It sends 10 Hz frames with that on, and 1 Hz frames in night mode without it.`} />
      )}
      {rejected && <Banner color={colors.danger} label="channel refused" text={`Could not join telemetry:${subjectId?.slice(0, 8)}… (${conn?.error ?? 'unknown'}). Only the subject and their group-mates may read it.`} />}
      {publisher && subjectId !== publisher && !manual && (
        <Banner color={colors.accent} label="publishing" text={`${name(publisher)}'s phone is streaming. The console will switch to it.`} />
      )}
      {isCheckPending(tick) && <CheckInBanner summary={tick?.checkSummary} deadlineMs={tick?.checkDeadlineMs} phoneNow={phoneNow} subjectName={subjectName} />}
    </>
  );

  // motion waveforms with the metrics-vs-baseline tiles right underneath
  // Delete all: any group member can wipe the shown member's incidents. It deletes the server rows for good
  // (purge_incidents), empties the phone's log and resets its sensing.
  const [clearNote, setClearNote] = useState<string | null>(null);
  const clearIncidents = async () => {
    if (!subjectId) return;
    const ok = Platform.OS !== 'web' || globalThis.confirm?.(
      `Delete all of ${subjectName}'s incidents for good? This removes them from the server, empties the log on their phone and resets its sensing. You can't undo it.`,
    );
    if (!ok) return;
    buffers.clearIncidents();
    clearConfirmations();
    setClearNote('Deleting…');
    const why = (e: unknown) => (e instanceof Error ? e.message : 'error');
    const [server, phone] = await Promise.all([
      isSimId(subjectId)
        ? Promise.resolve<number | string>(0)
        : rpc.purgeIncidents(subjectId).then(
          (n) => {
            const st = useStore.getState();
            st.incidents.filter((i) => i.user_id === subjectId).forEach((i) => st.removeIncident(i.id));
            return n;
          },
          why,
        ),
      sendTelemetryCommand(subjectId, 'reset_incidents').catch(why),
    ]);
    const parts = [
      typeof server === 'number' ? `Deleted ${server} incident${server === 1 ? '' : 's'} from the server.` : `Server delete failed (${server}).`,
      phone === 'ok' ? `${subjectName}'s phone empties its log and resets sensing.` : `The phone did not get the reset (${phone}).`,
    ];
    setClearNote(parts.join(' '));
    setTimeout(() => setClearNote(null), 8_000);
  };
  const left = (
    <View style={{ gap: 8 }}>
      <WaveformPanel buffers={buffers} tick={tick} />
      <MetricsPanel tick={tick} buffers={buffers} now={now} />
    </View>
  );
  const middle = (
    <View style={{ gap: 16 }}>
      <LiveIncidentLog
        records={buffers.incidentList()} onPhone={buffers.incidentCountOnPhone} phoneNow={phoneNow}
        onClear={subjectId ? () => void clearIncidents() : undefined}
        clearNote={clearNote ?? undefined}
        confirmations={confirmations}
      />
      <EventTicker events={buffers.events} now={phoneNow} />
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <TelemetryHeader
        groupName={groupName} now={now} subjects={subjects} subjectId={subjectId} manual={manual} onPick={setPinned}
        conn={conn} tick={tick} soundOn={soundOn} onToggleSound={toggleSound} onHome={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
        links={[{ label: 'Collect data', onPress: () => router.push(subjectId ? { pathname: '/collect', params: { subject: subjectId } } : '/collect') }]}
      />
      {wide ? (
        <View style={styles.columns}>
          <ScrollView style={styles.colLeft} contentContainerStyle={styles.padTight}>{hints}{left}</ScrollView>
          <ScrollView style={styles.colMid} contentContainerStyle={styles.pad}>{middle}</ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.pad, { gap: 16 }]}>
          {hints}
          {left}
          {middle}
        </ScrollView>
      )}
      <EscalationDock
        subjectId={subjectId} subjectName={subjectName} incidents={subjectServer} escalation={escalation} liveRecords={records}
        me={me} profiles={profiles} groups={groups} members={members} now={now}
        onAlert={() => { if (Platform.OS === 'web' && soundRef.current) beep(); }}
      />
      {newest && <View style={[styles.edge, { backgroundColor: levelColor(newest.level) }]} />}
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
  colMid: { flex: 4, minWidth: 320 },
  pad: { padding: 14, paddingBottom: 40, gap: 12 },
  padTight: { padding: 10, gap: 8 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, backgroundColor: colors.card },
  bannerText: { color: colors.text, fontSize: 13, lineHeight: 18, flex: 1 },
  edge: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 4 },
});
