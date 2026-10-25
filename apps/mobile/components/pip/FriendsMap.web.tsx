// Web map: Leaflet over CARTO's light tiles (tinted toward cream in CSS), pins drawn as HTML in the site's language.
// Same props and framing rules as the native FriendsMap.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ZONE_RADIUS_M } from '@/lib/friends';
import { ht, tones, ui } from '@/lib/theme';
import { Icon, IconBtn, T } from './kit';
import { LIGHT_LABELS, LIGHT_TILES, LIGHT_TILES_ATTRIBUTION, TILE_OPTS, loadLeaflet, type LLatLng, type LLayerGroup, type LMap, type Leaflet } from './leaflet';
import { DEFAULT_CENTER, describe, framed, placed, type FriendsMapProps, type MapPerson } from './FriendsMap.types';

export type { FriendsMapProps, MapPerson } from './FriendsMap.types';

const PAD = 56;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function pinHtml(p: MapPerson, focused: boolean, dim: boolean) {
  const t = tones[p.tone];
  const d = focused ? 44 : p.isMe ? 30 : 36;
  const fill = p.isMe ? ht.sky : t.hollow ? ht.paper : t.dot;
  const cls = ['pip-pin', dim && 'pip-pin--dim', p.tone === 'high' && !p.isMe && 'pip-pin--pulse'].filter(Boolean).join(' ');
  return `<div class="${cls}" role="button" aria-label="${esc(p.isMe ? 'You' : p.name)}">
    <div class="pip-pin__disc" style="--fill:${fill};width:${d}px;height:${d}px;font-size:${focused ? 19 : 16}px">${p.isMe ? '' : esc(p.initial)}</div>
    <div class="pip-pin__stem"></div>${focused ? `<div class="pip-pin__name">${esc(p.name)}</div>` : ''}
  </div>`;
}

export function FriendsMap({ people, anchor, focusId, onSelect, insetBottom = 0, insetTop = 0, style, testID }: FriendsMapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LMap | null>(null);
  const layerRef = useRef<LLayerGroup | null>(null);
  const onSelectRef = useRef(onSelect);
  const [L, setL] = useState<Leaflet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  const fitting = useRef(false);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  const me = people.find((p) => p.isMe);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet()
      .then((lib) => {
        if (cancelled || !hostRef.current || mapRef.current) return;
        // No zoom buttons: they would sit under the floating header, and the wheel / pinch still zooms.
        const map = lib.map(hostRef.current, { zoomControl: false, attributionControl: true });
        lib.tileLayer(LIGHT_TILES, { ...TILE_OPTS, attribution: LIGHT_TILES_ATTRIBUTION }).addTo(map);
        lib.tileLayer(LIGHT_LABELS, { ...TILE_OPTS, pane: 'overlayPane', opacity: 0.85 }).addTo(map);
        (map as unknown as { on(ev: string, cb: () => void): void }).on('dragstart', () => { if (!fitting.current) setMoved(true); });
        (map as unknown as { on(ev: string, cb: () => void): void }).on('zoomstart', () => { if (!fitting.current) setMoved(true); });
        mapRef.current = map;
        layerRef.current = lib.layerGroup();
        layerRef.current.addTo(map);
        map.setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 15);
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

  // Pins and circles, redrawn on every snapshot (once a second).
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current;
    if (!L || !map || !layer) return;
    layer.clearLayers();
    if (anchor) L.circle([anchor.lat, anchor.lng], { radius: ZONE_RADIUS_M, color: ht.lilac, weight: 2, fillColor: ht.lilac, fillOpacity: 0.14 }).addTo(layer);
    if (me?.loc) L.circle([me.loc.lat, me.loc.lng], { radius: 45, stroke: false, fillColor: ht.sky, fillOpacity: 0.18 }).addTo(layer);
    for (const p of placed(people)) {
      const focused = focusId === p.id;
      const dim = !!focusId && !focused && !p.isMe;
      const d = focused ? 44 : p.isMe ? 30 : 36;
      const h = d + 10 + (focused ? 22 : 0);
      const icon = L.divIcon({ className: 'pip-pin-wrap', html: pinHtml(p, focused, dim), iconSize: [Math.max(d, 90), h], iconAnchor: [Math.max(d, 90) / 2, d + 10] });
      const m = L.marker([p.loc.lat, p.loc.lng], { icon, keyboard: true, title: p.isMe ? 'You' : p.name, zIndexOffset: focused ? 300 : p.isMe ? 200 : p.tone === 'high' ? 200 : 0 });
      if (!p.isMe) {
        if (!focused) m.bindTooltip(p.name, { direction: 'top', offset: [0, -d - 6], className: 'pip-tip' });
        m.on('click', () => onSelectRef.current?.(p.id));
        m.on('keypress', (e) => { if (e.originalEvent?.key === 'Enter') onSelectRef.current?.(p.id); });
      }
      m.addTo(layer);
    }
  }, [L, people, anchor, focusId, me?.loc]);

  // The camera: refit when the set of framed people changes, not on every metre.
  const frame = useMemo(() => framed(people, focusId), [people, focusId]);
  const frameKey = `${focusId ?? ''}|${placed(people, focusId).filter((p) => p.id === focusId || p.isMe || !focusId).map((p) => p.id).sort().join(',')}|${insetBottom}`;
  const fit = (animate: boolean) => {
    const map = mapRef.current;
    if (!L || !map || !frame.length) return;
    fitting.current = true;
    if (frame.length === 1) map.flyTo([frame[0].lat, frame[0].lng], 16, { duration: animate ? 0.6 : 0 });
    else map.flyToBounds(L.latLngBounds(frame.map((p) => [p.lat, p.lng] as LLatLng)), { paddingTopLeft: [PAD, PAD + insetTop], paddingBottomRight: [PAD, PAD + insetBottom], maxZoom: 17, duration: animate ? 0.6 : 0 });
    setMoved(false);
    setTimeout(() => { fitting.current = false; }, animate ? 800 : 100);
  };
  useEffect(() => { fit(true); }, [L, frameKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View testID={testID} accessible accessibilityRole="image" accessibilityLabel={describe(people)} style={[{ flex: 1, backgroundColor: '#F6ECD6' }, style]}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      {error && (
        <View style={[styles.note, { top: insetTop + 12 }]}>
          <T style={{ fontSize: 13, color: ui.quiet }}>Map unavailable ({error})</T>
        </View>
      )}
      {!L && !error && <View style={[styles.note, { top: insetTop + 12 }]}><T style={{ fontSize: 13, color: ui.quiet }}>Loading map…</T></View>}
      {L && !me?.loc && <View pointerEvents="none" style={[styles.note, { top: insetTop + 12 }]}><T style={{ fontSize: 13, color: ui.quiet }}>Waiting for your position…</T></View>}
      {moved && frame.length > 0 && (
        <IconBtn label="Show everyone" onPress={() => fit(true)} style={[styles.locate, { bottom: insetBottom + 14 }]}>{Icon.locate(ui.text)}</IconBtn>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  note: { position: 'absolute', alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, backgroundColor: ui.panel, borderWidth: 1.5, borderColor: ui.line, zIndex: 500 },
  locate: { position: 'absolute', right: 14, zIndex: 500 },
});
