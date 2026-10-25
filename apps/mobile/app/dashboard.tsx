import React, { useEffect, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack } from 'expo-router';
import { Button, Screen } from '@/components/ui';
import { SafetyNative, type Dashboard, type IncidentRecord } from '@/modules/safety-native';
import { colors } from '@/lib/theme';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { StateStrip } from '@/components/dashboard/StateStrip';
import { MetricTile } from '@/components/dashboard/MetricTile';
import { IncidentLog } from '@/components/dashboard/IncidentLog';

/**
 * /dashboard — the owner's personal live view (dev/demo; off by default, opened from Settings).
 * Sensing state and context, live metrics vs baseline bands, and the engine's incident log.
 * Streams at 1 s while mounted. Nothing here is ever shown to a friend (CONTRACTS §6 Display).
 */
export default function DashboardScreen() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [live, setLive] = useState(false);
  const { width } = useWindowDimensions();
  const cols = width >= 1100 ? 4 : width >= 640 ? 3 : 2;

  useEffect(() => {
    let alive = true;
    const sub = SafetyNative.addListener('dashboard', (d) => { if (alive) { setDash(d); setLive(true); } });
    // Opened / cleared records land between 1 s snapshots: upsert by id so the log updates at once.
    const upsert = (r: IncidentRecord) => {
      if (!alive) return;
      setDash((d) => d && { ...d, incidents: d.incidents.some((x) => x.id === r.id) ? d.incidents.map((x) => (x.id === r.id ? r : x)) : [...d.incidents, r] });
    };
    const opened = SafetyNative.addListener('signalIncident', upsert);
    const cleared = SafetyNative.addListener('incidentCleared', upsert);
    const reset = SafetyNative.addListener('incidentLogCleared', () => { if (alive) setDash((d) => d && { ...d, incidents: [] }); });
    SafetyNative.getDashboard().then((d) => alive && setDash(d)).catch((e) => console.warn('getDashboard', e));
    SafetyNative.setDashboardStreaming(true).catch((e) => console.warn('setDashboardStreaming', e));
    return () => {
      alive = false;
      sub.remove();
      opened.remove();
      cleared.remove();
      reset.remove();
      SafetyNative.setDashboardStreaming(false).catch(() => {});
    };
  }, []);

  const [resetting, setResetting] = useState(false);
  const doReset = async () => {
    setResetting(true);
    try {
      await SafetyNative.resetIncidents();
      setDash((d) => d && { ...d, incidents: [] });
    } catch (e) {
      Alert.alert('Reset failed', e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  };
  const confirmReset = () => {
    const msg = 'Clears every logged incident and resets sensing: rule timers, mic, and extra full-rate sampling. Your walking and typing baselines stay.';
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.(`Reset incidents?\n\n${msg}`)) void doReset();
      return;
    }
    Alert.alert('Reset incidents?', msg, [{ text: 'Cancel', style: 'cancel' }, { text: 'Reset', style: 'destructive', onPress: () => void doReset() }]);
  };

  const m = dash?.metrics ?? null;
  const gap = 10;
  const tileWidth = Math.floor((Math.min(width, 1400) - 40 - gap * (cols - 1)) / cols); // Screen pads 20 each side
  return (
    <>
      <Stack.Screen options={{ title: 'Personal dashboard' }} />
      <Screen style={{ gap: 14 }}>
        <DashboardHeader m={m} live={live} />
        <StateStrip m={m} />

        <Text style={styles.section}>Live metrics vs baseline</Text>
        <Text style={styles.hint}>Band = your mean ± 2.5 SD for this placement. A metric must stay out of band for 30 s of walking before it counts.</Text>
        <View style={[styles.grid, { gap }]}>
          {(m?.bands ?? []).map((b) => (
            <MetricTile key={b.name} b={b} style={{ width: tileWidth }} />
          ))}
          {!m && <Text style={styles.hint}>No metrics yet.</Text>}
        </View>

        <Text style={styles.section}>Incident log</Text>
        <Text style={styles.hint}>Incidents the engine flagged in the last 8 h, newest first. Tap one to see the raw record. Friends see only the one-line summary behind an unlock.</Text>
        <Button title="Reset incidents + sensing" kind="ghost" loading={resetting} onPress={confirmReset} testID="reset-incidents" />
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
