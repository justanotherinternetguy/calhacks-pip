import React, { useRef, useState } from 'react';
import { TextInput } from 'react-native';
import type { CheckInInputProps } from './CheckInInput.types';

// JS fallback (web / Expo Go): measures key timestamps in JS. Real typing biometrics come from native.
export function CheckInInput({ phrase, autoFocus = true, placeholder, style, onChange, onComplete }: CheckInInputProps) {
  const [typed, setTyped] = useState('');
  const times = useRef<number[]>([]);
  const backspaces = useRef(0);
  const start = useRef<number | null>(null);

  return (
    <TextInput
      autoFocus={autoFocus}
      autoCapitalize="none"
      autoCorrect={false}
      placeholder={placeholder ?? 'type the phrase'}
      placeholderTextColor="#6b7280"
      value={typed}
      style={[{ color: 'white', fontSize: 20, borderWidth: 1, borderColor: '#374151', borderRadius: 12, padding: 14, minHeight: 56 }, style]}
      onKeyPress={(e) => {
        const now = Date.now();
        start.current ??= now;
        times.current.push(now);
        if (e.nativeEvent.key === 'Backspace') backspaces.current += 1;
      }}
      onChangeText={(t) => {
        setTyped(t);
        onChange?.(t);
      }}
      onSubmitEditing={() => {
        const s = start.current ?? Date.now();
        onComplete({ phrase, typed, keyTimesMs: times.current.map((t) => t - s), backspaces: backspaces.current, durationMs: Date.now() - s });
        setTyped('');
        times.current = [];
        backspaces.current = 0;
        start.current = null;
      }}
      returnKeyType="done"
      blurOnSubmit={false}
    />
  );
}
