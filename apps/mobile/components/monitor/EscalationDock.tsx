import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { Button } from '@/components/ui';
import { Map } from '@/components/Map';
import { colors } from '@/lib/theme';
import { listIncidentEvents } from '@/lib/db';
import { NO_EVENTS, useStore } from '@/lib/store';
import type { EscalationLevel, IncidentRecord } from '@/modules/safety-native';
import type { Group, Incident, Profile, Uuid } from '@/lib/types';
import { useIncidentLocation } from '@/components/incident/useIncidentLocation';
import * as actions from '@/lib/incidentActions';
import { fmtClock, fmtCountdown } from '@/components/telemetry/labels';

/** Server incident levels where friends are involved (the dock shows). */
export const ESCALATED_LEVELS = new Set<Incident['level']>(['heads_up', 'unlocked', 'snatch', 'sos', 'offline', 'battery_dying']);
/** model-v1.toml thresholds.call_option_s: "not resolved in time" once an incident is open this long. */
const OVERDUE_MS = 600_000;
const LEVEL_LABEL: Partial<Record<Incident['level'], string>> = {
  heads_up: 'Heads-up', unlocked: 'Location unlocked', snatch: 'Phone snatch', sos: 'SOS', offline: 'Phone offline', battery_dying: 'Battery dying',
};

type Props = {
  subjectId: Uuid | null;
  subjectName: string;
  /** the subject's open server incidents, newest first */
  incidents: Incident[];
  /** live engine level from telemetry (an escalation can show here before its incident row lands) */
  escalation: EscalationLevel | null;
  /** the phone's live incident log (telemetry): an active red (danger) record opens the dock at once */
  liveRecords: IncidentRecord[];
  me: Uuid | null;
  profiles: Record<Uuid, Profile>;
  groups: Group[];
  members: { group_id: Uuid; user_id: Uuid; status: string }[];
  now: number;
  /** plays the console alert sound (respects the sound toggle) */
  onAlert?: () => void;
  /** keeps the dock clear of other floating UI */
  bottom?: number;
};

/**
 * Bottom-right escalation dock on the friends' monitor. Appears and opens itself (with one beep) the moment the
 * subject has a red incident on the phone or an escalated, unresolved incident on the server, with a small map of the
 * phone's location once its keys arrive. "Not resolved in time" (the phone's call option, or open 10 min) is marked
 * on top. Every action is the friend's own call, logged to the incident timeline.
 */
export function EscalationDock(p: Props) {
  const router = useRouter();
  const incident = p.incidents.find((i) => ESCALATED_LEVELS.has(i.level)) ?? null;
  // newest active, unanswered red record on the phone (down after fall, snoring, missed check-in, grab)
  const red = useMemo(
    () => [...p.liveRecords].reverse().find((r) => r.tier === 'danger' && r.clearedMs === 0 && !r.acknowledged) ?? null,
    [p.liveRecords],
  );
  const pendingRow = !incident && (!!red || p.escalation === 'heads_up' || p.escalation === 'unlocked' || p.escalation === 'snatch');
  const events = useStore((s) => (incident ? s.events[incident.id] ?? NO_EVENTS : NO_EVENTS));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const loc = useIncidentLocation(incident?.id, p.subjectId, p.me);

  // A different incident starts clean (React's "adjust state when a prop changes" pattern, no effect).
  const [forIncident, setForIncident] = useState(incident?.id);
  if (forIncident !== incident?.id) { setForIncident(incident?.id); setAsked(false); setNotice(null); }

  // Earlier events (call_option, friend actions) for this incident; later ones stream in through the store.
  const incidentId = incident?.id;
  useEffect(() => {
    if (!incidentId) return;
    listIncidentEvents(incidentId).then((evs) => evs.forEach(useStore.getState().addEvent)).catch(() => {});
  }, [incidentId]);

  const openedMs = incident ? new Date(incident.opened_at).getTime() : 0;
  const elapsed = incident ? Math.max(0, p.now - openedMs) : 0;
  const callOption = events.some((e) => e.kind === 'call_option');
  const overdue = !!incident && (callOption || elapsed >= OVERDUE_MS);
  const tint = overdue || red || incident?.level === 'unlocked' || incident?.level === 'snatch' || incident?.level === 'sos' ? colors.danger : colors.warn;

  // Open (and beep) the moment something new shows up: a red record, then its incident row. One beep per 30 s at most,
  // so the record → incident hand-off a second later does not beep twice. Overdue opens it again once.
  const alertKey = incident ? `inc:${incident.id}${overdue ? ':overdue' : ''}` : red ? `rec:${red.id}` : pendingRow ? 'pending' : null;
  const alerted = useRef(new Set<string>());
  const lastBeep = useRef(0);
  const onAlert = p.onAlert;
  useEffect(() => {
    if (!alertKey || alerted.current.has(alertKey)) return;
    alerted.current.add(alertKey);
    setOpen(true);
    const t = Date.now();
    if (t - lastBeep.current > 30_000) { lastBeep.current = t; onAlert?.(); }
  }, [alertKey, onAlert]);

  // Pulse while overdue and collapsed.
  const [pulse] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!overdue || open) { pulse.stopAnimation(); pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
      Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [overdue, open, pulse]);

  const group = p.groups.find((g) => g.id === incident?.group_id);
  const ctx = useMemo<actions.IncidentActionContext | null>(() => (incident ? {
    incident, subjectName: p.subjectName, myName: (p.me && p.profiles[p.me]?.display_name) || 'A friend',
    friendIds: p.members.filter((m) => m.group_id === incident.group_id && m.status === 'active' && m.user_id !== p.me && m.user_id !== incident.user_id).map((m) => m.user_id),
  } : null), [incident, p.subjectName, p.me, p.profiles, p.members]);

  if (!incident && !pendingRow) return null;

  const run = (label: string, f: () => Promise<unknown>, done?: string) => async () => {
    setBusy(label); setNotice(null);
    try { await f(); if (done) setNotice(done); } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const phone = p.subjectId ? p.profiles[p.subjectId]?.phone : null;
  const info = ctx ? actions.dispatcherText(ctx, loc.last) : '';
  const redElapsed = red ? Math.max(0, p.now - red.tMs) : 0;
  const title = incident
    ? `${LEVEL_LABEL[incident.level] ?? incident.level} · ${fmtCountdown(elapsed)}`
    : red ? `${red.summary.split(':')[0] || 'Red incident'} · ${fmtCountdown(redElapsed)}` : 'Escalating…';
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });

  if (!open) {
    return (
      <Animated.View style={[styles.anchor, { bottom: p.bottom ?? 16, transform: [{ scale }] }]}>
        <Pressable onPress={() => setOpen(true)} style={[styles.fab, { borderColor: tint, backgroundColor: overdue ? colors.danger : '#1e2433' }]} testID="escalation-dock-open">
          <View style={[styles.dot, { backgroundColor: overdue ? '#fff' : tint }]} />
          <View>
            <Text style={styles.fabTitle}>{overdue ? `${p.subjectName}: not resolved` : `${p.subjectName}: ${title}`}</Text>
            <Text style={[styles.fabSub, overdue && { color: '#fff' }]}>{overdue ? `${title} · tap to act` : loc.trail.length ? 'Location shared · tap to see map & actions' : 'Escalation actions'}</Text>
          </View>
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <View style={[styles.anchor, styles.panel, { bottom: p.bottom ?? 16, borderColor: tint }]} testID="escalation-dock">
      <View style={[styles.bar, { backgroundColor: tint }]} />
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: tint }]}>{overdue ? 'Not resolved in time' : red ? 'Red incident' : 'Escalated'}</Text>
          <Text style={styles.title}>{p.subjectName} · {title}</Text>
        </View>
        <Pressable onPress={() => setOpen(false)} hitSlop={10}><Text style={styles.close}>✕</Text></Pressable>
      </View>
      {incident?.summary ? <Text style={styles.summary}>{incident.summary}</Text> : red ? <Text style={styles.summary}>{red.summary}</Text> : null}
      {!incident && <Text style={styles.meta}>Their phone is alerting the group and sharing its location…</Text>}

      {/* The phone's location, first: a small live map once its keys arrive. */}
      {loc.trail.length ? (
        <View style={{ gap: 4 }}>
          <View style={styles.map}><Map points={loc.trail} style={{ flex: 1, minHeight: 180 }} /></View>
          <Text style={styles.meta}>
            {p.subjectName}'s phone · last fix {fmtClock(loc.last!.tMs)} ({fmtCountdown(Math.max(0, p.now - loc.last!.tMs))} ago) · ±{Math.round(loc.last!.accuracyM)} m · {loc.trail.length} points
          </Text>
        </View>
      ) : loc.error ? <Text style={styles.meta}>Location keys arrived but could not be opened in this browser: {loc.error}</Text> : null}

      {incident && ctx && (
        <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ gap: 10 }}>
          {/* 1. Emergency services: the friend calls; the number and what to say are shown for desktop browsers. */}
          <View style={styles.row}>
            <Button title="Call 911" kind="danger" onPress={run('911', () => actions.call911(ctx), 'Logged: called 911. On a computer, dial 911 from your phone.')} loading={busy === '911'} style={styles.btn} />
            {group?.campus_safety_number ? (
              <Button title="Campus safety" kind="ghost" onPress={run('campus', () => actions.callCampus(ctx, group.campus_safety_number!), `Logged: called campus safety (${group.campus_safety_number}).`)} loading={busy === 'campus'} style={styles.btn} />
            ) : null}
          </View>
          <View style={styles.infoBox}>
            <Text style={styles.meta}>What to tell them</Text>
            <Text style={styles.info} selectable>{info}</Text>
            <Pressable onPress={() => void Clipboard.setStringAsync(info).then(() => setNotice('Copied.'))}><Text style={styles.link}>Copy</Text></Pressable>
          </View>

          {/* 2. Reach them */}
          <View style={styles.row}>
            <Button title={phone ? `Call ${p.subjectName}` : 'No phone number'} kind="ghost" disabled={!phone} onPress={run('call', () => actions.callPerson(ctx, phone))} style={styles.btn} />
            <Button title="Ring their phone" kind="primary" onPress={run('ring', () => actions.ringPhone(ctx), 'Ringing their phone at full volume.')} loading={busy === 'ring'} style={styles.btn} />
          </View>
          {!phone && <Text style={styles.meta}>{p.subjectName} has not added a phone number (Settings on their phone).</Text>}
          <Button title="Alert all friends" kind="ghost" onPress={run('group', () => actions.alertGroup(ctx), 'Every friend in the group got an urgent alert.')} loading={busy === 'group'} style={styles.btnFull} />

          {/* 3. Location (the map itself is at the top once keys arrive) */}
          {loc.trail.length ? null : (
            <View style={{ gap: 4 }}>
              <Button
                title={asked || loc.released ? 'Waiting for their phone…' : 'Get location'} kind="danger"
                disabled={asked && !loc.error}
                onPress={run('loc', async () => {
                  const sent = await actions.requestLocation(ctx);
                  setAsked(true);
                  if (sent !== 'ok') setNotice(`Request logged; their phone picks it up within ~2 min (live channel: ${sent}).`);
                })}
                loading={busy === 'loc'} style={styles.btnFull}
              />
              <Text style={styles.meta}>
                {asked || loc.released ? 'Their phone releases it to the group and shows them who asked.' : `Their phone shares its location with the group right away and tells ${p.subjectName} you asked.`}
              </Text>
            </View>
          )}

          {/* 4. Wrap up */}
          <View style={styles.row}>
            <Button title="I'm going" kind="ghost" onPress={run('go', () => actions.enRoute(ctx), 'The group sees you are on the way.')} loading={busy === 'go'} style={styles.btn} />
            <Button title="Found / safe" kind="ok" onPress={run('safe', () => actions.markSafe(ctx), 'Marked safe. Their phone stops alerting.')} loading={busy === 'safe'} style={styles.btn} />
          </View>
          <Pressable onPress={() => router.push(`/incident/${incident.id}`)}><Text style={styles.link}>Open full incident page →</Text></Pressable>
        </ScrollView>
      )}
      {!!notice && <Text style={styles.notice} testID="escalation-dock-notice">{notice}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', right: 16, zIndex: 60 },
  fab: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  fabTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  fabSub: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  panel: {
    width: 380, maxWidth: '92%', backgroundColor: '#1e2433', borderRadius: 14, borderWidth: 1, padding: 14, paddingLeft: 18, gap: 10, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 10,
  },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  label: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
  title: { color: colors.text, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  close: { color: colors.muted, fontSize: 16, padding: 2 },
  summary: { color: colors.text, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, paddingVertical: 10, minHeight: 0 },
  btnFull: { paddingVertical: 10, minHeight: 0 },
  infoBox: { backgroundColor: colors.card, borderRadius: 10, padding: 10, gap: 4, borderWidth: 1, borderColor: colors.border },
  info: { color: colors.text, fontSize: 13, lineHeight: 18 },
  meta: { color: colors.muted, fontSize: 12, lineHeight: 17, fontVariant: ['tabular-nums'] },
  link: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  map: { height: 180, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  notice: { color: colors.text, fontSize: 13, lineHeight: 18, backgroundColor: colors.card, borderRadius: 8, padding: 8 },
});
