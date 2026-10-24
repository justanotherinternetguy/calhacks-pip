import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { format, formatDistanceToNow } from 'date-fns';
import { Button, Card, Pill, Row } from '@/components/ui';
import { Map } from '@/components/Map';
import { NO_EVENTS, useStore } from '@/lib/store';
import { fn, getActiveEpoch, listIncidentEvents, listUnlockRequests, rpc } from '@/lib/db';
import type { Group, Incident, IncidentEventKind, Profile, Uuid } from '@/lib/types';
import { colors, levelColor } from '@/lib/theme';
import { useIncidentLocations } from './useIncidentLocations';
import { EVENT_LABEL } from './labels';

/**
 * Right-hand column while an incident is open: level, summary, decrypted trail map, actions and the
 * live timeline. The actions are the same RPC / edge-function calls app/incident/[id].tsx makes.
 */
export function IncidentPanel({ incident, group, profiles, me, mapHeight, now }: {
  incident: Incident; group: Group | undefined; profiles: Record<Uuid, Profile>; me: Uuid | null; mapHeight: number; now: number;
}) {
  const id = incident.id;
  const events = useStore((s) => s.events[id] ?? NO_EVENTS);
  const { trail, last, req, setReq, approvals, k, setK, error: locError } = useIncidentLocations(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const subject = incident.user_id;
  const subjectName = profiles[subject]?.display_name ?? 'Your friend';
  const isSubject = subject === me;
  const resolved = !!incident.resolved_at || incident.level === 'resolved';
  const offline = incident.level === 'offline' || incident.level === 'battery_dying';

  // The panel is keyed by incident id by its parent, so local state starts fresh per incident.
  useEffect(() => {
    listIncidentEvents(id).then((evs) => evs.forEach(useStore.getState().addEvent)).catch(() => {});
  }, [id]);

  const act = (label: string, f: () => Promise<unknown>) => async () => {
    setBusy(label);
    setError(null);
    try { await f(); } catch (e: any) { setError(e?.message ?? String(e)); } finally { setBusy(null); }
  };
  const event = (kind: IncidentEventKind, payload: Record<string, unknown> = {}) => rpc.addIncidentEvent({ incident_id: id, kind, payload });
  const ring = act('ring', async () => {
    await fn.push({ incidentId: id, kind: 'ring', title: 'Your friends are ringing you', body: 'Tap to answer', recipients: [subject], critical: true, data: { route: '/home' } });
    await event('ring');
  });
  const going = act('en_route', () => event('en_route'));
  const found = act('found', async () => { await event('found'); await rpc.resolveIncident(id); });
  const requestUnlock = act('unlock', async () => {
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

  const level = resolved ? 'resolved' : incident.level;
  const openedMs = new Date(incident.opened_at).getTime();
  const elapsed = Math.max(0, Math.floor((now - openedMs) / 1000));
  const elapsedText = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <View style={{ gap: 14 }}>
      <Card tint={levelColor(level)} style={{ gap: 6 }}>
        <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Text style={styles.title}>{isSubject ? 'Your incident' : `${subjectName} may need help`}</Text>
          <Row>
            <Pill text={level.replace('_', ' ')} color={levelColor(level)} />
            <Text style={styles.elapsed}>{elapsedText}</Text>
          </Row>
        </Row>
        <Text style={styles.muted}>{incident.summary ?? 'No summary'} · opened {format(openedMs, 'HH:mm:ss')} ({formatDistanceToNow(openedMs, { addSuffix: true })}) · {group?.name ?? 'group'}</Text>
        {incident.level === 'snatch' && <Text style={[styles.body, { color: colors.danger, fontWeight: '700' }]}>Possible phone snatch. Do not chase. {subjectName} may be without a phone.</Text>}
      </Card>

      {trail.length ? (
        <View style={{ gap: 6 }}>
          <Map points={trail} style={{ height: mapHeight }} />
          <Text style={styles.muted}>Last update {format(last!.tMs, 'HH:mm:ss')} · ±{Math.round(last!.accuracyM)} m · {trail.length} points · {last!.lat.toFixed(5)}, {last!.lng.toFixed(5)}</Text>
        </View>
      ) : (
        <Card style={{ minHeight: Math.min(mapHeight, 180), justifyContent: 'center' }}>
          <Text style={[styles.body, { fontWeight: '700' }]}>Location locked</Text>
          <Text style={styles.muted}>
            {incident.level === 'heads_up' ? 'Unlocks automatically if things look serious.'
              : offline ? `Their phone is offline. ${group?.threshold_k ?? 2} friends can unlock the last known location together.`
              : 'Waiting for keys…'}
          </Text>
          {req && (
            <View style={{ gap: 6 }}>
              <Text style={styles.body}>Unlock approvals: {approvals.length} / {k}</Text>
              <View style={{ height: 8, backgroundColor: colors.border, borderRadius: 4 }}><View style={{ height: 8, width: `${Math.min(100, (approvals.length / k) * 100)}%`, backgroundColor: colors.accent, borderRadius: 4 }} /></View>
              <Text style={styles.muted}>Every unlock is logged and visible to {subjectName} and the whole group.</Text>
            </View>
          )}
        </Card>
      )}

      {!isSubject && !resolved && (
        <View style={{ gap: 8 }}>
          <Row style={{ flexWrap: 'wrap' }}>
            <Button title="Ring phone" onPress={ring} loading={busy === 'ring'} style={styles.action} />
            <Button title="I'm going" kind="primary" onPress={going} loading={busy === 'en_route'} style={styles.action} />
            <Button title="Found / safe" kind="ok" onPress={found} loading={busy === 'found'} style={styles.action} />
            {!req && !trail.length && (
              <Button title="Request location" kind="danger" onPress={requestUnlock} loading={busy === 'unlock'} disabled={!offline} style={styles.action} />
            )}
          </Row>
          {!req && !trail.length && !offline && <Text style={styles.hint}>Request location (fallback unlock) becomes available when their phone goes offline or the battery is dying.</Text>}
        </View>
      )}
      {(error || locError) && <Text style={[styles.body, { color: colors.danger }]}>{error ?? locError}</Text>}

      <Text style={styles.h2}>Timeline</Text>
      <Card style={{ gap: 6 }}>
        {events.length ? [...events].reverse().map((e) => (
          <Row key={e.id} style={{ alignItems: 'flex-start' }}>
            <Text style={[styles.muted, { width: 64, fontVariant: ['tabular-nums'] }]}>{format(new Date(e.created_at), 'HH:mm:ss')}</Text>
            <Text style={[styles.body, { flex: 1 }]}>
              <Text style={{ fontWeight: '700' }}>{e.actor_id ? profiles[e.actor_id]?.display_name ?? 'Someone' : 'System'}</Text> {EVENT_LABEL[e.kind] ?? e.kind}
            </Text>
          </Row>
        )) : <Text style={styles.muted}>No events yet.</Text>}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },
  elapsed: { color: colors.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  h2: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 4 },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  hint: { color: colors.muted, fontSize: 12 },
  action: { flexGrow: 1, flexBasis: 150 },
});
