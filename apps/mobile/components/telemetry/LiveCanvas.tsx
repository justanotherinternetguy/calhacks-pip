import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '@/lib/theme';
import type { LiveCanvasProps } from './LiveCanvas.types';

/**
 * Native build: the telemetry console is a browser tool, so there is no canvas here — just a sized
 * placeholder so the layout matches. The real renderer is LiveCanvas.web.tsx (Metro picks `.web.tsx` on web).
 */
export function LiveCanvas({ height, style, placeholder = 'Live charts render in the web monitor', testID }: LiveCanvasProps) {
  return (
    <View testID={testID} style={[styles.box, { height }, style]}>
      <Text style={styles.text}>{placeholder}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.bg, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', padding: 8 },
  text: { color: colors.muted, fontSize: 12, textAlign: 'center' },
});
