import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack } from 'expo-router';
import { Screen } from '@/components/ui';
import { SafetyNative, type Dashboard } from '@/modules/safety-native';
import { useStore } from '@/lib/store';
import { colors } from '@/lib/theme';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StateStrip } from '@/components/dashboard/StateStrip';
import { MetricTile } from '@/components/dashboard/MetricTile';
import { IncidentLog } from '@/components/dashboard/IncidentLog';

/**
 * /dashboard — the owner's personal live view (dev/demo; off by default, opened from Settings).
 * Live metrics vs baseline bands, the four HMM state probabilities, and the engine's incident log.
 * Streams at 1 s while mounted. Nothing here is ever shown to a friend (CONTRACTS §6 Display).
 */
export default function DashboardScreen() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [live, setLive] = useState(false);
  const pDanger = useStore((s) => s.status?.engine.pDanger);
  const { width } = useWindowDimensions();
  const cols = width >= 1100 ? 4 : width >= 640 ? 3 : 2;

  useEffect(() => {
    let alive = true;
    const sub = SafetyNative.addListener('dashboard', (d) => { if (alive) { setDash(d); setLive(true); } });
    SafetyNative.getDashboard().then((d) => alive && setDash(d)).catch((e) => console.warn('getDashboard', e));
    SafetyNative.setDashboardStreaming(true).catch((e) => console.warn('setDashboardStreaming', e));
    return () => {
      alive = false;
      sub.remove();
      SafetyNative.setDashboardStreaming(false).catch(() => {});
    };
  }, []);

  const m = dash?.metrics ?? null;
  const gap = 10;
  const tileWidth = Math.floor((Math.min(width, 1400) - 40 - gap * (cols - 1)) / cols); // Screen pads 20 each side
  return (
    <>
      <Stack.Screen options={{ title: 'Personal dashboard' }} />
      <Screen style={{ gap: 14 }}>
        <DashboardHeader m={m} live={live} />
        <StateStrip m={m} pDanger={pDanger} />

        <Text style={styles.section}>Live metrics vs baseline</Text>
        <Text style={styles.hint}>Band = your mean ± 2.5 SD for this placement. A metric must stay out of band for 30 s of walking before it counts.</Text>
        <View style={[styles.grid, { gap }]}>
          {(m?.bands ?? []).map((b) => (
            <MetricTile key={b.name} b={b} style={{ width: tileWidth }} />
          ))}
          {!m && <Text style={styles.hint}>No metrics yet.</Text>}
        </View>

        <Text style={styles.section}>Incident log</Text>
        <Text style={styles.hint}>Everything the engine flagged in the last 8 h, newest first. Tap to see the raw record. Friends only ever see the one-line summary that triggered an unlock.</Text>
        <IncidentLog records={dash?.incidents ?? []} />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  section: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 4 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: -8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
});
