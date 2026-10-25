// The map: you and every friend placed where they are, on Google Maps restyled in cream and ink. The camera keeps
// everyone in view (or the subject and you, on a friend's page) and refits when the set of people changes; a locate
// button brings it back after the user has panned away.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PixelRatio, Platform, StyleSheet, View } from 'react-native';
import MapView, { Circle, Marker } from 'react-native-maps';
import { ZONE_RADIUS_M } from '@/lib/friends';
import { ht, ui } from '@/lib/theme';
import { Icon, IconBtn, Pin, T } from './kit';
import { CREAM_MAP_STYLE, DEFAULT_CENTER, describe, framed, placed, type FriendsMapProps, type MapPerson } from './FriendsMap.types';

export type { FriendsMapProps, MapPerson } from './FriendsMap.types';

const PAD = 56;
// Android's fitToCoordinates takes its padding in pixels, iOS in points.
const px = (dp: number) => (Platform.OS === 'android' ? Math.round(dp * PixelRatio.get()) : dp);

/**
 * One pin. Android bitmaps a custom marker the moment tracksViewChanges goes false, which can be before its nested
 * views have drawn, so it tracks for a moment after (re)mounting and then freezes. The key re-mounts it on a change.
 */
function PersonMarker({ p, focused, dim, onSelect }: { p: MapPerson & { loc: { lat: number; lng: number } }; focused: boolean; dim: boolean; onSelect?: (id: string) => void }) {
  const [track, setTrack] = useState(true);
  useEffect(() => { const t = setTimeout(() => setTrack(false), 900); return () => clearTimeout(t); }, []);
  return (
    <Marker identifier={p.id}
      coordinate={{ latitude: p.loc.lat, longitude: p.loc.lng }} anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={track} zIndex={focused ? 3 : p.isMe ? 2 : p.tone === 'high' ? 2 : 1}
      onPress={onSelect && !p.isMe ? () => onSelect(p.id) : undefined} tappable={!!onSelect && !p.isMe}
      accessibilityLabel={p.isMe ? 'You' : p.name}>
      <Pin initial={p.initial} name={p.name} tone={p.tone} isMe={p.isMe} focused={focused} dim={dim} />
    </Marker>
  );
}

export function FriendsMap({ people, anchor, focusId, onSelect, insetBottom = 0, insetTop = 0, style, testID }: FriendsMapProps) {
  const ref = useRef<MapView>(null);
  const [ready, setReady] = useState(false);
  const [moved, setMoved] = useState(false);
  const fitting = useRef(false);
  const me = people.find((p) => p.isMe);

  const frame = useMemo(() => framed(people, focusId), [people, focusId]);
  // Refit on a change in who is placed, not on every metre they walk.
  const frameKey = `${focusId ?? ''}|${placed(people, focusId).filter((p) => p.id === focusId || p.isMe || !focusId).map((p) => p.id).sort().join(',')}|${insetBottom}`;

  const fit = useCallback((animated: boolean) => {
    const map = ref.current;
    if (!map || !frame.length) return;
    fitting.current = true;
    if (frame.length === 1) {
      map.animateCamera({ center: { latitude: frame[0].lat, longitude: frame[0].lng }, zoom: 16 }, { duration: animated ? 500 : 0 });
    } else {
      // mapPadding already keeps the header and sheet out of the visible region; this is just breathing room.
      map.fitToCoordinates(frame.map((p) => ({ latitude: p.lat, longitude: p.lng })), {
        edgePadding: { top: px(PAD), right: px(PAD), bottom: px(PAD), left: px(PAD) }, animated,
      });
    }
    setMoved(false);
    setTimeout(() => { fitting.current = false; }, animated ? 700 : 100);
  }, [frame, insetBottom, insetTop]);

  useEffect(() => { if (ready) fit(true); }, [frameKey, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = frame[0] ?? anchor ?? DEFAULT_CENTER;
  return (
    <View testID={testID} accessible accessibilityRole="image" accessibilityLabel={describe(people)} style={[{ flex: 1 }, style]}>
      <MapView
        ref={ref}
        style={StyleSheet.absoluteFill}
        customMapStyle={CREAM_MAP_STYLE}
        initialRegion={{ latitude: first.lat, longitude: first.lng, latitudeDelta: 0.012, longitudeDelta: 0.012 }}
        mapPadding={{ top: insetTop, right: 0, bottom: insetBottom, left: 0 }}
        showsCompass={false} showsMyLocationButton={false} showsPointsOfInterests={false} showsBuildings={false} showsIndoors={false}
        toolbarEnabled={false} pitchEnabled={false} rotateEnabled={false}
        onMapReady={() => setReady(true)}
        onRegionChange={(_, d) => { if (d?.isGesture && !fitting.current) setMoved(true); }}
      >
        {anchor && (
          <Circle center={{ latitude: anchor.lat, longitude: anchor.lng }} radius={ZONE_RADIUS_M} strokeColor={ht.lilac} strokeWidth={2} fillColor="rgba(182,156,255,0.14)" />
        )}
        {me?.loc && <Circle center={{ latitude: me.loc.lat, longitude: me.loc.lng }} radius={45} strokeColor="rgba(74,168,255,0.0)" fillColor="rgba(74,168,255,0.18)" />}
        {placed(people).map((p) => {
          const focused = focusId === p.id;
          const dim = !!focusId && !focused && !p.isMe;
          return <PersonMarker key={`${p.id}|${p.tone}|${focused}|${dim}|${p.initial}`} p={p} focused={focused} dim={dim} onSelect={onSelect} />;
        })}
      </MapView>
      {!me?.loc && (
        <View pointerEvents="none" style={[styles.note, { top: insetTop + 12 }]}>
          <T style={{ fontSize: 13, lineHeight: 17, color: ui.quiet }}>Finding your position…</T>
        </View>
      )}
      {moved && frame.length > 0 && (
        <IconBtn label="Show everyone" onPress={() => fit(true)} style={[styles.locate, { bottom: insetBottom + 14 }]}>{Icon.locate(ui.text)}</IconBtn>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  note: { position: 'absolute', alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, backgroundColor: ui.panel, borderWidth: 1.5, borderColor: ui.line },
  locate: { position: 'absolute', right: 14 },
});
