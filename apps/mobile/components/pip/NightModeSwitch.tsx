// Night mode on / off. Fall, impact, gait and check-in detection only run while it is on (the engine ignores impacts
// on standby), so this sits on the home screen as well as on your own page.
import React, { useCallback } from 'react';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';
import { SafetyNative } from '@/modules/safety-native';
import { useStore } from '@/lib/store';
import { Switch } from './kit';

export function NightModeSwitch({ style }: { style?: StyleProp<ViewStyle> }) {
  const status = useStore((s) => s.status);
  const nightOn = !!status?.nightMode.active;
  const toggle = useCallback(() => void SafetyNative.setNightMode(nightOn ? 'paused_tonight' : 'on'), [nightOn]);
  if (Platform.OS === 'web') return null;
  return (
    <Switch testID="night-mode-switch" value={nightOn} onChange={toggle} style={style}
      label={`Night mode ${nightOn ? 'on' : 'off'}`}
      hint={nightOn ? 'Watching for falls and check-ins · tap to pause for tonight' : 'Falls and check-ins are not watched · tap to turn on now'} />
  );
}
