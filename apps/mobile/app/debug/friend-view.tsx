import React, { useMemo, useState } from 'react';
import { Alert, View } from 'react-native';
import { Redirect } from 'expo-router';
import { format, formatDistanceToNow } from 'date-fns';
import { Button, Card, H1, H2, P, Pill, Row, Screen } from '@/components/ui';
import { Map } from '@/components/Map';
import { SafetyNative } from '@/modules/safety-native';
import { activeIncidents, useStore } from '@/lib/store';
import { DEBUG_ENABLED } from '@/lib/debug';
import { colors, levelColor } from '@/lib/theme';

type Ev = { at: number; text: string };

/**
 * safe://debug/friend-view — what a friend sees once a location is released, rendered on the same device
 * for demos and the unlock-map e2e flow. Uses the newest active incident if there is one; the trail is a
 * local demo trail because this phone is the subject and cannot decrypt as a friend.
 */
export default function DebugFriendView() {
  const incidents = useStore((s) => s.incidents);
  const status = useStore((s) => s.status);
  const incident = useMemo(() => activeIncidents(incidents)[0], [incidents]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [resolved, setResolved] = useState(false);
  const [mountedAt] = useState(() => Date.now());
  const openedAt = useMemo(() => (incident ? new Date(incident.opened_at).getTime() : mountedAt - 4 * 60_000), [incident, mountedAt]);
  const trail = useMemo(() => {
    const base = { lat: 42.3505, lng: -71.1054 };
    return Array.from({ length: 8 }, (_, i) => ({ lat: base.lat + i * 0.0004, lng: base.lng + i * 0.0003, accuracyM: 20 + i, tMs: openedAt + i * 30_000 }));
  }, [openedAt]);
  const last = trail[trail.length - 1];
  const level = incident?.level ?? (status?.engine.escalation === 'snatch' ? 'snatch' : 'unlocked');
  const summary = incident?.summary ?? status?.engine.evidence ?? 'Possible fall, no response to check-in';

  if (!DEBUG_ENABLED) return <Redirect href="/home" />;

  const add = (text: string) => setEvents((e) => [...e, { at: Date.now(), text }]);
  const ring = async () => {
    try { await SafetyNative.ringAlarm(10); } catch (e: any) { Alert.alert('Ring failed', e?.message ?? String(e)); }
    add('You rang their phone');
  };

  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1>Sam</H1>
        <Pill text={resolved ? 'resolved' : level} color={levelColor(resolved ? 'resolved' : level)} />
      </Row>
      <P muted>{summary} · opened {formatDistanceToNow(openedAt, { addSuffix: true })}</P>
      {level === 'snatch' && <Card tint={colors.danger}><P style={{ fontWeight: '700' }}>Possible phone snatch. Do not chase. Sam may be without a phone.</P></Card>}
      <P style={{ fontWeight: '700' }}>Location shared with your friends</P>

      <View testID="incident-map" accessible={false}>
        <Map points={trail} style={{ height: 300 }} />
      </View>
      <P muted>Last update {format(last.tMs, 'HH:mm:ss')} · ±{Math.round(last.accuracyM)} m · {trail.length} points · demo trail</P>

      {!resolved && (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button title="Ring phone" onPress={() => void ring()} style={{ flex: 1, minWidth: 140 }} />
          <Button title="Call" kind="ghost" onPress={() => add('You called Sam')} style={{ flex: 1, minWidth: 140 }} />
          <Button title="I'm going" kind="primary" onPress={() => add('You are on the way')} style={{ flex: 1, minWidth: 140 }} />
          <Button title="Found / safe" kind="ok" onPress={() => { add('You marked Sam safe'); setResolved(true); }} style={{ flex: 1, minWidth: 140 }} />
        </Row>
      )}

      {!resolved && (
        <Card tint={colors.warn}>
          <H2>Escalate</H2>
          <P muted>You decide. The app never calls on its own.</P>
          <P style={{ fontSize: 14 }}>Sam may need help. {summary}. Last location {last.lat.toFixed(5)}, {last.lng.toFixed(5)} at {format(last.tMs, 'HH:mm')}. Reported by the Safe app.</P>
          <Row>
            <Button title="Call campus safety" kind="ghost" style={{ flex: 1 }} onPress={() => add('You called campus safety')} />
            <Button title="Call 911" kind="danger" style={{ flex: 1 }} onPress={() => add('You called 911')} />
          </Row>
        </Card>
      )}

      <H2>Timeline</H2>
      <Row style={{ alignItems: 'flex-start' }}><P muted style={{ width: 56, fontSize: 13 }}>{format(openedAt, 'HH:mm')}</P><P style={{ flex: 1 }}>System location unlocked</P></Row>
      {events.map((e, i) => (
        <Row key={i} style={{ alignItems: 'flex-start' }}>
          <P muted style={{ width: 56, fontSize: 13 }}>{format(e.at, 'HH:mm')}</P>
          <P style={{ flex: 1 }}>{e.text}</P>
        </Row>
      ))}
      <P muted style={{ fontSize: 13 }}>Debug friend view — on a second phone open the incident from the home tab instead.</P>
    </Screen>
  );
}
