import { requireOptionalNativeModule } from 'expo';
import type { SafetyNativeModuleType } from './SafetyNative.types';
import { MockSafetyNative } from './MockSafetyNative';

// Real module in dev builds; falls back to the JS mock in Expo Go so the UI can be demoed.
const native = requireOptionalNativeModule<SafetyNativeModuleType>('SafetyNative');
const SafetyNative: SafetyNativeModuleType = native ?? new MockSafetyNative();
if (!native) console.warn('[SafetyNative] native module not found; using JS mock');

export default SafetyNative;
