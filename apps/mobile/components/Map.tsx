import React from 'react';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';
import { View } from 'react-native';
import { Pin } from '@/components/pip/kit';
import { CREAM_MAP_STYLE } from '@/components/pip/FriendsMap.types';
import { ht, ui } from '@/lib/theme';
import type { MapProps } from './Map.types';

/** A trail map (incident screens) or a places picker (onboarding): coral trail, sky home circles, cream tiles. */
export function Map({ center, points, places, onPress, style }: MapProps) {
  const c = center ?? points?.[points.length - 1] ?? places?.[0] ?? { lat: 42.3505, lng: -71.1054 };
  return (
    <View style={[{ minHeight: 280, borderRadius: 22, overflow: 'hidden', borderWidth: 1.5, borderColor: ui.line }, style]}>
      <MapView
        style={{ flex: 1 }}
        customMapStyle={CREAM_MAP_STYLE}
        initialRegion={{ latitude: c.lat, longitude: c.lng, latitudeDelta: 0.01, longitudeDelta: 0.01 }}
        showsCompass={false} showsPointsOfInterests={false} toolbarEnabled={false}
        onPress={onPress ? (e) => onPress({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude }) : undefined}
      >
        {points && points.length > 1 && <Polyline coordinates={points.map((p) => ({ latitude: p.lat, longitude: p.lng }))} strokeColor={ht.coral} strokeWidth={5} lineCap="round" lineJoin="round" />}
        {points?.length ? (
          <Marker coordinate={{ latitude: c.lat, longitude: c.lng }} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false} title="Last known">
            <Pin initial="" tone="high" />
          </Marker>
        ) : null}
        {places?.map((p) => (
          <React.Fragment key={p.id}>
            <Marker coordinate={{ latitude: p.lat, longitude: p.lng }} anchor={{ x: 0.5, y: 1 }} tracksViewChanges={false} title={p.label}>
              <Pin initial={(p.label.trim()[0] ?? 'H').toUpperCase()} tone="out" isMe />
            </Marker>
            <Circle center={{ latitude: p.lat, longitude: p.lng }} radius={p.radiusM} strokeColor={ht.sky} strokeWidth={2} fillColor="rgba(74,168,255,0.14)" />
          </React.Fragment>
        ))}
      </MapView>
    </View>
  );
}
