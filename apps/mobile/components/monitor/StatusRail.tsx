import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Pill } from '@/components/ui';
import { colors } from '@/lib/theme';
import type { Group, GroupMember, Incident, Presence, Profile, Uuid } from '@/lib/types';
import type { DeviceStatus } from './useMonitorData';
import { MemberCard } from './MemberCard';

export function StatusRail({ groups, members, profiles, presence, devices, me, now, active }: {
  groups: Group[]; members: GroupMember[]; profiles: Record<Uuid, Profile>; presence: Record<Uuid, Presence[]>;
  devices: Record<Uuid, DeviceStatus>; me: Uuid | null; now: number; active: Incident | null;
}) {
  if (!groups.length) return <Text style={styles.empty}>You are not in a group yet. Join one from the Friends tab on your phone.</Text>;
  return (
    <View style={{ gap: 18 }}>
      {groups.map((g) => {
        const gm = members.filter((m) => m.group_id === g.id);
        const activeMembers = gm.filter((m) => m.status === 'active');
        const invited = gm.filter((m) => m.status !== 'active');
        const pres = presence[g.id] ?? [];
        const others = pres.filter((p) => p.user_id !== me);
        const together = others.length ? others.every((p) => p.together) : null;
        return (
          <View key={g.id} style={{ gap: 10 }}>
            <View style={styles.groupHead}>
              <Text style={styles.groupName}>{g.name}</Text>
              <Pill text={together == null ? 'no presence yet' : together ? 'together' : 'separated'} color={together == null ? colors.muted : together ? colors.ok : colors.warn} />
            </View>
            <Text style={styles.meta}>{activeMembers.length} member{activeMembers.length === 1 ? '' : 's'} · unlock needs {g.threshold_k} friends</Text>
            {activeMembers.map((m) => (
              <MemberCard
                key={m.user_id}
                name={profiles[m.user_id]?.display_name ?? `Friend ${m.user_id.slice(0, 6)}`}
                shortId={m.user_id.slice(0, 8)}
                isMe={m.user_id === me}
                status={devices[m.user_id]}
                presence={pres.find((p) => p.user_id === m.user_id)}
                now={now}
                highlight={active && active.user_id === m.user_id && active.group_id === g.id ? colors.danger : undefined}
              />
            ))}
            {invited.length > 0 && <Text style={styles.meta}>Invited, not yet joined: {invited.map((m) => profiles[m.user_id]?.display_name ?? m.user_id.slice(0, 6)).join(', ')}</Text>}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  groupName: { color: colors.text, fontSize: 15, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8 },
  meta: { color: colors.muted, fontSize: 13 },
  empty: { color: colors.muted, fontSize: 15, lineHeight: 22 },
});
