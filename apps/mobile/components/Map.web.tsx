import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { LatLng, MapProps } from './Map.types';

/**
 * Web map: Leaflet + OpenStreetMap tiles, no API key. react-native-maps has no web target, so Leaflet is
 * loaded from unpkg at runtime (CSS + JS tags injected once) and drawn into a plain <div>. Same props as
 * the native Map: trail polyline + "last known" marker from `points`, home places as circles, `onPress`
 * from map clicks. Falls back to a coordinate list if the CDN is unreachable.
 */
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/';
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT: LatLng = { lat: 42.3505, lng: -71.1054 };
const TRAIL = '#ff3b5c';
const PLACE = '#7c9cff';

// Just enough of Leaflet's API for this component (keeps the CDN-loaded global typed without @types/leaflet).
type LLatLng = [number, number];
type LLayer = { addTo(target: LMap | LLayerGroup): LLayer; bindTooltip(text: string): LLayer };
type LLayerGroup = LLayer & { clearLayers(): void };
type LMap = {
  on(ev: 'click', cb: (e: { latlng: { lat: number; lng: number } }) => void): void;
  setView(center: LLatLng, zoom: number): void;
  fitBounds(bounds: unknown, opts?: { padding?: [number, number]; maxZoom?: number }): void;
  invalidateSize(): void;
  remove(): void;
};
type Leaflet = {
  map(el: HTMLElement, opts?: Record<string, unknown>): LMap;
  tileLayer(url: string, opts?: Record<string, unknown>): LLayer;
  layerGroup(): LLayerGroup;
  polyline(pts: LLatLng[], opts?: Record<string, unknown>): LLayer;
  circleMarker(p: LLatLng, opts?: Record<string, unknown>): LLayer;
  circle(p: LLatLng, opts?: Record<string, unknown>): LLayer;
  latLngBounds(pts: LLatLng[]): unknown;
};

let leafletPromise: Promise<Leaflet> | null = null;
function loadLeaflet(): Promise<Leaflet> {
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise<Leaflet>((resolve, reject) => {
    const g = globalThis as unknown as { L?: Leaflet };
    if (g.L) return resolve(g.L);
    if (!document.querySelector(`link[href="${LEAFLET}leaflet.css"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${LEAFLET}leaflet.css`;
      document.head.appendChild(link);
      // Dark tiles for the dark UI: the usual invert/hue-rotate trick on OSM's light tiles.
      const style = document.createElement('style');
      style.textContent = '.safe-dark-tiles{filter:invert(1) hue-rotate(180deg) brightness(.85) contrast(.9)}.leaflet-container{background:#0b0d12;font-family:inherit}';
      document.head.appendChild(style);
    }
    const s = document.createElement('script');
    s.src = `${LEAFLET}leaflet.js`;
    s.async = true;
    s.onload = () => (g.L ? resolve(g.L) : reject(new Error('Leaflet loaded but window.L is missing')));
    s.onerror = () => reject(new Error('could not load Leaflet from unpkg'));
    document.head.appendChild(s);
  }).catch((e) => { leafletPromise = null; throw e; });
  return leafletPromise;
}

export function Map({ center, points, places, onPress, style }: MapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LMap | null>(null);
  const layerRef = useRef<LLayerGroup | null>(null);
  const onPressRef = useRef(onPress);
  const [L, setL] = useState<Leaflet | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { onPressRef.current = onPress; }, [onPress]);
  const last = points?.[points.length - 1];

  // Create the map once the library is in and the host div exists.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((lib) => {
        if (cancelled || !hostRef.current || mapRef.current) return;
        const map = lib.map(hostRef.current, { zoomControl: true, attributionControl: true });
        lib.tileLayer(TILES, { maxZoom: 19, className: 'safe-dark-tiles', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
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

  // Redraw overlays whenever the data changes.
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!L || !map || !layer) return;
    layer.clearLayers();
    const c = center ?? last ?? places?.[0] ?? DEFAULT;
    if (points && points.length > 1) L.polyline(points.map((p) => [p.lat, p.lng] as LLatLng), { color: TRAIL, weight: 4, opacity: 0.9 }).addTo(layer);
    if (last) L.circleMarker([last.lat, last.lng], { radius: 8, color: '#fff', weight: 2, fillColor: TRAIL, fillOpacity: 1 }).bindTooltip('Last known').addTo(layer);
    places?.forEach((p) => {
      L.circle([p.lat, p.lng], { radius: p.radiusM, color: PLACE, weight: 1, fillColor: PLACE, fillOpacity: 0.13 }).addTo(layer);
      L.circleMarker([p.lat, p.lng], { radius: 6, color: PLACE, weight: 2, fillColor: PLACE, fillOpacity: 1 }).bindTooltip(p.label).addTo(layer);
    });
    if (points && points.length > 1) map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as LLatLng)), { padding: [24, 24], maxZoom: 17 });
    else map.setView([c.lat, c.lng], 15);
  }, [L, center, points, places, last]);

  return (
    <View style={[{ minHeight: 280, borderRadius: 16, overflow: 'hidden', backgroundColor: '#101522', borderWidth: 1, borderColor: '#232a3a' }, style]}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {error && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, padding: 16, justifyContent: 'center', gap: 6 }}>
          <Text style={{ color: '#8b93a7' }}>Map unavailable ({error})</Text>
          {last && <Text style={{ color: 'white' }}>Last known: {last.lat.toFixed(5)}, {last.lng.toFixed(5)} ({points!.length} pts)</Text>}
          {places?.map((p) => <Text key={p.id} style={{ color: 'white' }}>{p.label}: {p.lat.toFixed(4)}, {p.lng.toFixed(4)} r={p.radiusM}m</Text>)}
        </View>
      )}
      {!L && !error && <Text style={{ color: '#8b93a7', position: 'absolute', left: 16, top: 16 }}>Loading map…</Text>}
    </View>
  );
}
