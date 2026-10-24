import React from 'react';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';
import type { MapProps } from './Map.types';

export function Map({ center, points, places, onPress, style }: MapProps) {
  const c = center ?? points?.[points.length - 1] ?? places?.[0] ?? { lat: 42.3505, lng: -71.1054 };
  return (
    <MapView
      style={[{ flex: 1, minHeight: 280, borderRadius: 16 }, style]}
      initialRegion={{ latitude: c.lat, longitude: c.lng, latitudeDelta: 0.01, longitudeDelta: 0.01 }}
      userInterfaceStyle="dark"
      onPress={onPress ? (e) => onPress({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude }) : undefined}
    >
      {points && points.length > 1 && <Polyline coordinates={points.map((p) => ({ latitude: p.lat, longitude: p.lng }))} strokeColor="#ff3b5c" strokeWidth={4} />}
      {points?.length ? <Marker coordinate={{ latitude: c.lat, longitude: c.lng }} title="Last known" pinColor="#ff3b5c" /> : null}
      {places?.map((p) => (
        <React.Fragment key={p.id}>
          <Marker coordinate={{ latitude: p.lat, longitude: p.lng }} title={p.label} />
          <Circle center={{ latitude: p.lat, longitude: p.lng }} radius={p.radiusM} strokeColor="#7c9cff" fillColor="#7c9cff22" />
        </React.Fragment>
      ))}
    </MapView>
  );
}
