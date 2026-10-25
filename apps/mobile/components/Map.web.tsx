import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { T } from '@/components/pip/kit';
import { ht, ui } from '@/lib/theme';
import type { LatLng, MapProps } from './Map.types';
import { LIGHT_LABELS, LIGHT_TILES, LIGHT_TILES_ATTRIBUTION, TILE_OPTS, loadLeaflet, type LLatLng, type LLayerGroup, type LMap, type Leaflet } from './pip/leaflet';

/**
 * Web trail / places map: Leaflet + CARTO light tiles, no API key. react-native-maps has no web target, so Leaflet is
 * loaded from unpkg at runtime (components/pip/leaflet.ts) and drawn into a plain <div>. Same props as the native
 * Map: coral trail + "last known" pin from `points`, home places as sky circles, `onPress` from map clicks.
 */
const DEFAULT: LatLng = { lat: 42.3505, lng: -71.1054 };
const KEYLINE = { color: ht.ink, weight: 2.5, fillOpacity: 1 };

export function Map({ center, points, places, onPress, style }: MapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LMap | null>(null);
  const layerRef = useRef<LLayerGroup | null>(null);
  const onPressRef = useRef(onPress);
  const [L, setL] = useState<Leaflet | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { onPressRef.current = onPress; }, [onPress]);
  const last = points?.[points.length - 1];

  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((lib) => {
        if (cancelled || !hostRef.current || mapRef.current) return;
        const map = lib.map(hostRef.current, { zoomControl: true, attributionControl: true });
        lib.tileLayer(LIGHT_TILES, { ...TILE_OPTS, attribution: LIGHT_TILES_ATTRIBUTION }).addTo(map);
        lib.tileLayer(LIGHT_LABELS, { ...TILE_OPTS, pane: 'overlayPane', opacity: 0.85 }).addTo(map);
        map.on('click', (e) => onPressRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
        mapRef.current = map;
        layerRef.current = lib.layerGroup();
        layerRef.current.addTo(map);
        setTimeout(() => map.invalidateSize(), 0);
        setL(lib);
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!L || !map || !layer) return;
    layer.clearLayers();
    const c = center ?? last ?? places?.[0] ?? DEFAULT;
    if (points && points.length > 1) L.polyline(points.map((p) => [p.lat, p.lng] as LLatLng), { color: ht.coral, weight: 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
    if (last) L.circleMarker([last.lat, last.lng], { radius: 10, ...KEYLINE, fillColor: ht.coral }).bindTooltip('Last known', { className: 'pip-tip', direction: 'top' }).addTo(layer);
    places?.forEach((p) => {
      L.circle([p.lat, p.lng], { radius: p.radiusM, color: ht.sky, weight: 2, fillColor: ht.sky, fillOpacity: 0.14 }).addTo(layer);
      L.circleMarker([p.lat, p.lng], { radius: 8, ...KEYLINE, fillColor: ht.sky }).bindTooltip(p.label, { className: 'pip-tip', direction: 'top' }).addTo(layer);
    });
    if (points && points.length > 1) map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as LLatLng)), { padding: [24, 24], maxZoom: 17 });
    else map.setView([c.lat, c.lng], 15);
  }, [L, center, points, places, last]);

  return (
    <View style={[{ minHeight: 280, borderRadius: 22, overflow: 'hidden', backgroundColor: '#F6ECD6', borderWidth: 1.5, borderColor: ui.line }, style]}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {error && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, padding: 16, justifyContent: 'center', gap: 6 }}>
          <T style={{ color: ui.quiet }}>Map unavailable ({error})</T>
          {last && <T>Last known: {last.lat.toFixed(5)}, {last.lng.toFixed(5)} ({points!.length} pts)</T>}
          {places?.map((p) => <T key={p.id}>{p.label}: {p.lat.toFixed(4)}, {p.lng.toFixed(4)} r={p.radiusM}m</T>)}
        </View>
      )}
      {!L && !error && <T style={{ color: ui.quiet, position: 'absolute', left: 16, top: 16 }}>Loading map…</T>}
    </View>
  );
}
