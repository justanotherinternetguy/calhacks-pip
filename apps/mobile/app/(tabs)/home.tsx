import React, { useMemo } from 'react';
import { Alert } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { formatDistanceToNow } from 'date-fns';
import { Button, Card, H2, P, Pill, Row, Screen } from '@/components/ui';
import { SosButton } from '@/components/SosButton';
import { SafetyNative } from '@/modules/safety-native';
import { activeIncidents, useStore, useUserId } from '@/lib/store';
import { sos } from '@/lib/native';
import { colors, levelColor } from '@/lib/theme';

export default function Home() {
  const router = useRouter();
  const userId = useUserId();
  const status = useStore((s) => s.status);
  const sosActive = useStore((s) => s.sosActive);
  const groups = useStore((s) => s.groups);
  const presence = useStore((s) => s.presence);
  const profiles = useStore((s) => s.profiles);
  const allIncidents = useStore((s) => s.incidents);
  const incidents = useMemo(() => activeIncidents(allIncidents), [allIncidents]);
  const night = status?.nightMode;
  const eng = status?.engine;

  const cancel = async () => {
    const ok = await SafetyNative.cancelSos();
    if (!ok) Alert.alert('Could not cancel', 'Biometric check failed. SOS stays active.');
  };
  const pause = () => SafetyNative.setNightMode('paused_tonight');

  return (
    <Screen>
      <Card tint={night?.active ? colors.accent : undefined}>
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>{night?.active ? 'Night mode on' : 'Night mode off'}</H2>
          <Pill text={status?.serviceRunning ? 'watching' : 'idle'} color={status?.serviceRunning ? colors.ok : colors.muted} />
        </Row>
        <P muted>
          {night?.active
            ? `Since ${night.since ? formatDistanceToNow(night.since, { addSuffix: true }) : 'now'} · ${night.reason.replace('_', ' ')}`
            : 'Starts by itself when you leave home during your evening window.'}
        </P>
        <Row>
          <Button title={night?.active ? 'Pause tonight' : 'Turn on now'} kind="ghost" style={{ flex: 1 }} onPress={() => (night?.active ? pause() : SafetyNative.setNightMode('on'))} />
          <Link href="/settings" asChild><Button title="Settings" kind="ghost" onPress={() => {}} /></Link>
        </Row>
      </Card>

      {groups.map((g) => {
        const others = (presence[g.id] ?? []).filter((p) => p.user_id !== userId);
        return (
          <Card key={g.id}>
            <Row style={{ justifyContent: 'space-between' }}>
              <P style={{ fontWeight: '700' }}>{g.name}</P>
              {others.length ? <Pill text={others.every((p) => p.together) ? 'together' : 'separated'} color={others.every((p) => p.together) ? colors.ok : colors.warn} /> : <Pill text="no presence yet" color={colors.muted} />}
            </Row>
            <P muted>{others.map((p) => `${profiles[p.user_id]?.display_name ?? p.user_id.slice(0, 6)}: ${p.together ? 'with you' : 'apart'}`).join(' · ') || 'Add friends in the Friends tab'}</P>
          </Card>
        );
      })}

      {incidents.map((i) => (
        <Card key={i.id} tint={levelColor(i.level)}>
          <Row style={{ justifyContent: 'space-between' }}>
            <P style={{ fontWeight: '700' }}>{i.user_id === userId ? 'Your incident' : `${profiles[i.user_id]?.display_name ?? 'Friend'} may need help`}</P>
            <Pill text={i.level} color={levelColor(i.level)} />
          </Row>
          <P muted>{i.summary ?? ''} · {formatDistanceToNow(new Date(i.opened_at), { addSuffix: true })}</P>
          <Button title="Open" kind="danger" onPress={() => router.push(`/incident/${i.id}`)} />
        </Card>
      ))}

      <SosButton active={sosActive || eng?.escalation === 'unlocked'} onTrigger={() => void sos()} onCancel={cancel} />
      <P muted style={{ textAlign: 'center' }}>Hold to alert friends right now with your location.</P>

      <Card style={{ opacity: 0.8 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <P muted>evidence</P>
          <Pill text={`${eng?.hmmState ?? '-'} · ${eng?.escalation ?? '-'}`} color={levelColor(eng?.escalation ?? 'idle')} />
        </Row>
        <P style={{ fontSize: 14 }}>{eng?.evidence ?? '—'}</P>
        <P muted style={{ fontSize: 13 }}>
          p(danger) {eng ? eng.pDanger.toFixed(2) : '-'} · band {eng?.riskBand ?? '-'} · {eng?.placement ?? '-'} · baseline {eng?.baselineSeconds ?? 0}s · battery {status?.batteryPct ?? '-'}%
          {SafetyNative.isMock ? ' · MOCK' : ''}
        </P>
      </Card>
    </Screen>
  );
}
