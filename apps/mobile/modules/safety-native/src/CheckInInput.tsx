import React from 'react';
import { requireNativeView } from 'expo';
import type { CheckInInputProps, CheckInResult } from './CheckInInput.types';
import { CheckInInput as JsCheckInInput } from './CheckInInput.web';

type NativeProps = Omit<CheckInInputProps, 'onChange' | 'onComplete'> & {
  onChange?: (e: { nativeEvent: { typed: string } }) => void;
  onComplete: (e: { nativeEvent: CheckInResult }) => void;
};

let NativeView: React.ComponentType<NativeProps> | null = null;
try {
  NativeView = requireNativeView<NativeProps>('SafetyNative', 'SafetyNativeTypingView');
} catch {
  NativeView = null; // Expo Go / view not registered yet → JS fallback
}

export function CheckInInput(props: CheckInInputProps) {
  if (!NativeView) return <JsCheckInInput {...props} />;
  const { onChange, onComplete, ...rest } = props;
  return (
    <NativeView
      {...rest}
      style={[{ minHeight: 56 }, props.style]}
      onChange={onChange ? (e) => onChange(e.nativeEvent.typed) : undefined}
      onComplete={(e) => onComplete(e.nativeEvent)}
    />
  );
}
