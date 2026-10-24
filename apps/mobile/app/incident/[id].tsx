import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Platform, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { format, formatDistanceToNow } from 'date-fns';
import { Button, Card, H1, H2, P, Pill, Row, Screen } from '@/components/ui';
import { Map } from '@/components/Map';
import { SafetyNative, type DecryptedLocation } from '@/modules/safety-native';
import { useStore, useUserId } from '@/lib/store';
import {
  fn, getActiveEpoch, getIncident, listIncidentEvents, listLocationBlobs, listReleasedKeysForMe,
  listUnlockApprovals, listUnlockRequests, rpc, subscribe,
} from '@/lib/db';
import type { Incident, IncidentEventKind, ReleasedKey, UnlockApproval, UnlockRequest } from '@/lib/types';
import { colors, levelColor } from '@/lib/theme';

const EVENT_LABEL: Record<IncidentEventKind, string> = {
  nudge: 'asked "you okay?"', heads_up: 'friends notified', release: 'location unlocked', ring: 'rang the phone', en_route: 'is on the way',
  called_911: 'called 911', called_campus: 'called campus safety', found: 'found them', resolved: 'marked safe', unlock_requested: 'requested fallback unlock',
  unlock_approved: 'approved unlock', phone_offline: 'phone went offline', battery_dying: 'battery dying',
};

export default function IncidentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useUserId();
  const profiles = useStore((s) => s.profiles);
  const groups = useStore((s) => s.groups);
  const stored = useStore((s) => s.incidents.find((i) => i.id === id));
  const events = useStore((s) => s.events[id] ?? []);
  const [incident, setIncident] = useState<Incident | undefined>(stored);
  const [trail, setTrail] = useState<DecryptedLocation[]>([]);
  const [keys, setKeys] = useState<ReleasedKey[]>([]);
  const [req, setReq] = useState<UnlockRequest | null>(null);
  const [approvals, setApprovals] = useState<UnlockApproval[]>([]);
  const [k, setK] = useState(2);
  const [busy, setBusy] = useState<string | null>(null);

  const subject = incident?.user_id;
  const subjectName = subject ? profiles[subject]?.display_name ?? 'Your friend' : '';
  const group = groups.find((g) => g.id === incident?.group_id);
  const isSubject = subject === me;
  const resolved = !!incident?.resolved_at || incident?.level === 'resolved';

  // Decrypt whatever blobs we can with the keys we've been given (normal unlock path).
  const loadTrail = useCallback(async (ks: ReleasedKey[]) => {
    if (!subject || !ks.length) return;
    try {
      for (const rk of ks) await SafetyNative.openReleasedKey({ subjectUserId: subject, epochId: rk.epoch_id, hourIndex: rk.hour_index, sealedB64: rk.sealed, senderEd25519Pub: rk.sender_ed25519_pub });
      const epochIds = [...new Set(ks.map((x) => x.epoch_id))];
      const blobs = (await Promise.all(epochIds.map((e) => listLocationBlobs(subject, e)))).flat();
      const hours = new Set(ks.map((x) => x.hour_index));
      const usable = blobs.filter((b) => hours.has(b.hour_index));
      const pts = await SafetyNative.decryptLocations(subject, usable.map((b) => ({ epochId: b.epoch_id, seq: Number(b.seq), hourIndex: b.hour_index, ciphertextB64: b.ciphertext })));
      setTrail(pts.sort((a, b) => a.tMs - b.tMs));
    } catch (e) { console.warn('trail', e); }
  }, [subject]);

  useEffect(() => {
    if (!id || !me) return;
    getIncident(id).then(setIncident).catch(() => {});
    listIncidentEvents(id).then((evs) => evs.forEach(useStore.getState().addEvent)).catch(() => {});
    listReleasedKeysForMe(id, me).then((ks) => { setKeys(ks); void loadTrail(ks); }).catch(() => {});
    listUnlockRequests(id).then((rs) => setReq(rs.find((r) => r.status !== 'denied') ?? null)).catch(() => {});
    const chans = [
      subscribe('incidents', `id=eq.${id}`, (row) => setIncident(row)),
      subscribe('released_keys', `incident_id=eq.${id}`, (row) => { if (row.recipient_user_id === me) setKeys((ks) => { const n = [...ks.filter((x) => x.id !== row.id), row]; void loadTrail(n); return n; }); }),
      subscribe('location_blobs', undefined, (row) => { if (row.user_id === subject && keys.length) void loadTrail(keys); }),
      subscribe('unlock_requests', `incident_id=eq.${id}`, (row) => setReq(row)),
    ];
    return () => chans.forEach((c) => c.unsubscribe());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, me, subject]);

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
      setTrail(pts.sort((a, b) => a.tMs - b.tMs));
    })().catch((e) => Alert.alert('Recovery failed', e.message));
  }, [approvals, k, req, subject, me, trail.length]);

  const act = (label: string, f: () => Promise<unknown>) => async () => {
    setBusy(label);
    try { await f(); } catch (e: any) { Alert.alert('Failed', e.message ?? String(e)); } finally { setBusy(null); }
  };
  const event = (kind: IncidentEventKind, payload: Record<string, unknown> = {}) => rpc.addIncidentEvent({ incident_id: id, kind, payload });
  const ring = act('ring', async () => {
    await fn.push({ incidentId: id, kind: 'ring', title: 'Your friends are ringing you', body: 'Tap to answer', recipients: subject ? [subject] : [], critical: true, data: { route: '/home' } });
    await event('ring');
  });
  const call = act('call', async () => {
    const dev = subject ? profiles[subject]?.phone : null;
    if (dev) await Linking.openURL(`tel:${dev}`); else Alert.alert('No phone number on their profile');
  });
  const going = act('en_route', () => event('en_route'));
  const found = act('found', async () => { await event('found'); await rpc.resolveIncident(id); });
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
  const infoText = useMemo(() => `${subjectName} may need help. ${incident?.summary ?? ''}. ${last ? `Last location ${last.lat.toFixed(5)}, ${last.lng.toFixed(5)} at ${format(last.tMs, 'HH:mm')}.` : 'Location not available.'} Reported by the Safe app.`, [subjectName, incident, last]);
  const copyInfo = () => Clipboard.setStringAsync(infoText).then(() => Alert.alert('Copied'));
  const dial = (n: string) => Linking.openURL(`tel:${n}`);

  if (!incident) return <Screen><P muted>Loading…</P></Screen>;
  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1>{isSubject ? 'Your incident' : subjectName}</H1>
        <Pill text={resolved ? 'resolved' : incident.level} color={levelColor(resolved ? 'resolved' : incident.level)} />
      </Row>
      <P muted>{incident.summary} · opened {formatDistanceToNow(new Date(incident.opened_at), { addSuffix: true })}</P>
      {incident.level === 'snatch' && <Card tint={colors.danger}><P style={{ fontWeight: '700' }}>Possible phone snatch. Do not chase. {subjectName} may be without a phone.</P></Card>}

      {trail.length ? (
        <>
          <Map points={trail} style={{ height: 300 }} />
          <P muted>Last update {format(last!.tMs, 'HH:mm:ss')} · ±{Math.round(last!.accuracyM)} m · {trail.length} points</P>
        </>
      ) : (
        <Card>
          <P style={{ fontWeight: '700' }}>Location locked</P>
          <P muted>{incident.level === 'heads_up' ? 'Unlocks automatically if things look serious.' : incident.level === 'offline' || incident.level === 'battery_dying' ? `Their phone is offline. ${group?.threshold_k ?? 2} friends can unlock the last known location together.` : 'Waiting for keys…'}</P>
          {(incident.level === 'offline' || incident.level === 'battery_dying') && !req && !isSubject && <Button title="Request location" kind="danger" onPress={requestUnlock} loading={busy === 'unlock'} />}
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

      {!isSubject && !resolved && (
        <Card tint={colors.warn}>
          <H2>Escalate</H2>
          <P muted>You decide. The app never calls on its own. Read or paste this:</P>
          <P style={{ fontSize: 14 }}>{infoText}</P>
          <Button title="Copy info" kind="ghost" onPress={copyInfo} />
          <Row>
            {group?.campus_safety_number && <Button title="Call campus safety" kind="ghost" style={{ flex: 1 }} onPress={async () => { await event('called_campus'); dial(group.campus_safety_number!); }} />}
            <Button title="Call 911" kind="danger" style={{ flex: 1 }} onPress={async () => { await event('called_911'); dial(Platform.OS === 'web' ? '911' : '911'); }} />
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
