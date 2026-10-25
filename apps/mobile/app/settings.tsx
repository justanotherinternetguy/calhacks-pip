import React, { useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Button, Card, H2, Input, P, Row, Screen, Toggle } from '@/components/ui';
import { Icon, Tabs } from '@/components/pip/kit';
import { ht, ui } from '@/lib/theme';
import { SafetyNative, type TelemetryStatus } from '@/modules/safety-native';
import { signOut } from '@/lib/native';
import { useStore, useUserId, writeDashboardEnabled } from '@/lib/store';
import { getMyProfile, upsertProfile } from '@/lib/db';

export default function Settings() {
  const router = useRouter();
  const status = useStore((s) => s.status);
  const dashboardEnabled = useStore((s) => s.dashboardEnabled);
  const [mic, setMic] = useState(status?.permissions.microphone === 'granted');
  const [learning, setLearning] = useState(true);
  // Native reports only whether night mode is active, not which mode was picked; remember the last choice made here.
  const [nightChoice, setNightChoice] = useState<'auto' | 'on' | 'off' | 'paused_tonight'>('auto');
  const [start, setStart] = useState('20');
  const [end, setEnd] = useState('6');

  // Phone number friends can call from an alert (profiles.phone, readable by group-mates only).
  const me = useUserId();
  const [phone, setPhone] = useState('');
  const [phoneNote, setPhoneNote] = useState<string | null>(null);
  useEffect(() => {
    if (!me) return;
    getMyProfile(me).then((p) => { if (p?.phone) setPhone(p.phone); }).catch(() => {});
  }, [me]);
  const savePhone = async () => {
    if (!me) return;
    const v = phone.trim();
    if (v && !/^\+?[\d\s().-]{6,20}$/.test(v)) { setPhoneNote('That does not look like a phone number.'); return; }
    try {
      const p = await upsertProfile({ id: me, phone: v || null });
      useStore.getState().set({ profiles: { ...useStore.getState().profiles, [me]: p } });
      setPhoneNote(v ? 'Saved. Your friends can call you from an alert.' : 'Removed.');
    } catch (e) { setPhoneNote(e instanceof Error ? e.message : String(e)); }
  };

  // §7 telemetry publisher: default on (native starts it once configured); poll the status while this screen is open.
  const telemetry = useNativeSwitch(() => SafetyNative.getTelemetryStatus().then((s) => s.on), SafetyNative.setTelemetry, 'Telemetry', 'This build cannot stream telemetry.');
  const [telemetryStatus, setTelemetryStatus] = useState<TelemetryStatus | null>(null);
  const telemetryError = telemetry.error;
  useEffect(() => {
    let alive = true;
    const load = () => SafetyNative.getTelemetryStatus().then((s) => { if (alive) setTelemetryStatus(s); }).catch(() => {});
    load();
    const t = setInterval(load, 5_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const telemetryHint = telemetryError
    ? `Unavailable: ${telemetryError}`
    : telemetryStatus
      ? [
          telemetryStatus.hz ? `${telemetryStatus.hz} Hz` : telemetryStatus.on ? 'on · idle' : 'off',
          telemetryStatus.hz ? (telemetryStatus.connected ? 'channel joined' : `channel down${telemetryStatus.error ? ` (${telemetryStatus.error})` : ''}`) : null,
          telemetryStatus.rttMs != null ? `round trip ${telemetryStatus.rttMs} ms` : null,
          `last sent ${telemetryStatus.lastSentMs ? new Date(telemetryStatus.lastSentMs).toLocaleTimeString() : '—'}`,
          telemetryStatus.reconnects ? `${telemetryStatus.reconnects} reconnects` : null,
          telemetryStatus.dropped ? `${telemetryStatus.dropped} dropped` : null,
        ].filter(Boolean).join(' · ')
      : 'Checking…';

  // Demo sensitivity: live engine on the bundled model-demo.toml (lenient thresholds).
  const demo = useNativeSwitch(SafetyNative.getDemoSensitivity, SafetyNative.setDemoSensitivity, 'Demo sensitivity', 'This build cannot switch the model config.');
  const [demoHelp, setDemoHelp] = useState(false);

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
        <H2>Friends</H2>
        <Button title="Groups and adding friends" kind="ghost" icon={Icon.people(ui.text, 18)} onPress={() => router.push('/groups')} />
        <Button title="Incident history" kind="ghost" icon={Icon.clock(ui.text, 18)} onPress={() => router.push('/history')} />
        <Button title="Live monitor console" kind="ghost" icon={Icon.list(ui.text, 18)} onPress={() => router.push('/monitor')} />
      </Card>
      <Card>
        <H2>Emergency contact</H2>
        <P muted style={{ fontSize: 14 }}>Your phone number, shared only with your group so they can call you from an alert.</P>
        <Input value={phone} onChangeText={setPhone} placeholder="+1 555 123 4567" keyboardType="phone-pad" testID="settings-phone" />
        <Button title="Save number" kind="ghost" onPress={savePhone} />
        {!!phoneNote && <P muted style={{ fontSize: 13 }}>{phoneNote}</P>}
      </Card>
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
        <Tabs
          items={[{ key: 'auto', label: 'Auto' }, { key: 'on', label: 'On' }, { key: 'off', label: 'Off' }, { key: 'paused_tonight', label: 'Paused tonight' }]}
          value={nightChoice} onChange={(m) => { setNightChoice(m); void SafetyNative.setNightMode(m); }} />
      </Card>
      <Card>
        <H2>Personal dashboard</H2>
        <Toggle label="Personal dashboard" hint="Live metrics vs your baseline and the engine's incident log. Only you can see it; friends get a one-line summary at most." value={dashboardEnabled} onChange={(v) => void writeDashboardEnabled(v)} />
        {dashboardEnabled && <Button title="Open dashboard" onPress={() => router.push('/dashboard')} />}
      </Card>
      <Card>
        <H2>Live telemetry</H2>
        <Toggle label="Stream telemetry to monitor" hint="Raw motion, metrics, incidents and engine events go to your group's web monitor over one live connection (10 frames/s). Keeps the sensors at full rate and the CPU awake, so it costs battery. Your last location fix goes along so friends see you on the map." value={telemetry.value} onChange={(v) => void telemetry.toggle(v)} />
        <P muted style={{ fontSize: 13 }}>{telemetryHint}</P>
      </Card>
      <Card>
        <H2>Demo sensitivity</H2>
        <Toggle label="Demo sensitivity" hint="Lenient thresholds so incidents can be triggered by hand in a room. Trades false alarms for reproducibility; turn off after the demo." value={demo.value} onChange={(v) => void demo.toggle(v)} />
        {demo.error ? <P muted style={{ fontSize: 13 }}>Unavailable: {demo.error}</P> : (
          <P muted style={{ fontSize: 13 }}>
            Lower thresholds and shorter timers, taken from the bundled demo config; the trigger guide below lists them. Your server model stays saved and comes back when this is off.
          </P>
        )}
        <Button title={demoHelp ? 'Hide: how to trigger' : 'How to trigger'} kind="ghost" onPress={() => setDemoHelp((h) => !h)} />
        {demoHelp && (
          <>
            <P style={{ fontSize: 14 }}>Possible fall: phone in a pocket, drop onto a couch or bed (a firm hit with a tilt is enough). "High-g impact" appears at once, "Possible fall" about 2 s later. Don't touch it for 15 s → down after fall (red). Walk again → fall recovered.</P>
            <P style={{ fontSize: 14 }}>Grab: screen on, phone in hand; yank it away sharply with a twist, then jog for 2 to 3 s.</P>
            <P style={{ fontSize: 14 }}>Unsteady gait: stagger or sway while walking for 10 s. Slowed walk: walk very slowly for 15 s. Stumble: trip mid-stride and keep walking (3 in 5 min → repeated stumbles).</P>
            <P style={{ fontSize: 14 }}>Phone left behind: leave it flat on a table, untouched, for 2 min while night mode is on.</P>
            <P style={{ fontSize: 14 }}>A possible fall, hard impact or scream asks "You okay?" after 5 s (milder incidents need two kinds at once). Unanswered, friends get a heads-up, then the location. Confirm with fingerprint or PIN, then type the phrase, to dismiss.</P>
          </>
        )}
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
      <Button title="Sign out" kind="ghost" icon={Icon.signOut(ht.ink, 18)} onPress={signOut} />
    </Screen>
  );
}

/**
 * An optimistic on/off switch backed by a native getter/setter. Reads once on mount; older builds without the
 * method (a synchronous throw) land in the same error path and the caller shows the card as unavailable.
 */
function useNativeSwitch(get: () => Promise<boolean>, set: (on: boolean) => Promise<void>, title: string, unsupported: string) {
  const [value, setValue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // `() => get()`, not `.then(get)`: the latter passes the resolved value as an argument, and a native getter
    // that takes none rejects it ("received 1 arguments, but 0 was expected").
    Promise.resolve()
      .then(() => get())
      .then((on) => { if (alive) { setValue(on); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : 'not supported by this build'); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggle = async (on: boolean) => {
    setValue(on);
    try { await set(on); } catch (e: unknown) {
      setValue(!on);
      Alert.alert(title, e instanceof Error ? e.message : unsupported);
    }
  };
  return { value, error, toggle };
}
