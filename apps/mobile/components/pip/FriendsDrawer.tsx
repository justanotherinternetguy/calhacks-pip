// The friends sidebar: a paper panel that slides in from the right over the map. Opened by the people button (an edge
// swipe would fight Android's back gesture); closed by the backdrop, a swipe right, or the Android back button.
import React, { useEffect, useMemo } from 'react';
import { Animated, BackHandler, Easing, PanResponder, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ht, ui } from '@/lib/theme';

export const drawerWidth = (screenW: number) => Math.min(360, Math.round(screenW * 0.86));

export function FriendsDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const w = drawerWidth(width);
  const x = useMemo(() => new Animated.Value(w), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    Animated.timing(x, { toValue: open ? 0 : w, duration: open ? 260 : 220, easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic), useNativeDriver: true }).start();
  }, [open, w, x]);

  useEffect(() => {
    if (!open || Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [open, onClose]);

  // Drag the panel to the right to dismiss it.
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_, g) => x.setValue(Math.max(0, g.dx)),
    onPanResponderRelease: (_, g) => {
      if (g.dx > w * 0.3 || g.vx > 0.6) onClose();
      else Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 2 }).start();
    },
    onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 2 }).start(),
  }), [onClose, w, x]);

  const backdrop = x.interpolate({ inputRange: [0, w], outputRange: [1, 0] });
  return (
    <View pointerEvents={open ? 'auto' : 'none'} style={StyleSheet.absoluteFill}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(30,27,46,0.45)', opacity: backdrop }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close friends" onPress={onClose} style={StyleSheet.absoluteFill} />
      </Animated.View>
      <Animated.View
        {...pan.panHandlers}
        accessibilityViewIsModal
        style={[s.panel, { width: w, paddingTop: insets.top + 8, paddingBottom: insets.bottom, transform: [{ translateX: x }] }]}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  panel: {
    position: 'absolute', top: 0, bottom: 0, right: 0,
    backgroundColor: ui.panel, borderLeftWidth: 2, borderLeftColor: ht.ink,
    paddingHorizontal: 22,
    shadowColor: ht.ink, shadowOpacity: 0.28, shadowRadius: 24, shadowOffset: { width: -8, height: 0 }, elevation: 12,
  },
});
