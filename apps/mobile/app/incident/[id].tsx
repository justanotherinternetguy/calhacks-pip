import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Svg, { Path, Rect } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { format, formatDistanceToNow } from 'date-fns';
import { Btn, Caps, Card, D, Icon, IconBtn, Mono, T, Well } from '@/components/pip/kit';
import { Map } from '@/components/Map';
import { SafetyNative, type DecryptedLocation } from '@/modules/safety-native';
import { MIN_MEMBERS_FOR_FALLBACK, NO_EVENTS, useStore, useUserId } from '@/lib/store';
import {
  fn, getActiveEpoch, getIncident, listIncidentEvents, listLocationBlobs,
  listUnlockApprovals, listUnlockRequests, rpc, subscribe,
} from '@/lib/db';
import type { Incident, IncidentEventKind, UnlockApproval, UnlockRequest } from '@/lib/types';
import { ht, ui } from '@/lib/theme';
import { EVENT_LABEL } from '@/components/monitor/labels';
import { useIncidentLocation } from '@/components/incident/useIncidentLocation';
import * as actions from '@/lib/incidentActions';

export default function IncidentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useUserId();
  const profiles = useStore((s) => s.profiles);
  const groups = useStore((s) => s.groups);
  const members = useStore((s) => s.members);
  const stored = useStore((s) => s.incidents.find((i) => i.id === id));
  const events = useStore((s) => s.events[id] ?? NO_EVENTS);
  const [incident, setIncident] = useState<Incident | undefined>(stored);
  const [recovered, setRecovered] = useState<DecryptedLocation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [req, setReq] = useState<UnlockRequest | null>(null);
  const [approvals, setApprovals] = useState<UnlockApproval[]>([]);
  const [k, setK] = useState(2);
  const [busy, setBusy] = useState<string | null>(null);
  /** friend actions taken from this screen (their buttons turn butter, as on the site) */
  const [done, setDone] = useState<string[]>([]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));

  const subject = incident?.user_id;
  const subjectName = subject ? profiles[subject]?.display_name ?? 'Your friend' : '';
  const group = groups.find((g) => g.id === incident?.group_id);
  const isSubject = subject === me;
  const resolved = !!incident?.resolved_at || incident?.level === 'resolved';
  // §6 Groups: fallback unlock needs ≥ 3 active members (the server enforces it too in open_unlock_request).
  const activeMembers = members.filter((m) => m.group_id === incident?.group_id && m.status === 'active').length;
  const fallbackAllowed = activeMembers >= MIN_MEMBERS_FOR_FALLBACK;
  const offlineLevel = incident?.level === 'offline' || incident?.level === 'battery_dying';

  // Normal unlock path: keys the phone released to me (shared hook, live). Fallback unlock fills `recovered`.
  const loc = useIncidentLocation(id, subject, me);
  const trail = recovered.length ? recovered : loc.trail;

  useEffect(() => {
    if (!id || !me) return;
    getIncident(id).then(setIncident).catch(() => {});
    listIncidentEvents(id).then((evs) => evs.forEach(useStore.getState().addEvent)).catch(() => {});
    listUnlockRequests(id).then((rs) => setReq(rs.find((r) => r.status !== 'denied') ?? null)).catch(() => {});
    const chans = [
      subscribe('incidents', `id=eq.${id}`, (row) => setIncident(row)),
      subscribe('unlock_requests', `incident_id=eq.${id}`, (row) => setReq(row)),
    ];
    return () => chans.forEach((c) => c.unsubscribe());
  }, [id, me]);

  // Fallback unlock: watch approvals; when ≥k, recover K_day and decrypt.
  useEffect(() => {
    if (!req || !subject) return;
    listUnlockApprovals(req.id).then(setApprovals).catch(() => {});
    const ch = subscribe('unlock_approvals', `request_id=eq.${req.id}`, (row) => setApprovals((a) => (a.some((x) => x.id === row.id) ? a : [...a, row])));
    return () => { ch.unsubscribe(); };
  }, [req, subject]);
  useEffect(() => {
    if (!req || !subject || req.requester_id !== me || approvals.length < k || trail.length) return;
    (async () => {
      const r = await SafetyNative.recoverFromShares({ subjectUserId: subject, epochId: req.epoch_id, sealedShares: approvals.map((a) => ({ sealedB64: a.sealed_share, approverEd25519Pub: a.approver_ed25519_pub })) });
      if (!r.ok) return;
      const blobs = await listLocationBlobs(subject, req.epoch_id);
      const pts = await SafetyNative.decryptLocations(subject, blobs.map((b) => ({ epochId: b.epoch_id, seq: Number(b.seq), hourIndex: b.hour_index, ciphertextB64: b.ciphertext })));
      setRecovered(pts.sort((a, b) => a.tMs - b.tMs));
    })().catch((e) => setNotice(`Recovery failed: ${e.message}`));
  }, [approvals, k, req, subject, me, trail.length]);

  // Errors and confirmations show inline (Alert.alert is a no-op on web).
  const act = (label: string, f: () => Promise<unknown>, done?: string) => async () => {
    setBusy(label); setNotice(null);
    try { await f(); if (done) setNotice(done); } catch (e: any) { setNotice(e?.message ?? String(e)); } finally { setBusy(null); }
  };
  const event = (kind: IncidentEventKind, payload: Record<string, unknown> = {}) => rpc.addIncidentEvent({ incident_id: id, kind, payload });
  const ctx = useMemo<actions.IncidentActionContext | null>(() => (incident ? {
    incident, subjectName, myName: (me && profiles[me]?.display_name) || 'A friend',
    friendIds: members.filter((m) => m.group_id === incident.group_id && m.status === 'active' && m.user_id !== me && m.user_id !== incident.user_id).map((m) => m.user_id),
  } : null), [incident, subjectName, me, profiles, members]);
  const ring = act('ring', () => actions.ringPhone(ctx!), 'Ringing their phone.');
  const call = act('call', () => actions.callPerson(ctx!, subject ? profiles[subject]?.phone : null));
  const going = act('en_route', () => actions.enRoute(ctx!), 'Logged: you are on the way.');
  const found = act('found', () => (isSubject ? event('found').then(() => rpc.resolveIncident(id)) : actions.markSafe(ctx!)), 'Marked safe.');
  const requestUnlock = act('unlock', async () => {
    if (!subject || !incident) return;
    const epoch = await getActiveEpoch(subject, incident.group_id);
    if (!epoch) throw new Error('No active epoch for this friend');
    // Server checks the incident is offline/battery_dying (refuses otherwise), then we open the request row.
    const res = await fn.unlock({ incidentId: id });
    setK(res.k ?? epoch.k ?? group?.threshold_k ?? 2);
    const existing = (await listUnlockRequests(id)).find((r) => r.status === 'open');
    if (existing) setReq(existing);
    else {
      const rid = await rpc.openUnlockRequest(id);
      setReq({ id: rid, incident_id: id, requester_id: me!, epoch_id: epoch.id, status: 'open', created_at: new Date().toISOString() });
    }
    await event('unlock_requested');
  });

  const last = trail[trail.length - 1];
  const infoText = useMemo(() => (incident ? actions.dispatcherText({ subjectName, incident }, last) : ''), [subjectName, incident, last]);
  const copyInfo = () => Clipboard.setStringAsync(infoText).then(() => setNotice('Copied.'));

  if (!incident) return <View style={[styles.screen, { justifyContent: 'center', alignItems: 'center' }]}><T style={{ color: ui.quiet }}>Loading…</T></View>;
  const lvl = resolved ? 'resolved' : incident.level;
  const hue = LEVEL_HUE[lvl] ?? LEVEL_HUE.check;
  const did = (k: string) => done.includes(k);
  const press = (k: string, f: () => Promise<void> | void) => async () => { await f(); setDone((d) => (d.includes(k) ? d : [...d, k])); };

  // As on the site's friend phone: who and how bad, the map (sealed until the phone opens it), one sentence about what
  // happened, then the four things a friend does, two by two.
  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={[styles.body, { paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <IconBtn label="Back" onPress={back}>{Icon.back()}</IconBtn>
          {!isSubject && !resolved && (
            <Pressable accessibilityRole="button" onPress={copyInfo} hitSlop={8}><T style={{ fontSize: 13.5, fontWeight: '600', color: ui.link }}>Copy info</T></Pressable>
          )}
        </View>

        {resolved && (
          <View style={styles.found} accessibilityRole="header">
            {Icon.check(ht.ink, 20)}
            <D style={{ fontSize: 18, lineHeight: 22 }}>{isSubject ? 'You’re marked safe' : `${subjectName} is safe`}</D>
          </View>
        )}

        <View style={styles.head}>
          <View style={styles.avatar}><D style={{ fontSize: 19, lineHeight: 23 }}>{(isSubject ? 'You' : subjectName).slice(0, 1).toUpperCase()}</D></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <D accessibilityRole="header" style={{ fontSize: 22, lineHeight: 26 }} numberOfLines={1}>{isSubject ? 'Your alert' : subjectName}</D>
            <T style={{ fontSize: 13.5, lineHeight: 18, fontWeight: '600', color: hue.text }} numberOfLines={1}>
              {LEVEL_LINE[lvl] ?? lvl.replace(/_/g, ' ')} · {trail.length && !resolved ? 'location shared · logged' : formatDistanceToNow(new Date(incident.opened_at), { addSuffix: true })}
            </T>
          </View>
        </View>

        <View style={styles.mapCard}>
          {trail.length ? (
            <Map points={trail} style={StyleSheet.absoluteFill} />
          ) : (
            <>
              <SealedMap />
              <View style={styles.lock}>
                {Icon.lock(ht.cream, 26)}
                <D style={{ fontSize: 15, lineHeight: 19, color: ht.cream }}>Location sealed</D>
                <T style={{ fontSize: 12.5, lineHeight: 17, color: ht.creamSoft, textAlign: 'center', maxWidth: 260 }}>
                  {resolved ? 'The alert is closed. Their location stays sealed.' : offlineLevel ? `Their phone is offline. ${group?.threshold_k ?? 2} friends can open the last known location together.` : 'Their phone opens it to you if things look serious.'}
                </T>
              </View>
            </>
          )}
        </View>
        {last ? <Mono style={{ fontSize: 12, lineHeight: 16, color: ui.quiet }}>Updated {format(last.tMs, 'HH:mm:ss')} · ±{Math.round(last.accuracyM)} m · {trail.length} points</Mono> : null}

        {/* The one-line triggering sequence is all a friend ever sees of the subject's signals (CONTRACTS §6). */}
        <T style={{ fontSize: 15, lineHeight: 21, color: ui.text2 }}>{incident.summary ?? 'No details from the phone yet.'}</T>
        {incident.level === 'snatch' && (
          <T style={{ fontSize: 14.5, lineHeight: 20, fontWeight: '700', color: ht.coralDeep }}>Possible phone snatch. {subjectName} may not have their phone. Don’t chase.</T>
        )}

        {!trail.length && !isSubject && !resolved && !offlineLevel && (
          <Btn kind="coral" size={44} title="Get location now" loading={busy === 'location'}
            onPress={act('location', () => actions.requestLocation(ctx!), 'Asked their phone for its location. It appears here in a few seconds.')} />
        )}
        {!trail.length && offlineLevel && !req && !isSubject && !resolved && (
          <>
            <Btn kind="coral" size={44} title="Request location" onPress={requestUnlock} loading={busy === 'unlock'} disabled={!fallbackAllowed} />
            {!fallbackAllowed && <T style={{ fontSize: 13, color: ui.quiet }}>Fallback unlock needs at least {MIN_MEMBERS_FOR_FALLBACK} members. This group has {activeMembers} active.</T>}
          </>
        )}
        {req && !trail.length && (
          <View style={{ gap: 6 }}>
            <T style={{ fontSize: 14, fontWeight: '600' }}>Unlock approvals: {approvals.length} / {k}</T>
            <View style={styles.track}><View style={[styles.trackFill, { width: `${Math.min(100, (approvals.length / k) * 100)}%` }]} /></View>
            <T style={{ fontSize: 13, color: ui.quiet }}>pip logs every unlock and shows it to {subjectName} and the group.</T>
          </View>
        )}

        {!isSubject && !resolved && (
          <View style={styles.grid}>
            <Btn title="Ring" kind={did('ring') ? 'butter' : 'paper'} size={44} onPress={press('ring', ring)} loading={busy === 'ring'} style={styles.cell} />
            <Btn title="Call" kind={did('call') ? 'butter' : 'paper'} size={44} onPress={press('call', call)} style={styles.cell} />
            <Btn title="I’m going" kind={did('en_route') ? 'butter' : 'paper'} size={44} onPress={press('en_route', going)} loading={busy === 'en_route'} style={styles.cell} />
            <Btn title="Found safe" kind="mint" size={44} onPress={found} loading={busy === 'found'} style={styles.cell} />
          </View>
        )}
        {isSubject && !resolved && <Btn title="I’m safe · close the alert" kind="mint" size={48} icon={Icon.check(ht.ink)} onPress={found} loading={busy === 'found'} />}
        {!!notice && <T testID="incident-notice" style={{ fontSize: 13.5, lineHeight: 19, color: ui.quiet, textAlign: 'center' }}>{notice}</T>}

        {!isSubject && !resolved && (
          <Card style={{ marginTop: 6 }}>
            <D style={{ fontSize: 18, lineHeight: 22 }}>Need more help?</D>
            <T style={{ fontSize: 13.5, lineHeight: 19, color: ui.quiet }}>pip won’t call anyone for you. Read this out, or copy it:</T>
            <Well style={{ padding: 14, borderRadius: 16 }}><T style={{ fontSize: 14, lineHeight: 20 }}>{infoText}</T></Well>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {group?.campus_safety_number && <Btn title="Campus safety" kind="paper" size={44} style={{ flex: 1 }} onPress={act('campus', () => actions.callCampus(ctx!, group.campus_safety_number!))} />}
              <Btn title="Call 911" kind="coral" size={44} style={{ flex: 1 }} onPress={act('911', () => actions.call911(ctx!))} />
            </View>
          </Card>
        )}

        <Caps style={{ marginTop: 10 }}>WHAT HAPPENED</Caps>
        <View style={{ gap: 10 }}>
          {events.map((e) => (
            <View key={e.id} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
              <Mono style={{ width: 48, fontSize: 13, lineHeight: 20, color: ui.quiet }}>{format(new Date(e.created_at), 'HH:mm')}</Mono>
              <T style={{ flex: 1, fontSize: 14.5, lineHeight: 20 }}>{e.actor_id ? profiles[e.actor_id]?.display_name ?? 'Someone' : 'System'} {EVENT_LABEL[e.kind] ?? e.kind}</T>
            </View>
          ))}
          {!events.length && <T style={{ fontSize: 14, color: ui.quiet }}>No events yet.</T>}
        </View>
      </ScrollView>
    </View>
  );
}

const LEVEL_LINE: Record<string, string> = {
  check: 'Check-in pending', heads_up: 'Heads-up', unlocked: 'Location shared', sos: 'Called for help', snatch: 'Phone snatched',
  offline: 'Phone offline', battery_dying: 'Battery dying', resolved: 'Found safe',
};
const LEVEL_HUE: Record<string, { text: string }> = {
  check: { text: ht.butterDeep }, battery_dying: { text: ht.butterDeep }, offline: { text: ht.butterDeep },
  heads_up: { text: ht.coralDeep }, unlocked: { text: ht.coralDeep }, sos: { text: ht.coralDeep }, snatch: { text: ht.coralDeep },
  resolved: { text: ht.mintDeep },
};

/** A made-up street plan behind the lock (it shows nothing real: there is nothing to show yet). */
function SealedMap() {
  return (
    <Svg width="100%" height="100%" viewBox="0 0 240 170" preserveAspectRatio="xMidYMid slice" style={StyleSheet.absoluteFill}>
      <Rect width={240} height={170} fill={ht.sunk} />
      <Path d="M150 20 h70 v56 h-70 z" fill="rgba(61,214,163,0.35)" />
      <Path d="M-10 60 L250 40 M-10 128 L250 112 M60 -10 L80 180 M178 -10 L160 180" stroke={ht.paper} strokeWidth={11} fill="none" />
      <Path d="M-10 92 L250 80 M120 -10 L124 180" stroke={ht.paper} strokeWidth={5} fill="none" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ui.ground },
  body: { gap: 14, paddingHorizontal: 18, maxWidth: 560, width: '100%', alignSelf: 'center' },
  found: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 52, borderRadius: 18,
    backgroundColor: ht.mint, borderWidth: 2, borderColor: ht.ink, shadowColor: ht.ink, shadowOpacity: 1, shadowRadius: 0, shadowOffset: { width: 0, height: 4 }, elevation: 0,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: ht.sky, borderWidth: 2, borderColor: ht.ink, alignItems: 'center', justifyContent: 'center' },
  mapCard: { height: 220, borderRadius: 18, overflow: 'hidden', borderWidth: 2, borderColor: ht.ink, backgroundColor: ht.sunk },
  lock: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(30,27,46,0.62)', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  cell: { flexBasis: '45%', flexGrow: 1 },
  track: { height: 8, backgroundColor: ui.line, borderRadius: 4, overflow: 'hidden' },
  trackFill: { height: 8, backgroundColor: ht.lilacDeep, borderRadius: 4 },
});
