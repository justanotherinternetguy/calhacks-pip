import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TelemetryTick } from '@/modules/safety-native';
import { Pill } from '@/components/ui';
import { latencyText, type TelemetryConnection } from '@/lib/telemetry';
import { colors, levelColor } from '@/lib/theme';
import { CONN_LABEL, ESCALATION_LABEL, batteryColor, connColor, fmtClock } from './labels';

export type SubjectOption = { id: string; name: string; isMe: boolean; publishing: boolean };

/**
 * Top bar: who we are watching (group members; the publishing phone is auto-picked), the channel state with
 * latency and tick rate, the phone's mode pills straight from the newest tick, sound toggle, home.
 */
export function TelemetryHeader({ groupName, now, subjects, subjectId, manual, onPick, conn, tick, soundOn, onToggleSound, onHome, kicker = 'Telemetry console', links }: {
  groupName: string; now: number; subjects: SubjectOption[]; subjectId: string | null; manual: boolean; onPick: (id: string | null) => void;
  conn: TelemetryConnection | undefined; tick: TelemetryTick | null;
  /** omit both to hide the sound toggle */
  soundOn?: boolean; onToggleSound?: () => void;
  onHome: () => void;
  kicker?: string;
  /** extra buttons left of "Map" (other consoles) */
  links?: { label: string; onPress: () => void }[];
}) {
  const stale = conn?.state === 'stale';
  const rate = conn && conn.state === 'live' ? `${conn.ticksPerSec.toFixed(1)} frames/s` : conn?.state === 'stale' ? 'no frames' : '';
  // Prefer the phone's own round trip (phone → Realtime → phone, one clock); the one-way figure includes clock skew.
  const latency = conn ? (conn.rttMs != null ? `round trip ${conn.rttMs} ms` : `${latencyText(conn.latencyMs)} incl. clock skew`) : '';
  return (
    <View style={styles.bar}>
      <View style={styles.row}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.kicker}>{kicker}</Text>
          <Text style={styles.title} numberOfLines={1}>{groupName}</Text>
        </View>
        <View style={styles.right}>
          <Text style={styles.clock}>{fmtClock(now)}</Text>
          {onToggleSound && <Ghost label={soundOn ? 'Sound on' : 'Sound off'} on={soundOn} onPress={onToggleSound} />}
          {links?.map((l) => <Ghost key={l.label} label={l.label} onPress={l.onPress} />)}
          <Ghost label="Map" onPress={onHome} />
        </View>
      </View>

      <View style={styles.row}>
        <View style={styles.chips}>
          <Text style={styles.chipsLabel}>Subject</Text>
          {subjects.length === 0 && <Text style={styles.chipsLabel}>no group members</Text>}
          {subjects.map((s) => {
            const on = s.id === subjectId;
            return (
              <Pressable key={s.id} onPress={() => onPick(on && manual ? null : s.id)} accessibilityRole="button" accessibilityState={{ selected: on }}
                style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && { opacity: 0.7 }]}>
                <View style={[styles.dot, { backgroundColor: s.publishing ? colors.ok : colors.border }]} />
                <Text style={[styles.chipText, on && { color: colors.accent }]} numberOfLines={1}>{s.name}{s.isMe ? ' (you)' : ''}</Text>
              </Pressable>
            );
          })}
          {manual && <Text style={styles.chipsLabel}>pinned · tap again for auto</Text>}
        </View>
      </View>

      <View style={[styles.row, { flexWrap: 'wrap', rowGap: 8 }]}>
        <View style={styles.conn}>
          <View style={[styles.dot, { backgroundColor: connColor(conn?.state) }]} />
          <Text style={[styles.connText, { color: connColor(conn?.state) }]}>{conn ? CONN_LABEL[conn.state] : 'no subject'}</Text>
          {conn && conn.state !== 'error' && conn.state !== 'closed' && conn.state !== 'connecting' && (
            <Text style={styles.meta}>{latency}{rate ? ` · ${rate}` : ''}{stale && conn.lastTickAt ? ` · last ${Math.round((now - conn.lastTickAt) / 1000)} s ago` : ''}</Text>
          )}
          {conn && (conn.state === 'error' || conn.state === 'closed') && (
            <Text style={styles.meta} numberOfLines={1}>{conn.error ?? ''}{conn.nextRetryAt ? ` · retry in ${Math.max(0, Math.ceil((conn.nextRetryAt - now) / 1000))} s` : ''}</Text>
          )}
        </View>
        <View style={{ flex: 1 }} />
        {tick ? (
          <View style={styles.pills}>
            <Pill text={tick.nightMode ? 'night mode' : 'day'} color={tick.nightMode ? colors.accent : colors.muted} />
            <Pill text={tick.samplingFull ? `${Math.round(tick.sampleHz)} Hz + gyro` : `${Math.round(tick.sampleHz)} Hz accel`} color={tick.samplingFull ? colors.warn : colors.muted} />
            <Pill text={`battery ${Math.round(tick.battery)}%`} color={batteryColor(tick.battery)} />
            <Pill text={tick.listening ? 'mic listening' : 'mic off'} color={tick.listening ? colors.warn : colors.muted} />
            <Pill text={ESCALATION_LABEL[tick.escalation] ?? tick.escalation} color={levelColor(tick.escalation)} />
          </View>
        ) : (
          <Text style={styles.meta}>waiting for the first tick…</Text>
        )}
      </View>
    </View>
  );
}

function Ghost({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.ghost, pressed && { opacity: 0.7 }, on && { borderColor: colors.accent }]}>
      <Text style={[styles.ghostText, on && { color: colors.accent }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { gap: 10, paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  kicker: { color: colors.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' },
  clock: { color: colors.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  ghost: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  ghostText: { color: colors.text, fontWeight: '600', fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, flex: 1 },
  chipsLabel: { color: colors.muted, fontSize: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, maxWidth: 220 },
  chipOn: { borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  conn: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  connText: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  meta: { color: colors.muted, fontSize: 13, fontVariant: ['tabular-nums'], flexShrink: 1 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end', flexShrink: 1, maxWidth: '100%' },
});
