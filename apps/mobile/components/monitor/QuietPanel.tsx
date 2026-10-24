import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { format, formatDistanceToNow } from 'date-fns';
import { Card, Pill, Row } from '@/components/ui';
import { colors, levelColor } from '@/lib/theme';
import type { Profile, Uuid } from '@/lib/types';
import type { DeviceStatus, FeedItem } from './useMonitorData';
import { AUDIT_LABEL, EVENT_LABEL, heartbeatAge, riskColor } from './labels';

/** Right-hand column when nothing is open: a calm summary of the freshest device plus the last 24 h of activity. */
export function QuietPanel({ devices, profiles, me, feed, now }: {
  devices: Record<Uuid, DeviceStatus>; profiles: Record<Uuid, Profile>; me: Uuid | null; feed: FeedItem[]; now: number;
}) {
  const latest = Object.values(devices)
    .filter((d) => d.user_id !== me && d.last_heartbeat)
    .sort((a, b) => (b.last_heartbeat ?? '').localeCompare(a.last_heartbeat ?? ''))[0];
  const name = (id: Uuid | null) => (id ? profiles[id]?.display_name ?? `Friend ${id.slice(0, 6)}` : 'System');
  const label = (f: FeedItem) => (f.source === 'event' ? EVENT_LABEL[f.kind as keyof typeof EVENT_LABEL] : AUDIT_LABEL[f.kind]) ?? f.kind.replace(/_/g, ' ');

  return (
    <View style={{ gap: 14 }}>
      <Card tint={colors.ok} style={styles.quiet}>
        <View style={styles.okDot} />
        <Text style={styles.title}>All quiet</Text>
        <Text style={[styles.muted, { textAlign: 'center' }]}>No open incident. You'll hear a beep and this panel switches to the incident the moment one opens.</Text>
      </Card>

      <Text style={styles.h2}>Last known status</Text>
      {latest ? (
        <Card>
          <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Text style={styles.body}><Text style={{ fontWeight: '700' }}>{name(latest.user_id)}</Text> · heartbeat {heartbeatAge(latest.last_heartbeat, now).text}</Text>
            <Row>
              <Pill text={latest.night_mode ? 'night mode on' : 'night mode off'} color={latest.night_mode ? colors.accent : colors.muted} />
              <Pill text={`risk ${latest.risk_band}`} color={riskColor(latest.risk_band)} />
              <Pill text={latest.status_level.replace('_', ' ')} color={levelColor(latest.status_level)} />
            </Row>
          </Row>
          <Text style={styles.muted}>Battery {latest.battery_pct ?? '—'}% · {latest.platform} · last heartbeat {latest.last_heartbeat ? format(new Date(latest.last_heartbeat), 'HH:mm:ss') : '—'}. Only coarse status leaves the phone; location stays encrypted until an incident unlocks it.</Text>
        </Card>
      ) : (
        <Card><Text style={styles.muted}>No heartbeat from any group-mate yet. Heartbeats start when their phone enters night mode.</Text></Card>
      )}

      <Text style={styles.h2}>Last 24 hours</Text>
      <Card style={{ gap: 6 }}>
        {feed.length ? feed.slice(0, 60).map((f) => (
          <Row key={f.id} style={{ alignItems: 'flex-start' }}>
            <Text style={[styles.muted, { width: 64, fontVariant: ['tabular-nums'] }]}>{format(new Date(f.at), 'HH:mm')}</Text>
            <Text style={[styles.body, { flex: 1 }]}>
              <Text style={{ fontWeight: '700' }}>{name(f.actor_id)}</Text> {label(f)}
              {f.subject_id && f.subject_id !== f.actor_id ? <Text style={styles.muted}> · {name(f.subject_id)}</Text> : null}
              <Text style={styles.muted}> · {formatDistanceToNow(new Date(f.at), { addSuffix: true })}</Text>
            </Text>
          </Row>
        )) : <Text style={styles.muted}>Nothing happened in the last 24 hours.</Text>}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  quiet: { alignItems: 'center', paddingVertical: 28, gap: 8 },
  okDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.ok },
  title: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
  h2: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 4 },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
});
