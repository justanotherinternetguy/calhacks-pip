import type { ConfigContext, ExpoConfig } from 'expo/config';

// app.config.ts runs in Node (no @types/node in this tsconfig), so type `require` locally.
declare const require: (id: string) => any;
declare const __dirname: string;
const fs: { existsSync(p: string): boolean } = require('fs');
const path: { join(...p: string[]): string } = require('path');

/** Firebase / Apple config files are gitignored; only wire them in when present (see docs/PUSH_SETUP.md). */
function localFile(name: string): string | undefined {
  return fs.existsSync(path.join(__dirname, name)) ? `./${name}` : undefined;
}
const GOOGLE_SERVICES_JSON = localFile('google-services.json');       // Android FCM

// The monitor's AI panel reads EXPO_PUBLIC_OPENROUTER_* (only EXPO_PUBLIC_* is inlined into the web bundle).
// Accept the plain names in .env too. This runs before Metro starts, so its workers inherit the alias.
// Only copy values that are set: assigning undefined to process.env stores the string "undefined".
const env = process.env as Record<string, string | undefined>;
if (!env.EXPO_PUBLIC_OPENROUTER_API_KEY && env.OPENROUTER_API_KEY) env.EXPO_PUBLIC_OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
if (!env.EXPO_PUBLIC_OPENROUTER_MODEL && env.OPENROUTER_MODEL) env.EXPO_PUBLIC_OPENROUTER_MODEL = env.OPENROUTER_MODEL;

const LOCATION_WHY =
  'pip checks for signs that you can\'t ask for help when you\'re out at night. Your phone encrypts your location. Your friends see it only if you may be in danger.';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  // The product is "pip"; slug, scheme and package stay as they were so deep links, OAuth redirects and the installed
  // app keep working.
  name: 'Pip',
  slug: 'safe',
  version: '0.1.0',
  scheme: 'safe',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  backgroundColor: '#FBF3E4',
  android: {
    package: 'app.safe.mobile',
    adaptiveIcon: { backgroundColor: '#FBF3E4' },
    ...(GOOGLE_SERVICES_JSON ? { googleServicesFile: GOOGLE_SERVICES_JSON } : {}),
    config: process.env.GOOGLE_MAPS_ANDROID_API_KEY
      ? { googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY } }
      : undefined,
    permissions: [
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_LOCATION',
      'android.permission.FOREGROUND_SERVICE_MICROPHONE',
      'android.permission.RECORD_AUDIO',
      'android.permission.ACTIVITY_RECOGNITION',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.USE_FULL_SCREEN_INTENT',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.USE_BIOMETRIC',
      'android.permission.SCHEDULE_EXACT_ALARM',
      'android.permission.CAMERA',
      'android.permission.VIBRATE',
      'android.permission.WAKE_LOCK',
    ],
  },
  web: { bundler: 'metro', output: 'single' },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { backgroundColor: '#FBF3E4', resizeMode: 'contain' }],
    'expo-secure-store',
    'expo-web-browser',
    ['expo-camera', { cameraPermission: 'Scan a friend\'s QR code to add them.' }],
    [
      'expo-location',
      {
        locationAlwaysAndWhenInUsePermission: LOCATION_WHY,
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
      },
    ],
    // SDK 58 plugin props: icon/largeIcon/color/defaultChannel/sounds (android), mode/enableRemoteNotifications/
    // enableBackgroundRemoteNotifications (ios). defaultChannel = the channel FCM uses when a message omits
    // channel_id; our push function always sends 'alarm' (FCM_CHANNEL), which native AlertManager creates.
    ['expo-notifications', { color: '#FF6B5C', defaultChannel: 'alarm', enableRemoteNotifications: true }],
    './modules/safety-native/app.plugin.js',
  ],
  experiments: { typedRoutes: false },
  extra: {
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
});
