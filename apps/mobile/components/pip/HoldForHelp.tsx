// The one big button: hold two seconds to call your friends. A coral face on an ink ledge; the hold fills it with ink
// from the left. Once sent it turns solid ink with a pulsing coral mark, and a tap stands it down (fingerprint).
// Forgiving by design: a shaking hand can hold it; letting go early cancels.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Vibration, View, type StyleProp, type ViewStyle } from 'react-native';
import { ht, ui } from '@/lib/theme';
import { Caps, D, Dot, T } from './kit';

export const HOLD_MS = 2000;
const LEDGE = 5;

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

  const title = active ? 'Your friends know.' : holding ? 'Calling friends…' : 'Hold for help';
  const sub = active
    ? pending ? 'Confirm it’s you…' : 'Your location is open to them. Tap to stand down · needs your fingerprint.'
    : holding ? 'Let go to cancel.' : 'Hold two seconds to alert your friends and open your location to them.';
  const fg = active ? ht.cream : ht.ink;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={active ? 'Your friends know. Tap to stand down with your fingerprint' : 'Hold for two seconds to call your friends'}
      onPressIn={start}
      onPressOut={stop}
      onPress={tap}
      style={[{ paddingBottom: LEDGE }, style]}
    >
      <View style={[s.ledge, { backgroundColor: active ? ht.ledge : ht.ink }]} />
      <Animated.View style={[s.face, active && s.faceActive, { transform: [{ translateY: sink }] }]}>
        {!active && <Animated.View pointerEvents="none" style={[s.fill, { transform: [{ scaleX: progress }] }]} />}
        <View style={s.inner}>
          <View style={{ width: 28, alignItems: 'center' }}>
            {active ? <Dot tone="high" size={14} /> : <View style={[s.mark, holding && { backgroundColor: ht.cream }]} />}
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            {holding && !active && <Caps color={ht.cream}>KEEP HOLDING</Caps>}
            <D style={{ fontSize: 24, lineHeight: 28, color: holding ? ht.cream : fg }}>{title}</D>
            <T style={{ fontSize: 13, lineHeight: 18, color: active ? ht.creamSoft : holding ? ht.creamSoft : ht.inkMid }}>{sub}</T>
          </View>
        </View>
      </Animated.View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  ledge: { position: 'absolute', left: 0, right: 0, top: LEDGE, bottom: 0, borderRadius: 28 },
  face: { minHeight: 104, borderRadius: 28, overflow: 'hidden', backgroundColor: ht.coral, borderWidth: 2, borderColor: ht.ink, justifyContent: 'center' },
  faceActive: { backgroundColor: ht.ink, borderColor: ht.ink },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '100%', backgroundColor: ht.ink, transformOrigin: 'left' },
  inner: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 18, paddingHorizontal: 20 },
  mark: { width: 14, height: 14, borderRadius: 7, backgroundColor: ht.paper, borderWidth: 1.5, borderColor: ui.keyline },
});
