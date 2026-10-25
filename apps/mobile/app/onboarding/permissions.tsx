import React, { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, H1, P, Row, Screen } from '@/components/ui';
import { CheckMark, Icon, T } from '@/components/pip/kit';
import { SafetyNative, type Permissions, type PermissionState } from '@/modules/safety-native';
import { ht, ui } from '@/lib/theme';

const ITEMS: { kind: keyof Permissions; title: string; why: string; icon: (c: string) => React.ReactNode; android?: boolean }[] = [
  { kind: 'locationAlways', title: 'Location, always', icon: Icon.pin, why: 'So night mode can start by itself when you leave home, and so a location can be unlocked for friends if you may be in danger. Encrypted on your phone first.' },
  { kind: 'motion', title: 'Motion', icon: Icon.walk, why: 'Walking rhythm, falls and stillness are read from the accelerometer, on your phone only.' },
  { kind: 'microphone', title: 'Microphone (optional)', icon: Icon.mic, why: 'Only for a few minutes after a fall, a grab or a missed check-in, to notice screaming, shouting or snoring. Audio is never stored or uploaded.' },
  { kind: 'notifications', title: 'Notifications', icon: Icon.bell, why: 'The “you okay?” check-in and friend alerts arrive as high-priority notifications.' },
  { kind: 'batteryUnrestricted', title: 'Unrestricted battery', icon: Icon.battery, why: 'Android may kill background apps to save battery. pip needs to stay alive through the night (under 8 % a night).', android: true },
];

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
    <Screen style={{ maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      <H1>Permissions</H1>
      <P muted>Each one has a plain reason. You can change them later in Settings.</P>
      {ITEMS.filter((i) => !i.android || Platform.OS === 'android').map((i) => {
        const st: PermissionState | undefined = perms?.[i.kind];
        const granted = st === 'granted';
        return (
          <Card key={i.kind}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row style={{ flex: 1 }}>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: ui.sunk, alignItems: 'center', justifyContent: 'center' }}>{i.icon(ui.text)}</View>
                <T style={{ fontSize: 17, fontWeight: '600', flex: 1 }}>{i.title}</T>
              </Row>
              {granted ? <CheckMark /> : st === 'denied' ? <CheckMark fill={ht.coral} /> : null}
            </Row>
            <P muted style={{ fontSize: 14.5, lineHeight: 20 }}>{i.why}</P>
            {!granted && <Button title="Allow" kind="primary" onPress={() => ask(i.kind)} />}
            {i.kind === 'batteryUnrestricted' && (
              <Button title="OEM tips (dontkillmyapp.com)" kind="ghost" onPress={() => Linking.openURL('https://dontkillmyapp.com/')} />
            )}
          </Card>
        );
      })}
      {perms && Object.values(perms).includes('denied') && <Button title="Open system settings" kind="ghost" onPress={() => Linking.openSettings()} />}
      <Button title="Continue" onPress={() => router.push('/onboarding/home-places')} disabled={!essentialsOk && !SafetyNative.isMock} />
      {!essentialsOk && <P muted style={{ fontSize: 14 }}>Location, motion and notifications are required for the app to work at all.</P>}
    </Screen>
  );
}
