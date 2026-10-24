import React, { useCallback, useMemo } from 'react';
import { Alert, Platform } from 'react-native';
import { Link, useRouter } from 'expo-router';
import { formatDistanceToNow } from 'date-fns';
import { Button, Card, H2, P, Pill, Row, Screen } from '@/components/ui';
import { SosButton } from '@/components/SosButton';
import { ConfirmItsYou, useBiometricConfirm } from '@/components/ConfirmItsYou';
import { SafetyNative, type EscalationLevel } from '@/modules/safety-native';
import { activeIncidents, useStore, useUserId } from '@/lib/store';
import { sos } from '@/lib/native';
import { colors, levelColor } from '@/lib/theme';

export default function Home() {
  const router = useRouter();
  const userId = useUserId();
  const status = useStore((s) => s.status);
  const sosActive = useStore((s) => s.sosActive);
  const snatch = useStore((s) => s.snatch);
  const groups = useStore((s) => s.groups);
  const presence = useStore((s) => s.presence);
  const profiles = useStore((s) => s.profiles);
  const allIncidents = useStore((s) => s.incidents);
  const incidents = useMemo(() => activeIncidents(allIncidents), [allIncidents]);
  const night = status?.nightMode;
  const eng = status?.engine;
  const escalation: EscalationLevel = snatch ? 'snatch' : eng?.escalation ?? 'idle';

  // Cancelling an SOS is biometric-gated in native; the mock just succeeds.
  const cancelAction = useCallback(() => SafetyNative.cancelSos(), []);
  const onCancelDone = useCallback((ok: boolean) => {
    if (!ok) Alert.alert('Could not cancel', 'Biometric check failed. SOS stays active.');
  }, []);
  const cancel = useBiometricConfirm(cancelAction, onCancelDone);
  const pause = () => SafetyNative.setNightMode('paused_tonight');

  return (
    <Screen>
      <Card tint={night?.active ? colors.accent : undefined}>
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>Night mode</H2>
          <Row>
            <Pill text={night?.active ? 'on' : 'off'} color={night?.active ? colors.accent : colors.muted} />
            <Pill text={status?.serviceRunning ? 'watching' : 'idle'} color={status?.serviceRunning ? colors.ok : colors.muted} />
          </Row>
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

      {sosActive && (
        <Card tint={colors.danger}>
          <Row style={{ justifyContent: 'space-between' }}>
            <P style={{ fontWeight: '800', fontSize: 20 }}>SOS sent</P>
            <Pill text="sos" color={colors.danger} />
          </Row>
          <P>Location shared with your friends</P>
          <P muted>They can see where you are right now and are being told to come or call.</P>
          <Button title="Cancel SOS" kind="ghost" onPress={() => void cancel.run()} loading={cancel.state === 'pending'} />
        </Card>
      )}
      <ConfirmItsYou state={cancel.state} what="cancel the SOS" />

      {!sosActive && <EscalationCard level={escalation} evidence={eng?.evidence} onOpenSnatch={() => router.push('/snatch')} />}

      {Platform.OS === 'web' && <Button title="Open monitor" kind="ghost" onPress={() => router.push('/monitor')} />}

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

      <SosButton active={sosActive} onTrigger={() => void sos()} onCancel={() => void cancel.run()} />
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

/** What the engine has done about tonight so far, in the words friends would use. */
function EscalationCard({ level, evidence, onOpenSnatch }: { level: EscalationLevel; evidence?: string; onOpenSnatch: () => void }) {
  const router = useRouter();
  switch (level) {
    case 'check':
      return (
        <Card tint={colors.warn}>
          <P style={{ fontWeight: '700' }}>Checking in with you</P>
          <P muted>Nobody has been told yet. Type the 3 words to dismiss.</P>
          <Button title="Open check-in" kind="ghost" onPress={() => router.push('/check-in')} />
        </Card>
      );
    case 'heads_up':
      return (
        <Card tint={colors.warn}>
          <P style={{ fontWeight: '700' }}>Friends have been given a heads-up</P>
          <P>No location shared yet</P>
          <P muted>{evidence ?? 'You did not answer the check-in.'} Unlocks only if things look serious.</P>
        </Card>
      );
    case 'unlocked':
      return (
        <Card tint={colors.danger}>
          <P style={{ fontWeight: '700' }}>Location shared with your friends</P>
          <P muted>{evidence ?? 'The danger estimate crossed the unlock threshold.'} Your friends can see where you are and decide what to do.</P>
        </Card>
      );
    case 'snatch':
      return (
        <Card tint={colors.danger}>
          <P style={{ fontWeight: '700' }}>Phone may have been snatched</P>
          <P>Don't chase</P>
          <Button title="Open alert" kind="danger" onPress={onOpenSnatch} />
        </Card>
      );
    default:
      return null;
  }
}
