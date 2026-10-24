import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Pill } from '@/components/ui';
import { activeIncidents, useStore, useUserId } from '@/lib/store';
import { subscribe } from '@/lib/db';
import type { Incident, IncidentEvent, Presence } from '@/lib/types';
import { colors, levelColor } from '@/lib/theme';
import { MonitorHeader } from '@/components/monitor/MonitorHeader';
import { StatusRail } from '@/components/monitor/StatusRail';
import { IncidentPanel } from '@/components/monitor/IncidentPanel';
import { QuietPanel } from '@/components/monitor/QuietPanel';
import { useActivityFeed, useDeviceStatus, useNow } from '@/components/monitor/useMonitorData';
import { beep, primeAudio } from '@/components/monitor/beep';

const SOUND_KEY = 'safe.monitor.sound';
const WIDE = 900;

/**
 * /monitor — the friend's desktop dashboard (laptop browser, friend role). Left: every group-mate's coarse
 * device status. Right: the newest open incident with the decrypted trail, or an "all quiet" feed.
 * Works at phone width too (columns stack). Incidents / events / presence / keys / blobs arrive over
 * realtime; device_status and audit_log are polled (see useMonitorData.ts for why).
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
  const now = useNow(1000);

  const memberIds = useMemo(() => [...new Set(members.filter((m) => m.status === 'active').map((m) => m.user_id))], [members]);
  const devices = useDeviceStatus(memberIds);
  const feed = useActivityFeed(memberIds);
  const active = useMemo(() => activeIncidents(incidents), [incidents]);

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

  // Selection: newest unresolved incident (active[] is sorted newest first). A manual pick sticks only
  // until a newer incident opens, so a fresh alert always takes the screen.
  const [manual, setManual] = useState<{ id: string; atMs: number } | null>(null);
  const newest = active[0] ?? null;
  const manualOk = manual && active.some((i) => i.id === manual.id) && (!newest || manual.atMs > new Date(newest.opened_at).getTime());
  const selected = (manualOk ? active.find((i) => i.id === manual.id) : undefined) ?? newest;

  // Beep (web only) when an incident opens after this page loaded — never for one found on refresh.
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
  const mapHeight = wide ? Math.max(360, Math.min(520, Math.round(width * 0.3))) : 300;

  const rail = (
    <StatusRail groups={groups} members={members} profiles={profiles} presence={presence} devices={devices} me={me} now={now} active={selected} />
  );
  const main = (
    <View style={{ gap: 14 }}>
      {active.length > 1 && (
        <View style={styles.chips}>
          <Text style={styles.chipsLabel}>{active.length} open incidents</Text>
          {active.map((i) => (
            <Text key={i.id} onPress={() => setManual({ id: i.id, atMs: Date.now() })} style={[styles.chip, i.id === selected?.id && styles.chipOn]}>
              {profiles[i.user_id]?.display_name ?? i.user_id.slice(0, 6)} · {i.level.replace('_', ' ')}
            </Text>
          ))}
        </View>
      )}
      {selected ? (
        <IncidentPanel key={selected.id} incident={selected} group={activeGroup} profiles={profiles} me={me} mapHeight={mapHeight} now={now} />
      ) : (
        <QuietPanel devices={devices} profiles={profiles} me={me} feed={feed} now={now} />
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <MonitorHeader groupName={groupName} now={now} soundOn={soundOn} onToggleSound={toggleSound} onHome={() => router.replace('/home')} live={!!me} />
      {!me && <View style={styles.banner}><Pill text="signed out" color={colors.warn} /><Text style={styles.bannerText}>Sign in on this browser as a group member to watch.</Text></View>}
      {wide ? (
        <View style={styles.columns}>
          <ScrollView style={styles.rail} contentContainerStyle={styles.pad}>{rail}</ScrollView>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.pad}>{main}</ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.pad, { gap: 20 }]}>
          {main}
          <View style={styles.divider} />
          {rail}
        </ScrollView>
      )}
      {selected && <View style={[styles.edge, { backgroundColor: levelColor(selected.level) }]} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  columns: { flex: 1, flexDirection: 'row' },
  rail: { width: 360, borderRightWidth: 1, borderRightColor: colors.border },
  pad: { padding: 16, paddingBottom: 40, gap: 14 },
  divider: { height: 1, backgroundColor: colors.border },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 8, backgroundColor: colors.card },
  bannerText: { color: colors.muted, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  chipsLabel: { color: colors.muted, fontSize: 13, marginRight: 4 },
  chip: { color: colors.text, fontSize: 13, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  chipOn: { borderColor: colors.danger, color: colors.danger },
  edge: { position: 'absolute', top: 0, bottom: 0, left: 0, width: 4 },
});
