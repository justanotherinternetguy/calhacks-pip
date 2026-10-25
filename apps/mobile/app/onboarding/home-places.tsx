import { uuidv4 } from '@/lib/uuid';
import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { Button, Card, H1, Input, P, Row, Screen } from '@/components/ui';
import { Icon, Row as KitRow } from '@/components/pip/kit';
import { Map } from '@/components/Map';
import { SafetyNative, type HomePlace } from '@/modules/safety-native';
import { ui } from '@/lib/theme';

export default function HomePlaces() {
  const router = useRouter();
  const [places, setPlaces] = useState<HomePlace[]>([]);
  const [label, setLabel] = useState('Home');
  const [center, setCenter] = useState<{ lat: number; lng: number } | undefined>();

  const useCurrent = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const pos = await Location.getCurrentPositionAsync({});
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    setCenter(p);
    add(p);
  };
  const add = (p: { lat: number; lng: number }) =>
    setPlaces((ps) => [...ps, { id: uuidv4(), label: label || `Place ${ps.length + 1}`, lat: p.lat, lng: p.lng, radiusM: 150 }]);

  const save = async () => {
    await SafetyNative.setHomePlaces(places); // device-only; never written to the DB
    router.push('/onboarding/baseline-walk');
  };

  return (
    <Screen style={{ maxWidth: 560, width: '100%', alignSelf: 'center' }}>
      <H1>Home places</H1>
      <P muted>Night mode turns on when you’re away from these places in the evening. Tap the map to add one. Your places stay on this phone.</P>
      <Input placeholder="Label (Home, Dorm, …)" value={label} onChangeText={setLabel} />
      <Map center={center} places={places} onPress={add} style={{ height: 300 }} />
      <Row>
        <Button title="Use current location" kind="ghost" icon={Icon.locate(ui.text, 16)} onPress={useCurrent} style={{ flex: 1 }} />
        <Button title="Clear" kind="ghost" onPress={() => setPlaces([])} />
      </Row>
      {places.length > 0 && (
        <Card>
          {places.map((p, i) => (
            <KitRow key={p.id} title={p.label} sub={`${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} · ${p.radiusM} m`} left={Icon.home(ui.text2)} chevron={false} height={48}
              style={i < places.length - 1 ? { borderBottomWidth: 1.5, borderBottomColor: ui.line } : undefined} />
          ))}
        </Card>
      )}
      <Button title={places.length ? 'Save & continue' : 'Skip for now'} onPress={save} />
    </Screen>
  );
}
