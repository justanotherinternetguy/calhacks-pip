import React, { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { format } from 'date-fns';
import { Button, Card, H2, P, Pill, Row, Screen } from '@/components/ui';
import { useStore, useUserId } from '@/lib/store';
import { listAuditLog } from '@/lib/db';
import type { AuditLog } from '@/lib/types';
import { levelColor } from '@/lib/theme';

export default function History() {
  const router = useRouter();
  const userId = useUserId();
  const incidents = useStore((s) => s.incidents);
  const profiles = useStore((s) => s.profiles);
  const [audit, setAudit] = useState<AuditLog[]>([]);
  useEffect(() => { if (userId) listAuditLog(userId).then(setAudit).catch(() => {}); }, [userId, incidents.length]);

  return (
    <Screen>
      <H2>Incidents</H2>
      {!incidents.length && <P muted>Nothing yet. Good.</P>}
      {incidents.map((i) => (
        <Card key={i.id}>
          <Row style={{ justifyContent: 'space-between' }}>
            <P style={{ fontWeight: '700' }}>{i.user_id === userId ? 'You' : profiles[i.user_id]?.display_name ?? 'Friend'}</P>
            <Pill text={i.resolved_at ? 'resolved' : i.level} color={levelColor(i.resolved_at ? 'resolved' : i.level)} />
          </Row>
          <P muted>{format(new Date(i.opened_at), 'EEE d MMM, HH:mm')} · {i.summary ?? ''}</P>
          <Button title="Details" kind="ghost" onPress={() => router.push(`/incident/${i.id}`)} />
        </Card>
      ))}
      <H2>Audit log</H2>
      <P muted>Everything that touched your location or keys. Every unlock is shown here and to your whole group.</P>
      {audit.map((a) => (
        <Card key={a.id}>
          <P>{a.kind}</P>
          <P muted>{format(new Date(a.created_at), 'd MMM HH:mm')} · by {a.actor_id ? profiles[a.actor_id]?.display_name ?? a.actor_id.slice(0, 8) : 'system'}</P>
        </Card>
      ))}
    </Screen>
  );
}
