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
      placeholderTextColor="#B8AC96"
      value={typed}
      style={[{ color: '#1E1B2E', backgroundColor: '#FFFCF5', fontSize: 22, borderWidth: 2, borderColor: '#E6D8BD', borderRadius: 16, paddingHorizontal: 16, minHeight: 54, fontFamily: "Figtree, system-ui, sans-serif" }, style]}
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
