import type { SafetyNativeModuleType } from './SafetyNative.types';
import { MockSafetyNative } from './MockSafetyNative';

const SafetyNative: SafetyNativeModuleType = new MockSafetyNative();
export default SafetyNative;
