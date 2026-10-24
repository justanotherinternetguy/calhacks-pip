// Expo config plugin for the SafetyNative module.
// - Android: foreground service, boot receiver, QS tile service, widget receiver, prebuilt jniLibs
// - iOS: background modes + usage strings, prebuilt safety xcframework
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withInfoPlist, withDangerousMod, withXcodeProject, AndroidConfig } = require('expo/config-plugins');

const PKG = 'expo.modules.safetynative';
const CORE_OUT = path.join(__dirname, '..', '..', '..', '..', '..', 'core', 'target', 'mobile');

const IOS_BG_MODES = ['location', 'audio', 'processing', 'fetch'];
const IOS_STRINGS = {
  NSLocationAlwaysAndWhenInUseUsageDescription:
    'Safe needs location in the background so it can notice when you are out at night and release an encrypted location to friends only if you may be in danger.',
  NSMotionUsageDescription: 'Motion data is analysed on your phone to notice unsteady walking, falls and long stillness.',
  NSMicrophoneUsageDescription: 'The mic is sampled briefly during night mode to detect screams or breaking glass. Audio never leaves the device.',
  NSFaceIDUsageDescription: 'Face ID confirms that it is really you dismissing an alert.',
};

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
  return true;
}

function ensureOnce(list, key, value) {
  list = list || [];
  const i = list.findIndex((x) => x.$ && x.$[key] === value.$[key]);
  if (i >= 0) list[i] = value;
  else list.push(value);
  return list;
}

const withAndroidComponents = (config) =>
  withAndroidManifest(config, (c) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    const manifest = c.modResults.manifest;
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    for (const p of ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_LOCATION', 'android.permission.FOREGROUND_SERVICE_MICROPHONE', 'android.permission.RECEIVE_BOOT_COMPLETED']) {
      if (!manifest['uses-permission'].some((u) => u.$['android:name'] === p)) manifest['uses-permission'].push({ $: { 'android:name': p } });
    }

    app.service = ensureOnce(app.service, 'android:name', {
      $: {
        'android:name': `${PKG}.SensingService`,
        'android:foregroundServiceType': 'location|microphone',
        'android:exported': 'false',
      },
    });
    app.service = ensureOnce(app.service, 'android:name', {
      $: {
        'android:name': `${PKG}.SosTileService`,
        'android:exported': 'true',
        'android:icon': '@mipmap/ic_launcher',
        'android:label': 'SOS',
        'android:permission': 'android.permission.BIND_QUICK_SETTINGS_TILE',
      },
      'intent-filter': [{ action: [{ $: { 'android:name': 'android.service.quicksettings.action.QS_TILE' } }] }],
    });

    app.receiver = ensureOnce(app.receiver, 'android:name', {
      $: { 'android:name': `${PKG}.BootReceiver`, 'android:exported': 'false' },
      'intent-filter': [
        {
          action: [
            { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
            { $: { 'android:name': 'android.intent.action.MY_PACKAGE_REPLACED' } },
          ],
        },
      ],
    });
    app.receiver = ensureOnce(app.receiver, 'android:name', {
      $: { 'android:name': `${PKG}.SosWidget`, 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] }],
      'meta-data': [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/sos_widget_info' } }],
    });
    return c;
  });

const withAndroidJniLibs = (config) =>
  withDangerousMod(config, [
    'android',
    (c) => {
      const src = path.join(CORE_OUT, 'jniLibs');
      const dst = path.join(c.modRequest.projectRoot, 'modules', 'safety-native', 'android', 'src', 'main', 'jniLibs');
      if (copyDir(src, dst)) console.log('[withSafetyNative] copied jniLibs ->', dst);
      return c;
    },
  ]);

const withIosPlist = (config) =>
  withInfoPlist(config, (c) => {
    const modes = new Set([...(c.modResults.UIBackgroundModes || []), ...IOS_BG_MODES]);
    c.modResults.UIBackgroundModes = [...modes];
    for (const [k, v] of Object.entries(IOS_STRINGS)) c.modResults[k] = c.modResults[k] || v;
    return c;
  });

const withIosFramework = (config) =>
  withXcodeProject(config, (c) => {
    const fwDir = fs.existsSync(CORE_OUT) ? fs.readdirSync(CORE_OUT).find((f) => f.endsWith('.xcframework')) : null;
    if (!fwDir) return c;
    const dst = path.join(c.modRequest.platformProjectRoot, 'Frameworks', fwDir);
    copyDir(path.join(CORE_OUT, fwDir), dst);
    console.log('[withSafetyNative] copied', fwDir, '->', dst);
    // The podspec in modules/safety-native/ios references ../../ios/Frameworks/<name>.xcframework via vendored_frameworks.
    return c;
  });

module.exports = function withSafetyNative(config) {
  config = withAndroidComponents(config);
  config = withAndroidJniLibs(config);
  config = withIosPlist(config);
  config = withIosFramework(config);
  return config;
};
