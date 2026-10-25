import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { format } from 'date-fns';
import { Card, H2, P, Pill, Screen } from '@/components/ui';
import { Icon, Mono, Row, T } from '@/components/pip/kit';
import { useStore, useUserId } from '@/lib/store';
import { listAuditLog } from '@/lib/db';
import type { AuditLog } from '@/lib/types';
import { levelColor, ui } from '@/lib/theme';

export default function History() {
  const router = useRouter();
  const userId = useUserId();
  const incidents = useStore((s) => s.incidents);
  const profiles = useStore((s) => s.profiles);
  const [audit, setAudit] = useState<AuditLog[]>([]);
  useEffect(() => { if (userId) listAuditLog(userId).then(setAudit).catch(() => {}); }, [userId, incidents.length]);

  return (
    <Screen style={{ maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <H2>Incidents</H2>
      {!incidents.length && <P muted>Nothing yet. Good.</P>}
      {incidents.map((i) => {
        const level = i.resolved_at ? 'resolved' : i.level;
        return (
          <Card key={i.id} padded={false} style={{ paddingHorizontal: 18, paddingVertical: 6 }}>
            <Row
              title={i.user_id === userId ? 'You' : profiles[i.user_id]?.display_name || 'Friend'}
              sub={`${format(new Date(i.opened_at), 'EEE d MMM, HH:mm')}${i.summary ? ` · ${i.summary}` : ''}`}
              right={<Pill text={level.replace('_', ' ')} color={levelColor(level)} />}
              onPress={() => router.push(`/incident/${i.id}`)}
            />
          </Card>
        );
      })}
      <H2>Audit log</H2>
      <P muted>Everything that touched your location or keys. Every unlock is shown here and to your whole group.</P>
      {audit.length > 0 && (
        <Card padded={false} style={{ paddingHorizontal: 18 }}>
          {audit.map((a, idx) => (
            <View key={a.id} style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 }, idx < audit.length - 1 && { borderBottomWidth: 1.5, borderBottomColor: ui.line }]}>
              {Icon.lock(ui.quiet, 18)}
              <View style={{ flex: 1, gap: 2 }}>
                <T style={{ fontSize: 15, fontWeight: '500' }}>{a.kind.replace(/_/g, ' ')}</T>
                <T style={{ fontSize: 13, color: ui.quiet }}>by {a.actor_id ? profiles[a.actor_id]?.display_name || a.actor_id.slice(0, 8) : 'system'}</T>
              </View>
              <Mono style={{ fontSize: 12.5, color: ui.quiet }}>{format(new Date(a.created_at), 'd MMM HH:mm')}</Mono>
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}
