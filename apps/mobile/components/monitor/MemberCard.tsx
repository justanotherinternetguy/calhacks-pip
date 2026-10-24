import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Pill } from '@/components/ui';
import { colors, levelColor } from '@/lib/theme';
import type { Presence } from '@/lib/types';
import type { DeviceStatus } from './useMonitorData';
import { heartbeatAge, riskColor } from './labels';

export function MemberCard({ name, shortId, isMe, status, presence, now, highlight }: {
  name: string; shortId: string; isMe: boolean; status?: DeviceStatus; presence?: Presence; now: number; highlight?: string;
}) {
  const hb = heartbeatAge(status?.last_heartbeat, now);
  const band = status?.risk_band ?? 0;
  const battery = status?.battery_pct;
  const batteryColor = battery == null ? colors.muted : battery <= 15 ? colors.danger : battery <= 30 ? colors.warn : colors.text;
  return (
    <View style={[styles.card, highlight ? { borderColor: highlight } : null]}>
      <View style={styles.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.name} numberOfLines={1}>{name}{isMe ? ' (you)' : ''}</Text>
          <Text style={styles.id}>{shortId}{status ? ` · ${status.platform}` : ' · no device'}</Text>
        </View>
        <Pill text={`risk ${band}`} color={riskColor(band)} />
      </View>
      <View style={styles.grid}>
        <Stat label="Night mode" value={status ? (status.night_mode ? 'on' : 'off') : '—'} color={status?.night_mode ? colors.accent : colors.muted} />
        <Stat label="Battery" value={battery == null ? '—' : `${battery}%`} color={batteryColor} />
        <Stat label="Heartbeat" value={hb.text} color={hb.color} />
        <Stat label="Presence" value={presence ? (presence.together ? 'together' : 'separated') : 'unknown'} color={presence ? (presence.together ? colors.ok : colors.warn) : colors.muted} />
      </View>
      {status?.status_level && status.status_level !== 'idle' && (
        <View style={{ flexDirection: 'row' }}><Pill text={status.status_level.replace('_', ' ')} color={levelColor(status.status_level)} /></View>
      )}
    </View>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 14, gap: 10, borderWidth: 1, borderColor: colors.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { color: colors.text, fontSize: 16, fontWeight: '700' },
  id: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexBasis: '47%', flexGrow: 1, backgroundColor: colors.bg, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, gap: 2 },
  statLabel: { color: colors.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 },
  statValue: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
