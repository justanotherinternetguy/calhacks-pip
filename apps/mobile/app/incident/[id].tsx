import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { format, formatDistanceToNow } from 'date-fns';
import { Button, Card, H1, H2, P, Pill, Row, Screen } from '@/components/ui';
import { Map } from '@/components/Map';
import { SafetyNative, type DecryptedLocation } from '@/modules/safety-native';
import { MIN_MEMBERS_FOR_FALLBACK, NO_EVENTS, useStore, useUserId } from '@/lib/store';
import {
  fn, getActiveEpoch, getIncident, listIncidentEvents, listLocationBlobs,
  listUnlockApprovals, listUnlockRequests, rpc, subscribe,
} from '@/lib/db';
import type { Incident, IncidentEventKind, UnlockApproval, UnlockRequest } from '@/lib/types';
import { colors, levelColor } from '@/lib/theme';
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

  if (!incident) return <Screen><P muted>Loading…</P></Screen>;
  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1>{isSubject ? 'Your incident' : subjectName}</H1>
        <Pill text={resolved ? 'resolved' : incident.level} color={levelColor(resolved ? 'resolved' : incident.level)} />
      </Row>
      {/* The one-line triggering sequence is all a friend ever sees of the subject's signals (CONTRACTS §6). */}
      <Card tint={levelColor(resolved ? 'resolved' : incident.level)} style={{ paddingVertical: 12 }}>
        <P muted style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.6 }}>What triggered this</P>
        <P style={{ fontSize: 17, fontWeight: '600', lineHeight: 23 }}>{incident.summary ?? 'No details from the phone yet.'}</P>
        <P muted style={{ fontSize: 13 }}>opened {formatDistanceToNow(new Date(incident.opened_at), { addSuffix: true })}</P>
      </Card>
      {incident.level === 'snatch' && <Card tint={colors.danger}><P style={{ fontWeight: '700' }}>Possible phone snatch. Do not chase. {subjectName} may be without a phone.</P></Card>}

      {trail.length ? (
        <>
          <Map points={trail} style={{ height: 300 }} />
          <P muted>Last update {format(last!.tMs, 'HH:mm:ss')} · ±{Math.round(last!.accuracyM)} m · {trail.length} points</P>
        </>
      ) : (
        <Card>
          <P style={{ fontWeight: '700' }}>Location locked</P>
          <P muted>{offlineLevel ? `Their phone is offline. ${group?.threshold_k ?? 2} friends can unlock the last known location together.` : 'Unlocks automatically if things look serious, or ask their phone for it now.'}</P>
          {!offlineLevel && !isSubject && !resolved && (
            <Button title="Get location now" kind="danger" onPress={act('location', () => actions.requestLocation(ctx!), 'Asked their phone for its location. It appears here in a few seconds.')} loading={busy === 'location'} />
          )}
          {offlineLevel && !req && !isSubject && (
            <>
              <Button title="Request location" kind="danger" onPress={requestUnlock} loading={busy === 'unlock'} disabled={!fallbackAllowed} />
              {!fallbackAllowed && <P muted style={{ fontSize: 13 }}>Fallback unlock needs at least {MIN_MEMBERS_FOR_FALLBACK} members — this group has {activeMembers} active.</P>}
            </>
          )}
          {req && (
            <>
              <P>Unlock approvals: {approvals.length} / {k}</P>
              <View style={{ height: 8, backgroundColor: colors.border, borderRadius: 4 }}><View style={{ height: 8, width: `${Math.min(100, (approvals.length / k) * 100)}%`, backgroundColor: colors.accent, borderRadius: 4 }} /></View>
              <P muted>Every unlock is logged and visible to {subjectName} and the whole group.</P>
            </>
          )}
        </Card>
      )}

      {!isSubject && !resolved && (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button title="Ring phone" onPress={ring} loading={busy === 'ring'} style={{ flex: 1, minWidth: 140 }} />
          <Button title="Call" kind="ghost" onPress={call} style={{ flex: 1, minWidth: 140 }} />
          <Button title="I'm going" kind="primary" onPress={going} loading={busy === 'en_route'} style={{ flex: 1, minWidth: 140 }} />
          <Button title="Found / safe" kind="ok" onPress={found} loading={busy === 'found'} style={{ flex: 1, minWidth: 140 }} />
        </Row>
      )}
      {isSubject && !resolved && <Button title="I'm safe — resolve" kind="ok" onPress={found} loading={busy === 'found'} />}
      {!!notice && <P muted testID="incident-notice">{notice}</P>}

      {!isSubject && !resolved && (
        <Card tint={colors.warn}>
          <H2>Escalate</H2>
          <P muted>You decide. The app never calls on its own. Read or paste this:</P>
          <P style={{ fontSize: 14 }}>{infoText}</P>
          <Button title="Copy info" kind="ghost" onPress={copyInfo} />
          <Row>
            {group?.campus_safety_number && <Button title="Call campus safety" kind="ghost" style={{ flex: 1 }} onPress={act('campus', () => actions.callCampus(ctx!, group.campus_safety_number!))} />}
            <Button title="Call 911" kind="danger" style={{ flex: 1 }} onPress={act('911', () => actions.call911(ctx!))} />
          </Row>
        </Card>
      )}

      <H2>Timeline</H2>
      {events.map((e) => (
        <Row key={e.id} style={{ alignItems: 'flex-start' }}>
          <P muted style={{ width: 56, fontSize: 13 }}>{format(new Date(e.created_at), 'HH:mm')}</P>
          <P style={{ flex: 1 }}>{e.actor_id ? profiles[e.actor_id]?.display_name ?? 'Someone' : 'System'} {EVENT_LABEL[e.kind] ?? e.kind}</P>
        </Row>
      ))}
      {!events.length && <P muted>No events yet.</P>}
    </Screen>
  );
}
