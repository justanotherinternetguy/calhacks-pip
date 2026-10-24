import type { StyleProp, ViewStyle } from 'react-native';

export type CheckInResult = { phrase: string; typed: string; keyTimesMs: number[]; backspaces: number; durationMs: number };

/**
 * Native view `SafetyNativeTypingView` (registered inside the `SafetyNative` module) must accept these
 * props and fire `onComplete` with CheckInResult in `nativeEvent` when the user submits (return key).
 * `onChange` is optional and carries `{ typed: string }` for live UI.
 */
export type CheckInInputProps = {
  phrase: string;
  autoFocus?: boolean;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
  onChange?: (typed: string) => void;
  onComplete: (r: CheckInResult) => void;
};
