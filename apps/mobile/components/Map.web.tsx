import React from 'react';
import { Pressable, Text, View } from 'react-native';
import type { MapProps } from './Map.types';

// Web/demo shim: react-native-maps has no web target. Shows coordinates; a tap "picks" a nearby point.
export function Map({ center, points, places, onPress, style }: MapProps) {
  const last = points?.[points.length - 1];
  return (
    <Pressable
      onPress={() => onPress?.({ lat: (center?.lat ?? 42.3505) + (Math.random() - 0.5) * 0.002, lng: (center?.lng ?? -71.1054) + (Math.random() - 0.5) * 0.002 })}
      style={[{ minHeight: 280, borderRadius: 16, backgroundColor: '#101522', borderWidth: 1, borderColor: '#232a3a', padding: 16, justifyContent: 'center', gap: 6 }, style as object]}
    >
      <Text style={{ color: '#8b93a7' }}>[map placeholder — web build]</Text>
      {last && <Text style={{ color: 'white' }}>Last known: {last.lat.toFixed(5)}, {last.lng.toFixed(5)} ({points!.length} pts)</Text>}
      {places?.map((p) => (
        <View key={p.id}><Text style={{ color: 'white' }}>{p.label}: {p.lat.toFixed(4)}, {p.lng.toFixed(4)} r={p.radiusM}m</Text></View>
      ))}
      {onPress && <Text style={{ color: '#7c9cff' }}>tap to drop a point</Text>}
    </Pressable>
  );
}
