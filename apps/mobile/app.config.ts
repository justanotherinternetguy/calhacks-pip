import type { ConfigContext, ExpoConfig } from 'expo/config';

const LOCATION_WHY =
  'Safe watches for signs that you cannot ask for help while you are out at night. Location is encrypted on your phone and is only released to your friends if you may be in danger.';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Safe',
  slug: 'safe',
  version: '0.1.0',
  scheme: 'safe',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  backgroundColor: '#0b0d12',
  ios: {
    bundleIdentifier: 'app.safe.mobile',
    supportsTablet: false,
    infoPlist: {
      UIBackgroundModes: ['location', 'audio', 'processing', 'fetch'],
      NSLocationAlwaysAndWhenInUseUsageDescription: LOCATION_WHY,
      NSLocationWhenInUseUsageDescription: LOCATION_WHY,
      NSMotionUsageDescription:
        'Motion data is used on your phone to notice unsteady walking, hard falls and long stillness. It never leaves the device.',
      NSMicrophoneUsageDescription:
        'During night mode the mic is sampled a few seconds at a time to detect screams or breaking glass. Audio is analysed in memory and never stored or uploaded.',
      NSFaceIDUsageDescription: 'Face ID confirms that it is really you dismissing an alert.',
      NSCameraUsageDescription: 'The camera scans a friend\'s QR code to add them to your group.',
      BGTaskSchedulerPermittedIdentifiers: ['app.safe.mobile.baseline'],
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'app.safe.mobile',
    adaptiveIcon: { backgroundColor: '#0b0d12' },
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
    ['expo-splash-screen', { backgroundColor: '#0b0d12', resizeMode: 'contain' }],
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
    ['expo-notifications', { color: '#ff3b5c' }],
    './modules/safety-native/app.plugin.js',
  ],
  experiments: { typedRoutes: false },
  extra: { eas: { projectId: process.env.EAS_PROJECT_ID } },
});
