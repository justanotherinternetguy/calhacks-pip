import React, { useState } from 'react';
import { Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Button, Card, H2, Input, P, Row, Screen, Toggle } from '@/components/ui';
import { SafetyNative } from '@/modules/safety-native';
import { signOut } from '@/lib/native';
import { useStore, writeDashboardEnabled } from '@/lib/store';

export default function Settings() {
  const router = useRouter();
  const status = useStore((s) => s.status);
  const dashboardEnabled = useStore((s) => s.dashboardEnabled);
  const [mic, setMic] = useState(status?.permissions.microphone === 'granted');
  const [learning, setLearning] = useState(true);
  const [start, setStart] = useState('20');
  const [end, setEnd] = useState('6');

  const saveWindow = () => SafetyNative.setEveningWindow(Number(start) || 20, Number(end) || 6).then(() => Alert.alert('Saved'));
  const inject = async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: 'application/json' });
    if (r.canceled || !r.assets[0]) return;
    const json = Platform.OS === 'web' ? await (await fetch(r.assets[0].uri)).text() : await FileSystem.readAsStringAsync(r.assets[0].uri);
    await SafetyNative.injectTrace(json);
    Alert.alert('Trace injected', 'Replaying through the native pipeline.');
  };

  return (
    <Screen>
      <Card>
        <H2>Sensors</H2>
        <Toggle label="Sound detection" hint="Mic sampled briefly in night mode; audio never stored." value={mic} onChange={async (v) => {
          setMic(v);
          if (v) await SafetyNative.requestPermission('microphone');
        }} />
        <Toggle label="Learn my walking on normal days" hint="Keeps your baseline fresh. On-device only." value={learning} onChange={setLearning} />
      </Card>
      <Card>
        <H2>Evening window</H2>
        <P muted>Night mode can start between these hours when you're away from home.</P>
        <Row>
          <Input value={start} onChangeText={setStart} keyboardType="number-pad" style={{ flex: 1 }} placeholder="20" />
          <P muted>to</P>
          <Input value={end} onChangeText={setEnd} keyboardType="number-pad" style={{ flex: 1 }} placeholder="6" />
        </Row>
        <Button title="Save window" kind="ghost" onPress={saveWindow} />
      </Card>
      <Card>
        <H2>Night mode</H2>
        <Row>
          {(['auto', 'on', 'off', 'paused_tonight'] as const).map((m) => (
            <Button key={m} title={m.replace('_', ' ')} kind="ghost" style={{ flex: 1, paddingHorizontal: 6 }} onPress={() => SafetyNative.setNightMode(m)} />
          ))}
        </Row>
      </Card>
      <Card>
        <H2>Personal dashboard</H2>
        <Toggle label="Personal dashboard" hint="Live metrics vs your baseline, state probabilities and the engine's incident log. Only you can see it; friends get a one-line summary at most." value={dashboardEnabled} onChange={(v) => void writeDashboardEnabled(v)} />
        {dashboardEnabled && <Button title="Open dashboard" onPress={() => router.push('/dashboard')} />}
      </Card>
      <Card>
        <H2>Debug</H2>
        <P muted>Service {status?.serviceRunning ? 'running' : 'stopped'} · last heartbeat {status?.lastHeartbeatMs ? new Date(status.lastHeartbeatMs).toLocaleTimeString() : '—'}{SafetyNative.isMock ? ' · JS mock' : ''}</P>
        <Button title="Inject trace file" kind="ghost" onPress={inject} />
        <Button title="Simulate check-in (mock)" kind="ghost" onPress={() => SafetyNative.injectTrace('{"scenario":"check"}')} />
        <Row style={{ flexWrap: 'wrap' }}>
          {(['fall', 'drunk', 'snatch', 'still', 'reset'] as const).map((sc) => (
            <Button key={sc} title={sc} kind="ghost" style={{ flex: 1, minWidth: 70, paddingHorizontal: 6 }} onPress={() => SafetyNative.injectTrace(JSON.stringify({ scenario: sc }))} />
          ))}
        </Row>
      </Card>
      <Button title="Sign out" kind="danger" onPress={signOut} />
    </Screen>
  );
}
