// Hold two seconds to call your friends: a coral-wash pill on an ink ledge with a coral ring, as on the site. The hold
// fills it with coral from the left. Once sent it turns solid ink with a pulsing coral mark, and a tap stands it down
// (fingerprint).
// Forgiving by design: a shaking hand can hold it; letting go early cancels.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Vibration, View, type StyleProp, type ViewStyle } from 'react-native';
import { ht } from '@/lib/theme';
import { D, Dot } from './kit';

export const HOLD_MS = 2000;
const LEDGE = 3;

export function HoldForHelp({ active, pending, onTrigger, onStandDown, style, testID = 'sos-button' }: {
  /** an SOS (or snatch alert) is running */
  active: boolean;
  /** the stand-down is waiting on the fingerprint */
  pending?: boolean;
  onTrigger: () => void;
  onStandDown: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const progress = useMemo(() => new Animated.Value(0), []);
  const sink = useMemo(() => new Animated.Value(0), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The release that ends the triggering hold must not count as the tap that stands the alert down.
  const swallowRelease = useRef(false);
  const [holding, setHolding] = useState(false);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const start = () => {
    Animated.timing(sink, { toValue: LEDGE, duration: 60, useNativeDriver: true }).start();
    if (active) return;
    setHolding(true);
    Animated.timing(progress, { toValue: 1, duration: HOLD_MS, easing: Easing.linear, useNativeDriver: true }).start();
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      progress.setValue(0);
      try { Vibration.vibrate(40); } catch {}
      swallowRelease.current = true;
      onTrigger();
    }, HOLD_MS);
  };
  const tap = () => {
    if (swallowRelease.current) { swallowRelease.current = false; return; }
    if (active && !pending) onStandDown();
  };
  const stop = () => {
    Animated.timing(sink, { toValue: 0, duration: 90, useNativeDriver: true }).start();
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    Animated.timing(progress, { toValue: 0, duration: 160, useNativeDriver: true }).start();
  };

  const label = active ? (pending ? 'Confirm it’s you…' : 'Friends know · tap to stand down') : holding ? 'Keep holding…' : 'Hold for help';
  const fg = active ? ht.cream : holding ? ht.ink : ht.coralDeep;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={active ? 'Your friends know. Tap to stand down with your fingerprint' : 'Hold for two seconds to alert your friends and open your location to them'}
      onPressIn={start}
      onPressOut={stop}
      onPress={tap}
      style={[{ paddingBottom: LEDGE }, style]}
    >
      <View style={[s.ledge, { backgroundColor: active ? ht.ledge : ht.ink }]} />
      <Animated.View style={[s.face, active && s.faceActive, { transform: [{ translateY: sink }] }]}>
        {!active && <Animated.View pointerEvents="none" style={[s.fill, { transform: [{ scaleX: progress }] }]} />}
        <View style={s.inner}>
          {active ? <Dot tone="high" size={14} /> : <View style={[s.ring, holding && { borderColor: ht.ink }]} />}
          <D style={{ fontSize: 17, lineHeight: 22, color: fg }} numberOfLines={1}>{label}</D>
        </View>
      </Animated.View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  ledge: { position: 'absolute', left: 0, right: 0, top: LEDGE, bottom: 0, borderRadius: 999 },
  // coral at 16 % over paper: the site's --coral-wash, made opaque so the map never shows through
  face: { height: 52, borderRadius: 999, overflow: 'hidden', backgroundColor: '#FFE3D9', borderWidth: 2, borderColor: ht.ink, justifyContent: 'center' },
  faceActive: { backgroundColor: ht.ink, borderColor: ht.ink },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '100%', backgroundColor: ht.coral, transformOrigin: 'left' },
  inner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 20 },
  ring: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: ht.coral },
});
