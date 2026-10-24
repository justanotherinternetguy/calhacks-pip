import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import type { TelemetryTick } from '@/modules/safety-native';
import { Pill } from '@/components/ui';
import { activeIncidents, useStore, useUserId } from '@/lib/store';
import { subscribe } from '@/lib/db';
import { NO_STREAM_HINT_MS, sendTelemetryCommand, type TickDelta } from '@/lib/telemetry';
import type { Incident, IncidentEvent } from '@/lib/types';
import { colors, levelColor } from '@/lib/theme';
import { useNow } from '@/components/monitor/useMonitorData';
import { AnalysisPanel } from '@/components/monitor/AnalysisPanel';
import { ReminderToasts, toastVisible, type Toast } from '@/components/monitor/ReminderToasts';
import { escalationRank, useRiskAnalysis, type Reminder } from '@/components/monitor/useRiskAnalysis';
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
 * /monitor — the friend's desktop telemetry console (laptop browser). The subject's Android phone broadcasts
 * 10 Hz frames on a private Realtime channel (CONTRACTS §7); this page subscribes as a group-mate and draws it:
 *   left   live |a| / |ω| traces + mic listening window (canvas, rAF)
 *   middle metric band tiles, evidence line, the engine's incident log, the engine event ticker
 *   right  the AI read of the subject's incident log via OpenRouter (risk, how the incidents add up, reminders),
 *          plus pop-up reminders for the friends watching
 * Location never travels over telemetry, so it never reaches the AI either.
 */
export default function MonitorScreen() {
  const router = useRouter();
  const me = useUserId();
  const groups = useStore((s) => s.groups);
  const members = useStore((s) => s.members);
  const profiles = useStore((s) => s.profiles);
  const incidents = useStore((s) => s.incidents);
  const storeEvents = useStore((s) => s.events);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const mid = !wide && width >= MID;
  const now = useNow(500);

  const memberIds = useMemo(() => [...new Set(members.filter((m) => m.status === 'active').map((m) => m.user_id))], [members]);
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

  // Newest unresolved escalation, preferring the subject's: colours the left edge.
  const newest = active.find((i) => i.user_id === subjectId) ?? active[0] ?? null;

  // AI read of the subject's incident log. `digest` lists only what changes the picture, so the model is not
  // re-asked on every 10 Hz frame.
  const records = buffers.incidentList();
  const subjectServer = useMemo(() => active.filter((i) => i.user_id === subjectId), [active, subjectId]);
  const friendEvents = useMemo(
    () => subjectServer.flatMap((i) => storeEvents[i.id] ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-12),
    [subjectServer, storeEvents],
  );
  const escalation = tick?.escalation ?? null;
  const digest = [
    subjectId, escalation ?? '-', tick?.checkPhrase ? 'check' : '',
    records.map((r) => `${r.id}:${r.clearedMs > 0 ? 1 : 0}${r.acknowledged ? 1 : 0}${r.watched ? 1 : 0}:${r.sequenceId}`).join(','),
    subjectServer.map((i) => `${i.id}:${i.level}`).join(','),
    friendEvents.map((e) => e.id).join(','),
  ].join('|');
  const quiet = !records.length && !subjectServer.length && escalationRank(escalation) === 0 && !tick?.checkPhrase;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const ai = useRiskAnalysis({
    subjectId, digest, quiet, quietConfirmed: quiet && !!tick && tick.incidentCount === 0, escalation,
    buildInput: () => ({
      subjectName, phoneNow, tick, records, events: buffers.events, serverIncidents: subjectServer,
      friendEvents: friendEvents.map((e) => ({ ...e, actorName: name(e.actor_id) })),
    }),
    onNewReminders: (fresh: Reminder[]) => {
      setToasts((prev) => [...fresh.map((r) => ({ ...r, subjectName })), ...prev.filter((t) => toastVisible(t, Date.now()))].slice(0, 10));
      if (Platform.OS === 'web' && soundRef.current && fresh.some((r) => r.urgency === 'urgent')) beep();
    },
  });
  const dismissToast = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

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
      {me && !memberIds.length && <Banner color={colors.muted} label="no group" text="Join a group on your phone first; the console lists its members here." />}
      {notStreaming && (
        <Banner color={colors.warn} label={conn?.state === 'stale' ? 'stream stopped' : 'not streaming'}
          text={`${subjectName}'s phone is not streaming: open the app, Settings → Stream telemetry to monitor. Frames go out at 10 Hz while on (1 Hz in night mode otherwise).`} />
      )}
      {rejected && <Banner color={colors.danger} label="channel refused" text={`Could not join telemetry:${subjectId?.slice(0, 8)}… (${conn?.error ?? 'unknown'}). Only the subject and their group-mates may read it.`} />}
      {publisher && subjectId !== publisher && !manual && (
        <Banner color={colors.accent} label="publishing" text={`${name(publisher)}'s phone is streaming; the console will switch to it.`} />
      )}
      {tick?.checkPhrase && <CheckInBanner phrase={tick.checkPhrase} deadlineMs={tick.checkDeadlineMs} phoneNow={phoneNow} subjectName={subjectName} />}
    </>
  );

  // motion waveforms with the metrics-vs-baseline tiles right underneath
  // Clear incidents: any group member can clear the shown member's log (the phone resets its log + sensing too).
  const [clearNote, setClearNote] = useState<string | null>(null);
  const clearIncidents = async () => {
    if (!subjectId) return;
    const ok = Platform.OS !== 'web' || globalThis.confirm?.(`Clear every incident record of ${subjectName}, including earlier ones, and reset sensing on their phone?`);
    if (!ok) return;
    buffers.clearIncidents();
    setClearNote('Clearing…');
    const status = await sendTelemetryCommand(subjectId, 'reset_incidents').catch((e: unknown) => (e instanceof Error ? e.message : 'error'));
    setClearNote(status === 'ok' ? `Cleared here; ${subjectName}'s phone resets its log and sensing.` : `Cleared here, but the phone did not get the command (${status}).`);
    setTimeout(() => setClearNote(null), 6_000);
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
      />
      <EventTicker events={buffers.events} />
    </View>
  );
  const clearAi = () => { ai.clear(); setToasts([]); };
  const right = <AnalysisPanel state={ai} subjectName={subjectName} now={now} onRefresh={ai.refresh} onClear={clearAi} />;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <TelemetryHeader
        groupName={groupName} now={now} subjects={subjects} subjectId={subjectId} manual={manual} onPick={setPinned}
        conn={conn} tick={tick} soundOn={soundOn} onToggleSound={toggleSound} onHome={() => router.replace('/home')}
      />
      {wide ? (
        <View style={styles.columns}>
          <ScrollView style={styles.colLeft} contentContainerStyle={styles.padTight}>{hints}{left}</ScrollView>
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
      <ReminderToasts toasts={toasts} now={now} width={wide ? RIGHT_W - 28 : mid ? 312 : Math.min(width - 28, 420)} onDismiss={dismissToast} />
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
  colMid: { flex: 4, minWidth: 320, borderRightWidth: 1, borderRightColor: colors.border },
  colRight: { width: RIGHT_W },
  pad: { padding: 14, paddingBottom: 40, gap: 12 },
  padTight: { padding: 10, gap: 8 },
  divider: { height: 1, backgroundColor: colors.border },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, backgroundColor: colors.card },
  bannerText: { color: colors.text, fontSize: 13, lineHeight: 18, flex: 1 },
  edge: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 4 },
});
