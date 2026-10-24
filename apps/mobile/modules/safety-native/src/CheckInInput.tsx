import React from 'react';
import { requireNativeView } from 'expo';
import type { CheckInInputProps, CheckInResult } from './CheckInInput.types';
import { CheckInInput as JsCheckInInput } from './CheckInInput.web';

// Event names must match SafetyNativeModule's View definition: Events("onKey", "onSubmit").
type NativeProps = Omit<CheckInInputProps, 'onChange' | 'onComplete'> & {
  onKey?: (e: { nativeEvent: { typed: string } }) => void;
  onSubmit: (e: { nativeEvent: CheckInResult }) => void;
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
      onKey={onChange ? (e) => onChange(e.nativeEvent.typed) : undefined}
      onSubmit={(e) => onComplete(e.nativeEvent)}
    />
  );
}
