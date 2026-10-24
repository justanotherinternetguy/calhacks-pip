import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { Button, Card, H1, Input, P, Row, Screen } from '@/components/ui';
import { Map } from '@/components/Map';
import { SafetyNative, type HomePlace } from '@/modules/safety-native';

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
    setPlaces((ps) => [...ps, { id: crypto.randomUUID(), label: label || `Place ${ps.length + 1}`, lat: p.lat, lng: p.lng, radiusM: 150 }]);

  const save = async () => {
    await SafetyNative.setHomePlaces(places); // device-only; never written to the DB
    router.push('/onboarding/baseline-walk');
  };

  return (
    <Screen>
      <H1>Home places</H1>
      <P muted>Night mode turns on when you're away from these during your evening window. Stored only on this phone.</P>
      <Input placeholder="Label (Home, Dorm, …)" value={label} onChangeText={setLabel} />
      <Map center={center} places={places} onPress={add} style={{ height: 300 }} />
      <Row>
        <Button title="Use current location" kind="ghost" onPress={useCurrent} style={{ flex: 1 }} />
        <Button title="Clear" kind="ghost" onPress={() => setPlaces([])} />
      </Row>
      {places.map((p) => (
        <Card key={p.id}><P>{p.label} · {p.lat.toFixed(4)}, {p.lng.toFixed(4)} · {p.radiusM} m</P></Card>
      ))}
      <Button title={places.length ? 'Save & continue' : 'Skip for now'} onPress={save} />
    </Screen>
  );
}
