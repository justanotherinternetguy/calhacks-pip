import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, Input, Pill } from '@/components/ui';
import { useStore, useUserId } from '@/lib/store';
import { NO_STREAM_HINT_MS, isSimulatedUser } from '@/lib/telemetry';
import { colors, radius } from '@/lib/theme';
import { SIM_FRIENDS, isSimId } from '@/lib/sim';
import { useNow } from '@/components/monitor/useMonitorData';
import { TelemetryHeader, type SubjectOption } from '@/components/telemetry/TelemetryHeader';
import { WaveformPanel } from '@/components/telemetry/WaveformPanel';
import { MetricsPanel } from '@/components/telemetry/MetricsPanel';
import { PUBLISHING_MS, useTelemetryFleet } from '@/components/telemetry/useTelemetry';
import { fmtCountdown, kindLabel, tierColor } from '@/components/telemetry/labels';
import { ActionPad } from '@/components/collect/ActionPad';
import { CalibrationPanel } from '@/components/collect/CalibrationPanel';
import { SessionsPanel } from '@/components/collect/SessionsPanel';
import { actionDef, actionTitle, placementFromLabel, placementLabel, shortcut, type PlacementChoice } from '@/components/collect/actions';
import { downloadJson } from '@/components/collect/download';
import { recordingFileName, toRecording } from '@/components/collect/export';
import { labelAt, type CollectSession } from '@/components/collect/session';
import { useCollect } from '@/components/collect/useCollect';

const WIDE = 1000;
/** Raw samples older than this while recording: the phone is not sending them. */
const RAW_STALE_MS = 5_000;
/** Grace after Start before "the phone is not collecting" shows. */
const START_GRACE_MS = 10_000;

const randomId = () => `p-${Math.random().toString(36).slice(2, 6)}`;
const mmss = (ms: number) => fmtCountdown(Math.max(0, ms));

/**
 * /collect: labelled motion-data collection (laptop browser). The operator picks the action the person holding the
 * phone is doing; the page records the phone's raw 50 Hz motion and the engine's per-second metrics with those labels
 * (IndexedDB), exports a tools/collect Recording, and replays the unsteady-walking rule with other thresholds.
 * Detection stays on the phone: nothing here feeds back into it.
 */
export default function CollectScreen() {
  const router = useRouter();
  const me = useUserId();
  const groups = useStore((s) => s.groups);
  const members = useStore((s) => s.members);
  const profiles = useStore((s) => s.profiles);
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const now = useNow(500);

  const params = useLocalSearchParams<{ subject?: string }>();
  const memberIds = useMemo(
    () => [...new Set([...(me ? [me] : []), ...members.filter((m) => m.status === 'active').map((m) => m.user_id), ...SIM_FRIENDS.map((f) => f.id)])],
    [members, me],
  );
  const name = useCallback((id: string | null | undefined) => (
    !id ? 'Nobody' : isSimId(id) ? SIM_FRIENDS.find((f) => f.id === id)?.name ?? 'Friend' : profiles[id]?.display_name || `Friend ${id.slice(0, 6)}`
  ), [profiles]);

  // Subject: locked while recording, else pinned, else the publishing phone (as on the monitor).
  const [locked, setLocked] = useState<string | null>(null);
  const [picked, setPinned] = useState<string | null>(null);
  const pinned = locked ?? picked ?? (typeof params.subject === 'string' ? params.subject : null);
  const fallback = memberIds.find((id) => id !== me && !isSimulatedUser(id)) ?? memberIds.find((id) => !isSimulatedUser(id)) ?? memberIds.find((id) => id !== me) ?? null;
  const { subjectId, manual, buffers, tick, conn, seen } = useTelemetryFleet(memberIds, { manual: pinned, fallback, preferNot: me });
  const subjects: SubjectOption[] = memberIds.map((id) => ({ id, name: name(id), isMe: id === me, publishing: !!seen[id] && now - seen[id].at < PUBLISHING_MS }));
  const subjectName = name(subjectId);
  const phoneNow = tick && buffers.lastTickAt ? tick.t + (now - buffers.lastTickAt) : now;
  const collect = tick?.collect;
  const simulated = !!subjectId && isSimulatedUser(subjectId);

  const col = useCollect(subjectId);
  const rec = col.recorder;
  const recording = col.recording;
  const session = rec?.session ?? null;

  // Setup
  const [participant, setParticipant] = useState(randomId);
  const [notes, setNotes] = useState('');
  const [placement, setPlacement] = useState<PlacementChoice>('pocket');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const currentAction = recording && rec ? rec.currentAction() : pendingAction;
  const currentPlacement = recording && rec ? placementFromLabel(rec.currentPlacement()) : placement;

  const pickAction = useCallback((label: string) => { if (!col.setAction(label)) setPendingAction(label); }, [col]);
  const pickPlacement = useCallback((p: PlacementChoice) => { if (!col.setPlacement(placementLabel(p))) setPlacement(p); }, [col]);

  const silentFor = conn?.state === 'subscribed' && conn.subscribedAt ? now - conn.subscribedAt : conn?.state === 'stale' && conn.lastTickAt ? now - conn.lastTickAt : 0;
  const notStreaming = !!subjectId && (silentFor > NO_STREAM_HINT_MS || conn?.state === 'error' || conn?.state === 'closed');
  const streaming = conn?.state === 'live';
  const canStart = !!subjectId && streaming && !!collect?.allowed && !recording;

  const start = async () => {
    if (!subjectId || !canStart) return;
    setLocked(subjectId);
    await col.start({ subjectId, subjectName, participant, notes, placement, action: pendingAction });
  };
  const stop = async () => {
    await col.stop();
    setLocked(null);
  };
  const resume = async (s: CollectSession) => {
    setLocked(s.subjectId);
    setPlacement(placementFromLabel(s.placements.at(-1)?.label) ?? 'pocket');
    await col.resume(s);
  };

  // Keyboard shortcuts (web): number / letter keys pick an action or the placement; ignored while typing.
  const keyRef = useRef({ pickAction, pickPlacement });
  useEffect(() => { keyRef.current = { pickAction, pickPlacement }; }, [pickAction, pickPlacement]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const w = globalThis as unknown as Window;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el?.isContentEditable) return;
      const s = shortcut(e.key);
      if (!s) return;
      e.preventDefault();
      if ('action' in s) keyRef.current.pickAction(s.action);
      else keyRef.current.pickPlacement(s.placement);
    };
    w.addEventListener?.('keydown', onKey);
    return () => w.removeEventListener?.('keydown', onKey);
  }, []);

  // Sessions and analysis scope
  const [openId, setOpenId] = useState<string | null>(null);
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const [listNote, setListNote] = useState<string | null>(null);
  const opened = col.sessions.find((s) => s.id === openId) ?? null;
  const scoped = useMemo(() => (scope === 'all' ? col.sessions : opened ? [opened] : session ? [session] : []), [scope, col.sessions, opened, session]);
  const scopeLabel = scope === 'all' ? `all ${col.sessions.length} saved sessions` : opened ? `${opened.participant}'s session` : session ? 'this session' : 'no session';
  const version = scoped.map((s) => `${s.id}:${s.metrics.length}:${s.actions.length}:${s.actions.at(-1)?.label ?? ''}:${s.status}`).join(',');

  const download = (s: CollectSession) => {
    const res = downloadJson(recordingFileName(s), toRecording(s));
    if (res !== 'ok') setListNote(res);
  };
  const downloadAll = () => {
    col.sessions.forEach((s, i) => setTimeout(() => download(s), i * 400));
  };
  const remove = async (s: CollectSession) => {
    const ok = Platform.OS !== 'web' || globalThis.confirm?.(`Delete ${s.participant || 'anon'}'s session from this browser? Download it first if you need it.`);
    if (!ok) return;
    const res = await col.remove(s.id);
    if (openId === s.id) setOpenId(null);
    setListNote(res === 'ok' ? 'Deleted.' : res);
  };

  // Live numbers
  const stats = rec?.stats();
  const pNow = rec?.phoneNow(now) ?? phoneNow;
  const actStart = rec?.currentActionStart() ?? null;
  const def = actionDef(currentAction);
  const echoOk = !!currentAction && collect?.label === currentAction;
  const rawStale = recording && (!rec?.lastSampleAt || now - rec.lastSampleAt > RAW_STALE_MS);
  const sessionAge = session ? now - session.createdAt : 0;
  const incidents = useMemo(() => [...(session?.incidents ?? [])].sort((a, b) => b.tMs - a.tMs), [session, session?.incidents.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupName = groups.length ? groups.map((g) => g.name).join(' · ') : 'No group';
  const hints = (
    <>
      {Platform.OS !== 'web' && <Banner color={colors.warn} label="laptop tool" text="Data collection is meant for the web build on a laptop. Downloads and saved sessions need a browser." />}
      {!me && <Banner color={colors.warn} label="signed out" text="Sign in on this browser as a group member." />}
      {notStreaming && <Banner color={colors.warn} label="not streaming" text={`${subjectName}'s phone isn't streaming. On that phone, turn on Settings → Stream telemetry.`} />}
      {streaming && tick && !collect?.on && !simulated && tick.sampleHz > 0 && tick.sampleHz < 40 && <Banner color={colors.warn} label="low rate" text={`${subjectName}'s phone streams reduced data (${Math.round(tick.sampleHz)} samples/s, 1 frame/s), so the live view looks smoothed. On the phone, turn on Settings → Stream telemetry. A recording session switches the phone to full rate by itself.`} />}
      {streaming && tick && !collect && !simulated &&<Banner color={colors.warn} label="older build" text={`${subjectName}'s phone runs a build without data collection. Update the app on the phone.`} />}
      {simulated && <Banner color={colors.muted} label="simulated" text={`${subjectName} is simulated. There is no phone to record from.`} />}
      {streaming && collect && !collect.allowed && <Banner color={colors.warn} label="not allowed" text="On the phone: Settings → Allow data collection." />}
      {recording && collect && !collect.on && sessionAge > START_GRACE_MS && <Banner color={colors.danger} label="phone stopped" text="The phone is not collecting. Press Resend start, or check Settings on the phone." />}
      {recording && rawStale && sessionAge > START_GRACE_MS && <Banner color={colors.danger} label="no samples" text="No raw samples for 5 s. Check the phone still shows the collection notification." />}
      {collect?.demo && <Banner color={colors.warn} label="demo thresholds" text="The phone runs demo sensitivity. Incidents in this session use the lenient thresholds." />}
    </>
  );

  const statusCard = (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Phone</Text>
      <View style={styles.kvs}>
        <KV k="Subject" v={subjectName} />
        <KV k="Streaming" v={streaming ? 'yes' : conn ? conn.state : 'no'} tone={streaming ? 'ok' : 'warn'} />
        <KV k="Collection allowed" v={simulated ? 'simulated' : !collect ? (tick ? 'older build' : '-') : collect.allowed ? 'yes' : 'no'} tone={collect?.allowed ? 'ok' : 'warn'} />
        <KV k="Collecting" v={collect?.on ? 'yes' : 'no'} tone={collect?.on ? 'ok' : undefined} />
        <KV k="Stops in" v={collect?.on && collect.untilMs > 0 ? mmss(collect.untilMs - phoneNow) : '-'} />
        <KV k="Thresholds" v={collect ? (collect.demo ? 'demo' : 'normal') : '-'} tone={collect?.demo ? 'warn' : undefined} />
      </View>
    </View>
  );

  const setupCard = (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Session</Text>
      <View style={styles.formRow}>
        <View style={styles.field}>
          <Text style={styles.label}>Participant ID</Text>
          <Input value={recording ? session?.participant ?? participant : participant} onChangeText={setParticipant} editable={!recording} autoCapitalize="none" style={styles.input} />
        </View>
        <View style={[styles.field, { flex: 2 }]}>
          <Text style={styles.label}>Notes</Text>
          <Input value={recording ? session?.notes ?? notes : notes} onChangeText={setNotes} editable={!recording} placeholder="Shoes, floor, anything odd" style={styles.input} />
        </View>
      </View>
      <View style={styles.controls}>
        {!recording ? (
          <Button title="Start recording" kind="ok" onPress={() => void start()} disabled={!canStart} testID="collect-start" />
        ) : (
          <>
            <Button title="Stop and save" kind="danger" onPress={() => void stop()} testID="collect-stop" />
            <Button title="Resend start" kind="ghost" onPress={() => void col.resend()} />
          </>
        )}
        <View style={{ flex: 1, minWidth: 160, gap: 2 }}>
          {!recording && !canStart && <Text style={styles.meta}>{!subjectId ? 'Pick a subject.' : !streaming ? 'Waiting for the phone to stream.' : simulated ? 'Simulated people have no phone.' : !collect ? 'This phone cannot collect.' : !collect.allowed ? 'Collection is off on the phone.' : ''}</Text>}
          {!recording && canStart && <Text style={styles.meta}>Pick the first action, then start. Keys work too.</Text>}
          {col.cmdNote && <Text style={[styles.meta, { color: col.cmdNote.ok ? colors.muted : colors.danger }]}>{col.cmdNote.text} · {Math.round((now - col.cmdNote.at) / 1000)} s ago</Text>}
          {col.saveNote && recording && <Text style={[styles.meta, { color: col.saveNote.ok ? colors.muted : colors.danger }]}>{col.saveNote.text} {Math.round((now - col.saveNote.at) / 1000)} s ago</Text>}
        </View>
      </View>
    </View>
  );

  const livePanel = (
    <View style={[styles.card, recording && { borderColor: colors.danger }]}>
      <View style={styles.liveHead}>
        {recording ? <Pill text="recording" color={colors.danger} /> : <Pill text="not recording" color={colors.muted} />}
        {recording && currentAction && <Text style={[styles.meta, echoOk && { color: colors.ok }]}>{echoOk ? '✓ phone has this label' : collect?.label ? `phone shows ${actionTitle(collect.label)}` : 'sending label…'}</Text>}
      </View>
      <Text style={styles.now} numberOfLines={1}>{actionTitle(currentAction)}</Text>
      <Text style={styles.instruction}>{def?.instruction ?? 'Pick an action below.'}</Text>
      <View style={styles.kvs}>
        <KV k="In this action" v={recording && actStart != null ? mmss(pNow - actStart) : '-'} big />
        <KV k="Session" v={stats ? mmss(stats.durationMs) : '-'} big />
        <KV k="Samples" v={stats ? stats.samples.toLocaleString() : '-'} />
        <KV k="Rate" v={stats && stats.durationMs > 2_000 ? `${stats.hz.toFixed(1)} Hz` : '-'} />
        <KV k="Gaps" v={stats ? `${stats.sampleGaps} samples · ${stats.frameGaps} frames` : '-'} tone={stats && stats.sampleGaps + stats.frameGaps > 0 ? 'warn' : undefined} />
        <KV k="Lost" v={stats ? `${(stats.lostMs / 1000).toFixed(1)} s` : '-'} />
        <KV k="Placement" v={currentPlacement ?? '-'} />
      </View>
    </View>
  );

  const incidentList = (
    <View style={styles.card}>
      <View style={styles.liveHead}>
        <Text style={styles.cardTitle}>Incidents this session</Text>
        <Text style={styles.meta}>rules run, nothing escalates</Text>
      </View>
      {!incidents.length && <Text style={styles.meta}>None yet.</Text>}
      {incidents.slice(0, 40).map((r) => {
        const at = session?.t0 != null ? mmss(r.tMs - session.t0) : '-';
        const label = session ? labelAt(session.actions, r.tMs) : null;
        return (
          <View key={`${r.id}:${r.tMs}`} style={styles.incident}>
            <Text style={styles.incTime}>{at}</Text>
            <Pill text={kindLabel(r.kind)} color={tierColor(r.tier)} />
            <Pill text={actionTitle(label)} color={colors.accent} />
            <Text style={styles.incText} numberOfLines={2}>{r.summary}</Text>
          </View>
        );
      })}
    </View>
  );

  const left = (
    <View style={{ gap: 12 }}>
      {statusCard}
      {setupCard}
      <View style={styles.card}>
        <ActionPad current={currentAction} onPick={pickAction} placement={currentPlacement} onPlacement={pickPlacement} showKeys={Platform.OS === 'web'} />
      </View>
    </View>
  );
  const right = (
    <View style={{ gap: 12 }}>
      {livePanel}
      <WaveformPanel buffers={buffers} tick={tick} />
      <MetricsPanel tick={tick} buffers={buffers} now={now} />
      {incidentList}
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <TelemetryHeader
        kicker="Data collection" groupName={groupName} now={now} subjects={subjects} subjectId={subjectId} manual={manual}
        onPick={(id) => { if (!recording) setPinned(id); }}
        conn={conn} tick={tick}
        onHome={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
        links={[{ label: 'Monitor', onPress: () => router.push('/monitor') }]}
      />
      <ScrollView contentContainerStyle={styles.pad}>
        {hints}
        {wide ? (
          <View style={styles.columns}>
            <View style={{ flex: 5, minWidth: 0 }}>{left}</View>
            <View style={{ flex: 4, minWidth: 0 }}>{right}</View>
          </View>
        ) : (
          <View style={{ gap: 12 }}>{right}{left}</View>
        )}
        <SessionsPanel
          sessions={col.sessions} activeId={session?.id ?? null} openId={openId} canResume={!recording}
          onOpen={(id) => { setOpenId(id); if (id) setScope('open'); }} onDownload={download} onDownloadAll={downloadAll}
          onDelete={(s) => void remove(s)} onResume={(s) => void resume(s)} note={listNote}
        />
        <View style={styles.scope}>
          <Text style={styles.cardTitle}>Calibration</Text>
          <Seg label={opened ? 'Opened session' : 'This session'} on={scope === 'open'} onPress={() => setScope('open')} />
          <Seg label="All saved sessions" on={scope === 'all'} onPress={() => setScope('all')} />
        </View>
        <CalibrationPanel sessions={scoped} version={version} scopeLabel={scopeLabel} />
      </ScrollView>
    </SafeAreaView>
  );
}

function KV({ k, v, tone, big }: { k: string; v: string; tone?: 'ok' | 'warn'; big?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={[styles.kvVal, big && styles.kvBig, tone === 'ok' && { color: colors.ok }, tone === 'warn' && { color: colors.warn }]} numberOfLines={1}>{v}</Text>
    </View>
  );
}

function Seg({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }}
      style={({ pressed }) => [styles.seg, on && { borderColor: colors.accent }, pressed && { opacity: 0.7 }]}>
      <Text style={[styles.segText, on && { color: colors.accent }]}>{label}</Text>
    </Pressable>
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
  pad: { padding: 14, paddingBottom: 60, gap: 12 },
  columns: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  card: { gap: 10, padding: 14, borderRadius: radius, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 12, flexShrink: 1 },
  kvs: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18, rowGap: 8 },
  kv: { minWidth: 110, gap: 2 },
  kvKey: { color: colors.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  kvVal: { color: colors.text, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  kvBig: { fontSize: 22, fontWeight: '800' },
  formRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  field: { flex: 1, minWidth: 180, gap: 4 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  input: { paddingVertical: 9, fontSize: 14, borderRadius: 12 },
  controls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  liveHead: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  now: { color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.5 },
  instruction: { color: colors.text, fontSize: 20, lineHeight: 27, fontWeight: '600' },
  incident: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border },
  incTime: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'], width: 44 },
  incText: { color: colors.text, fontSize: 12, flex: 1, minWidth: 160 },
  scope: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 },
  seg: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  segText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, borderWidth: 1, backgroundColor: colors.card },
  bannerText: { color: colors.text, fontSize: 13, lineHeight: 18, flex: 1 },
});
