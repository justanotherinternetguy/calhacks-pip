import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/lib/theme';

const HOLD_MS = 2000;

/** Hold for 2 s to trigger SOS. Big, forgiving, works with a shaking hand. */
export function SosButton({ onTrigger, active, onCancel }: { onTrigger: () => void; active: boolean; onCancel: () => void }) {
  const progress = useMemo(() => new Animated.Value(0), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);

  const start = () => {
    if (active) return;
    setHolding(true);
    Animated.timing(progress, { toValue: 1, duration: HOLD_MS, useNativeDriver: false }).start();
    timer.current = setTimeout(() => { setHolding(false); progress.setValue(0); onTrigger(); }, HOLD_MS);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    Animated.timing(progress, { toValue: 0, duration: 150, useNativeDriver: false }).start();
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  return (
    <View style={{ alignItems: 'center', gap: 12 }}>
      <Pressable testID="sos-button" onPressIn={start} onPressOut={stop} onPress={active ? onCancel : undefined} accessibilityLabel={active ? 'SOS active, tap to cancel' : 'Hold for SOS'}>
        <Animated.View style={[styles.outer, { transform: [{ scale }], borderColor: active ? colors.danger : holding ? colors.warn : colors.border }]}>
          <Animated.View style={[styles.fill, { opacity: progress }]} />
          <Text style={styles.label}>{active ? 'SOS SENT' : 'SOS'}</Text>
          <Text style={styles.sub}>{active ? 'tap to cancel (biometric)' : holding ? 'keep holding…' : 'hold 2 seconds'}</Text>
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: { width: 220, height: 220, borderRadius: 110, backgroundColor: '#2a1017', borderWidth: 4, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  fill: { position: 'absolute', inset: 0, backgroundColor: colors.danger },
  label: { color: 'white', fontSize: 44, fontWeight: '900', letterSpacing: 2 },
  sub: { color: '#fecdd3', fontSize: 13, marginTop: 4 },
});
