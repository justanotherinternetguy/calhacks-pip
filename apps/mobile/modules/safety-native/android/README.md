# SafetyNative — Android

Kotlin side of the `SafetyNative` Expo module: persistent sensing service, night-mode controller,
check-in / alarm UI, location escrow, and Supabase uploads. All detection runs in the Rust core
(`core/crates/safety-ffi`, exposed through uniffi as package `uniffi.safety`).

## Layout

```
android/
  build.gradle                      expo-modules-core conventions, minSdk 26, Java 17
  src/main/AndroidManifest.xml      service, receivers, QS tile, widget, lock-screen activity
  src/main/assets/                  model-v1.toml (copied from core/config at build), yamnet.tflite, yamnet_class_map.csv
  src/main/jniLibs/<abi>/libsafety_ffi.so        (generated, git-ignored)
  src/main/java/uniffi/safety/safety.kt          (generated, git-ignored)
  src/main/java/expo/modules/safetynative/
    SafetyNativeModule.kt     JS facade (CONTRACTS §2); forwards to SafetyRuntime
    SafetyRuntime.kt          process singleton: wiring, engine-event dispatch, incidents, status
    SensingService.kt         foreground service + NightModeController, 50 Hz motion, location, 1 s tick
    EngineHolder.kt           SafetyEngine lifecycle, Keystore-encrypted baseline, 10-min autosave
    EscrowManager.kt          identity, day/hour keys, Shamir shares, release, friend-side caches
    Uploaders.kt              Heartbeat (2 min), Location (1–5 min, encrypted), Proximity (2 min)
    SupabaseRest.kt           OkHttp PostgREST / RPC / functions client
    AudioMonitor.kt           AudioRecord 16 kHz duty cycle; YamnetClassifier.kt (TFLite)
    AlertManager.kt           channels, check-in notification, remote ring, push fan-out
    SosManager.kt             manual SOS + biometric cancel
    SafetyNativeTypingView.kt native typing view (per-key timing) + TypingTracker
    CheckInActivity.kt        lock-screen "You okay?" screen
    BootReceiver / GeofenceReceiver / ActivityTransitionReceiver / AlarmReceiver
    SosTileService.kt / SosWidget.kt
    TraceInjector.kt          debug-only trace replay
    Prefs.kt / PermissionHelper.kt
```

## Build steps

1. **Rust core → `.so`** (from `core/`):
   ```sh
   cargo install cargo-ndk
   rustup target add aarch64-linux-android x86_64-linux-android
   cargo ndk -t arm64-v8a -t x86_64 -o ../apps/mobile/modules/safety-native/android/src/main/jniLibs \
     build --release -p safety-ffi
   ```
   Produces `jniLibs/arm64-v8a/libsafety_ffi.so` and `jniLibs/x86_64/libsafety_ffi.so`.
2. **Kotlin bindings** (uniffi 0.29, proc-macro mode, library-based generation):
   ```sh
   cargo run -p safety-ffi --bin uniffi-bindgen -- generate --library \
     target/aarch64-linux-android/release/libsafety_ffi.so --language kotlin \
     --out-dir ../apps/mobile/modules/safety-native/android/src/main/java
   ```
   Writes `java/uniffi/safety/safety.kt`. The bindings load the library through JNA (`jna:5.14.0@aar`).
3. **YAMNet assets**: download the TFLite YAMNet from TF Hub / Kaggle (`yamnet.tflite`, ~4 MB, input
   `[15600]` float32 @ 16 kHz, output 0 = 521 scores) and its `yamnet_class_map.csv` into
   `src/main/assets/`. `YamnetClassifier` resolves the Screaming / Shout / Yell / Glass / Shatter indices by
   name from the CSV so a re-exported model cannot silently shift them. Without the asset the audio
   booster is simply disabled; the model works without it.
4. `core/build-mobile.sh` is expected to run steps 1–2; `model-v1.toml` is copied into assets by the
   `copyModelConfig` Gradle task.
5. The app's Expo config plugin must add the permissions and the `foregroundServiceType` declaration to the
   app manifest (this module declares them too with `tools:node="merge"`), and request the
   `FOREGROUND_SERVICE_LOCATION|MICROPHONE|SPECIAL_USE` Play declarations.

## Runtime rules worth knowing

- **Boot without mic.** Android 14+ refuses to start a microphone-type foreground service from the
  background. `BootReceiver` restarts `SensingService` with `allowMic=false` and posts a "tap to re-arm"
  notification. Opening the app calls `configure`, which restarts the service with `allowMic=true`; the
  microphone type is only added to the service when a night session starts.
- **Pre-permission start.** Before the location permission is granted, the service runs as `specialUse`
  (Android 14+ throws on a location-type FGS without the permission). `requestPermission` sends
  `ACTION_RECHECK` so the type is upgraded.
- **Baseline + secrets while locked.** The baseline blob is AES-GCM encrypted with an Android Keystore
  key created with `setUserAuthenticationRequired(false)`; prefs use `EncryptedSharedPreferences`
  (Keystore-wrapped master key). Both are readable after a reboot without the user unlocking.
- **Audio is never stored.** PCM lives in one `ShortArray`, is classified, zeroed, and dropped.
- **Alarm tone is synthesized** (880 Hz beep on `USAGE_ALARM`, `STREAM_ALARM` at max volume), so no raw
  audio asset is required.
- **dontkillmyapp.** Samsung / Xiaomi / Huawei / OnePlus kill foreground services unless the app is
  excluded from battery optimization and "auto-start" is enabled. `requestPermission('batteryUnrestricted')`
  opens the ignore-battery-optimizations dialog; onboarding should link to https://dontkillmyapp.com for
  the OEM-specific steps. The service returns `START_STICKY`, holds a partial wake lock only during night
  sessions, and uses `setExactAndAllowWhileIdle` for the check-in deadline.

## Protocol conventions (CONTRACTS.md §5; iOS must match)

| Item | Android implementation |
|---|---|
| `hour_index` | `floor(unix_ms / 3_600_000)` — UTC-absolute hour number (u32), NOT local hour of day; used for `derive_hour_key`, `location_blobs.hour_index`, `released_keys.hour_index` (release = current and next hour) |
| `epoch_id` | `epochs.id` uuid as a lowercase string; `epochs.day` is the local calendar day and K_day rotates at local midnight (same as iOS) |
| `key_shares` AAD | `"share\|{epochId}\|{recipientUserId}"`, plaintext = share bytes, index in `share_index` |
| `released_keys` AAD | `"hour\|{epochId}\|{hourIndex}"`, plaintext = `K_h` |
| `unlock_approvals` AAD | `"approval\|{subjectUserId}\|{epochId}"`, plaintext = `[index u8] ‖ share bytes` |
| `location_blobs.seq` | upload wall-clock unix ms; AAD inside `encrypt_location` is `"{user_id}\|{epoch_id}\|{seq}"` |
| Shamir `k` | `clamp(max(2, threshold_k), 2, n)`; `n` = active members excluding self; `n < 2` ⇒ no shares, fallback unlock disabled |
| group proximity key | `SHA-256(UTF-8 "safe/proximity\|{groupId}\|{YYYY-MM-DD}")` with the date in **UTC** — deterministic so every member derives it; the server can brute-force cells (accepted v1 risk) |
| heartbeat | `PATCH devices?id=eq.{deviceId}` per CONTRACTS §3 (no RPC exists in the schema) |
| check timeout | native schedules an exact alarm at `deadline_ms` and pushes `UserAction.CheckTimeout` if still in `Check` |

## Debug

`injectTrace(json)` (debuggable builds only) replays `{speed, motion[], context[], audio[]}` through the
live engine with timestamps re-based to now; events fire exactly like real ones, so point it at a test
Supabase project.
