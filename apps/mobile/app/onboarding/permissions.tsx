import React, { useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, H1, P, Pill, Row, Screen } from '@/components/ui';
import { SafetyNative, type Permissions, type PermissionState } from '@/modules/safety-native';
import { colors } from '@/lib/theme';

const ITEMS: { kind: keyof Permissions; title: string; why: string; android?: boolean }[] = [
  { kind: 'locationAlways', title: 'Location — Always', why: 'So night mode can start by itself when you leave home, and so a location can be unlocked for friends if you may be in danger. Encrypted on your phone first.' },
  { kind: 'motion', title: 'Motion & fitness', why: 'Walking rhythm, falls and stillness are detected from the accelerometer, on your phone only.' },
  { kind: 'microphone', title: 'Microphone (optional)', why: 'A few seconds every half minute during night mode, to notice screams or breaking glass. Audio is never stored or uploaded. Works without it, just a bit less sensitive.' },
  { kind: 'notifications', title: 'Notifications', why: 'The "you okay?" check-in and friend alerts arrive as high-priority notifications.' },
  { kind: 'batteryUnrestricted', title: 'Unrestricted battery', why: 'Android may kill background apps to save battery. Safe needs to stay alive through the night (target under 8% battery per night).', android: true },
];

const color = (s?: PermissionState) => (s === 'granted' ? colors.ok : s === 'denied' ? colors.danger : colors.muted);

export default function PermissionsScreen() {
  const router = useRouter();
  const [perms, setPerms] = useState<Permissions | null>(null);
  const refresh = () => SafetyNative.getStatus().then((s) => setPerms(s.permissions)).catch(() => {});
  useEffect(() => { void refresh(); }, []);

  const ask = async (kind: keyof Permissions) => {
    const res = await SafetyNative.requestPermission(kind);
    setPerms((p) => ({ ...(p ?? ({} as Permissions)), [kind]: res }));
  };
  const essentialsOk = perms?.locationAlways === 'granted' && perms?.motion === 'granted' && perms?.notifications === 'granted';

  return (
    <Screen>
      <H1>Permissions</H1>
      <P muted>Each one has a plain reason. You can change them later in Settings.</P>
      {ITEMS.filter((i) => !i.android || Platform.OS === 'android').map((i) => (
        <Card key={i.kind}>
          <Row style={{ justifyContent: 'space-between' }}>
            <P style={{ fontWeight: '700' }}>{i.title}</P>
            <Pill text={perms?.[i.kind] ?? 'undetermined'} color={color(perms?.[i.kind])} />
          </Row>
          <P muted>{i.why}</P>
          <Button title={perms?.[i.kind] === 'granted' ? 'Granted' : 'Allow'} kind={perms?.[i.kind] === 'granted' ? 'ghost' : 'primary'} onPress={() => ask(i.kind)} disabled={perms?.[i.kind] === 'granted'} />
          {i.kind === 'batteryUnrestricted' && (
            <Button title="OEM tips (dontkillmyapp.com)" kind="ghost" onPress={() => Linking.openURL('https://dontkillmyapp.com/')} />
          )}
        </Card>
      ))}
      {perms && Object.values(perms).includes('denied') && <Button title="Open system settings" kind="ghost" onPress={() => Linking.openSettings()} />}
      <Button title="Continue" onPress={() => router.push('/onboarding/home-places')} disabled={!essentialsOk && !SafetyNative.isMock} />
      {!essentialsOk && <P muted>Location, motion and notifications are required for the app to work at all.</P>}
    </Screen>
  );
}
