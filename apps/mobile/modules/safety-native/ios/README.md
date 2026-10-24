# SafetyNative — iOS

Swift side of the `SafetyNative` Expo module (CONTRACTS §2 + §6). Owns everything that must keep running while
JS is asleep: night-mode controller, motion (10 Hz idle / 50 Hz + gyro on demand), location, YAMNet audio, the
Rust engine tick, heartbeats, encrypted location + proximity uploads, key escrow, notifications, alarm, manual
SOS, touch / unlock tracking and the live dashboard feed.

| File | What |
|---|---|
| `SafetyNativeModule.swift` | Expo `Module` facade (every method/event from CONTRACTS §2) + `SafetyNativeAppDelegate` subscriber |
| `SensingCoordinator.swift` | Singleton owning the `SafetyEngine`; 1 s tick (5 s idle); `EngineEvent` → notifications / rows / push / JS events; dashboard feed |
| `NightModeController.swift` | Home geofences + significant-change relaunch, evening window, modes, continuous location in night mode |
| `Sensors.swift` | `MotionSampler` (LOW 10 Hz accel / FULL 50 Hz + gyro → 1 s batches), `ActivityTracker`, `DeviceState` (screen/unlock/battery) |
| `TouchTracker.swift` | `Context.lastTouchMs` from in-app touches + unlock notifications; owner unlock → `UserAction.phoneUnlocked` |
| `Uploaders.swift` | `HeartbeatUploader` (2 min), `LocationUploader` (engine-adaptive, `encryptLocation` under `K_h`), `ProximityUploader` (2 min) |
| `EscrowManager.swift` | Identity in Keychain, K_day rotation + Shamir shares sealed to friends, K_h derivation, release on unlock, friend-side caches |
| `AudioMonitor.swift` | `AVAudioEngine` kept alive all night; `YamnetClassifier` (TFLite) on 0.975 s @ 16 kHz windows, 5 s / 30 s duty, 2 min boost |
| `AlertManager.swift` | `UNUserNotificationCenter` (CHECKIN category, time-sensitive), mic nudge, loud looping alarm |
| `SosManager.swift` / `AppIntents.swift` / `Widget/SosWidget.swift` | Manual SOS: in-app, Action Button / Siri intent, lock-screen widget stub |
| `TraceInjector.swift` | Debug replay of recorded traces with a virtual clock (simulator / Maestro) |
| `SafetyNativeTypingView.swift` | Native check-in input with per-key timing (`onKey`, `onSubmit`) |
| `SupabaseRest.swift`, `Keychain.swift`, `Base64.swift` | PostgREST/RPC/functions client; Keychain + protected file store; `Data` base64/zeroize helpers + clock |

## Rust core (uniffi)

`core/build-mobile.sh` writes **`ios/Frameworks/safety.xcframework`** (static `libsafety_ffi.a`, arm64 device +
simulator, headers attached) and **`ios/Generated/`**: `safety.swift` (uniffi Swift bindings), `safetyFFI.h`
(the C FFI header) and a module map declaring Clang module **`safetyFFI`** (`module.modulemap` from the build
script, `safetyFFI.modulemap` straight out of `uniffi-bindgen`; the podspec accepts either), plus
`ios/Resources/model-v1.toml`.

How it is wired (`SafetyNative.podspec`):

- `Generated/*.swift` is compiled **into this pod**, so every uniffi type (`SafetyEngine`, `Identity`,
  `EngineEvent`, `sealTo(...)`, ...) is part of the `SafetyNative` module itself. Hand-written files therefore
  **do not import anything** for the Rust core (there is no `import safety`; the module is not called that).
- `Generated/safety.swift` does `#if canImport(safetyFFI) import safetyFFI #endif`. The podspec hands the module
  map to Clang explicitly via `OTHER_SWIFT_FLAGS = -Xcc -fmodule-map-file=$(PODS_TARGET_SRCROOT)/Generated/<map>`
  and keeps `Generated/safetyFFI.h` + `Generated/*.modulemap` as `preserve_paths`. The header is intentionally
  **not** a pod source/public header: putting it in the `SafetyNative` umbrella would define the FFI types twice.
- The xcframework is vendored when present. Without it the pod still installs (JS work), but the app fails to
  link with undefined `uniffi_safety_ffi_*` symbols.

API facts the Swift side relies on (verified against `Generated/safety.swift`, 2026-10-24):

- Rust `Vec<u8>` ↔ Swift **`Data`** (not `[UInt8]`): `Identity.{x25519Secret,x25519Public,ed25519Secret,ed25519Public}`,
  `Share.data`, `newDayKey()`, `deriveHourKey(dayKey:hourIndex:)`, `combineShares(shares:)`, `sealTo(...)`,
  `openSealed(...)`, `encryptLocation(...)`, `proximityTokens(...) -> [Data]`, `proximityMatch(a:b:)`,
  `SafetyEngine(configToml:baselineBlob: Data?,nowMs:)`, `exportBaseline() -> Data`. `Base64.swift` provides
  `Data.b64`, `Data(b64:)`, `Data.zeroize()` and `bytes(_:_:) throws -> Data`.
- Labels are the Rust parameter names in camelCase. Note `openSealed(recipientX25519Secret:senderEd25519Public:`
  **`sealedBlob:`**`aad:)`, `sealTo(recipientX25519Public:senderEd25519Secret:plaintext:aad:)`,
  `splitDayKey(dayKey:k:n:)` (`UInt8`, `UInt8`), `encryptLocation(hourKey:userId:epochId:seq:loc:)`,
  `decryptLocation(hourKey:userId:epochId:seq:blob:)`, `fingerprint(userId:x25519Public:ed25519Public:) -> String`.
- Fallible functions `throws`. The error enums use **capitalised** cases: `CryptoError.Failed(msg:)`,
  `EngineError.Config(msg:)`, `EngineError.Baseline(msg:)` (both are `Swift.Error` + `LocalizedError`).
  `splitDayKey`, `combineShares`, `sealTo`, `openSealed`, `encryptLocation`, `decryptLocation` and the
  `SafetyEngine` initialiser throw; everything else (including all `SafetyEngine` methods) does not.
- Integer widths: `UInt64` for `tMs` / `nowMs` / `seq` / `deadlineMs` / `durationMs` / `keyTimesMs`;
  `UInt8` for `hourLocal`, `batteryPct`, `riskBand`, `Share.index`, `k`, `n`; `UInt32` for `hourIndex`,
  `baselineSeconds`, `backspaces`, `locationIntervalChanged(seconds:)`.
- `SafetyEngineProtocol` (no method throws; only the initialiser does): `pushMotion(samples:)`, `pushContext(ctx:)`,
  `pushAudio(s:)`, `pushTyping(s:nowMs:) -> TypingVerdict`, `pushAction(a:nowMs:)`, `setNightMode(active:nowMs:)`,
  `setLearning(enabled:)`, `tick(nowMs:) -> [EngineEvent]`, `snapshot() -> Snapshot`, `exportBaseline() -> Data`,
  `metrics() -> LiveMetrics`, `incidentLog() -> [IncidentRecord]` (newest last; entries expire after 8 h).
- Enum cases are lowerCamel: `Activity.{unknown,stationary,walking,running,vehicle}`,
  `Placement.{unknown,pocket,hand,bag}`, `HmmState.{normal,impaired,incident,unresponsive}`,
  `EscalationLevel.{idle,check,headsUp,unlocked,snatch,resolved}`,
  `IncidentKind.{gaitDrift,impact,grab,stillness,separated,typingOff}`,
  `UserAction.{dismissOk,dismissWrongPhrase,needHelp,manualSos,biometricDismiss,friendMarkedSafe,checkTimeout,phoneUnlocked}`,
  `EngineEvent.{checkRequested(phrase:deadlineMs:), headsUp(summary:), unlockLocation(summary:),
  snatchDetected(summary:), resolved, riskBandChanged(band: UInt8), batteryDying, locationIntervalChanged(seconds: UInt32),
  samplingRateChanged(hz: UInt32, gyro: Bool), signalIncident(record: IncidentRecord), callOptionAvailable(summary:)}`
  (11 cases; `SensingCoordinator.handle` switches over them without a `default`, so a regenerated binding that adds
  a case fails to compile on purpose). All enums are `Equatable`/`Hashable`.
- Records are structs with labelled memberwise inits in Rust field order: `MotionSample(tMs:ax:ay:az:gx:gy:gz:rx:ry:rz:)`,
  `Context(tMs:awayFromHome:separated:hourLocal:screenOn:activity:batteryPct:speedMps:lastTouchMs:distanceHomeM:samplingFull:)`,
  `AudioScores(tMs:scream:shout:glass:)`, `TypingSample(phrase:typed:keyTimesMs:backspaces:durationMs:)`,
  `Location(lat: Double, lng: Double, accuracyM: Float, tMs:)`, `Share(index:data:)`,
  `MetricBand(name:value:mean:sd:sdDistance:inBand:)`,
  `LiveMetrics(tMs:placement:samplingFull:activity:bands:pNormal:pImpaired:pIncident:pUnresponsive:baselineTrusted:baselineWalkDays:evidence:)`,
  `IncidentRecord(id: UInt32, tMs:kind:summary:sdDistance:placement:rawJson:pNormal:pImpaired:pIncident:pUnresponsive:sequenceId: UInt32, watched:)`;
  `Snapshot` has `pDanger, hmmState, escalation, riskBand: UInt8, evidence, baselineSeconds: UInt32, placement, nightMode`.
- Every Rust `f32` is Swift `Float` (`pDanger`, `zScore`, all `p*`, `MetricBand` numbers, `sdDistance`,
  `baselineWalkDays`, `speedMps`, `distanceHomeM`, `accuracyM`). Before a value enters a JS dictionary the
  coordinator widens it with `num(_:)` (`Float` → `Double`, non-finite → 0, since `JSONSerialization` rejects NaN);
  `UInt8`/`UInt32` counters become `Int`; `UInt64` timestamps are passed through (they fit JS numbers).
- The uniffi contract-version / API-checksum check (`uniffiEnsureSafetyFfiInitialized`) runs inside every
  generated call; nothing hand-written needs to invoke it.

## Module registration (app agent: `expo-module.config.json`)

```json
{ "platforms": ["ios", "android"],
  "ios": { "modules": ["SafetyNativeModule"], "appDelegateSubscribers": ["SafetyNativeAppDelegate"] } }
```
The subscriber boots `SensingCoordinator` on every launch, including background relaunches by CoreLocation
where JS never starts.

## Info.plist / capabilities (set via the Expo config plugin)

- `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSLocationWhenInUseUsageDescription`
- `NSMotionUsageDescription`, `NSMicrophoneUsageDescription`
- `NSFaceIDUsageDescription` (cancel SOS)
- `UIBackgroundModes`: `location`, `audio` (and `processing` if `BGProcessingTask` baselines are added).
  `allowsBackgroundLocationUpdates = true` crashes without the `location` mode.
- Push: `aps-environment` entitlement; notifications use `.timeSensitive`, so add the
  **Time Sensitive Notifications** capability. No critical-alert entitlement is assumed.
- Bundle resources (`ios/Resources/`): `yamnet.tflite` (+ optional `yamnet_class_map.csv`; defaults are
  Screaming=11, Shout/Bellow/Yell=6/7/9, Glass/Shatter=435/437), optional `alarm.caf` (a generated siren is
  used otherwise).

Notifications: `AlertManager` installs itself as `UNUserNotificationCenter.delegate`. Do **not** also let
`expo-notifications` own the delegate, or the CHECKIN actions never reach native.

## Widget extension (one-time Xcode step)

Expo cannot create extension targets. In Xcode: File ▸ New ▸ Target ▸ **Widget Extension** ("SafeWidget",
no configuration intent). Add `ios/Widget/SosWidget.swift` and `ios/AppIntents.swift` to that target and set
`SAFE_WIDGET_EXTENSION` in its *Active Compilation Conditions*. In the extension the intent opens the app
(`openAppWhenRun = true`), where the same intent runs against the coordinator. Action Button / Siri / Shortcuts
need no extension: `TriggerSosIntent` is discovered from the app binary. If Shortcuts does not list the
intent (App Intents inside static libraries need Xcode 15.3+), move `AppIntents.swift` into the app target.

## Behaviour notes

- **Night mode:** `auto` = away from any saved home ∧ inside the evening window (default 20:00–06:00).
  `paused_tonight` reverts to `auto` at the next window end. With no home places saved, `auto` never
  activates (there is no "away" to detect).
- **Session:** continuous location (100 m, no auto-pause) keeps the process alive; motion batches of
  ~1 s go to `pushMotion`; the 1 s tick pushes `Context`, calls `tick`, dispatches events, and writes the
  engine blob (`baseline.bin`: baselines + incident log) every 5 min and again at session stop.
- **Sampling modes (CONTRACTS §6):** `MotionSampler` starts in **LOW** — raw accelerometer at ~10 Hz
  (`accelerometerUpdateInterval = 0.1`), gravity from a first-order low-pass (τ ≈ 1 s), user acceleration =
  raw − gravity, `rx..rz = 0`, 10-sample batches. `EngineEvent.samplingRateChanged(hz:gyro:)` switches to
  **FULL** when `gyro` or `hz ≥ 25` — `CMDeviceMotion` at 50 Hz (fused gravity / user acceleration) plus
  `rotationRate` as `rx..rz` (rad/s, device frame), 50-sample batches — and back to LOW otherwise. Baseline
  walks force FULL for their duration. `Context.samplingFull` reports what is actually being delivered (a
  gyro-less device stays LOW). Low-rate sampling runs **whenever an engine exists**, not only in night
  sessions, with a 5 s idle tick so the engine keeps receiving `Context` (and can ask for FULL / learn from
  daytime walks). Caveat: without the continuous-location session iOS suspends the process a few seconds after
  it leaves the foreground, so idle sampling only covers foreground use plus the background grace period, and
  resumes when the app comes back; nothing is lost at night because the session's location updates keep the
  process alive. The pedometer / activity manager are only started idle once Motion & Fitness is granted
  (starting them is what triggers the permission prompt).
- **Context (v1.1 fields):** `lastTouchMs` from `TouchTracker`; `distanceHomeM` = metres from the latest
  location (continuous updates, else the manager's cached fix) to the centre of the nearest saved home,
  `-1` with no homes or no fix; `samplingFull` = `MotionSampler.isFull`.
- **Touch tracking (`TouchTracker`):** a transparent `UIGestureRecognizer` (`cancelsTouchesInView = false`,
  recognises simultaneously, fails on `touchesBegan`) is attached to every window of every connected scene
  (RN root, modals, alerts), re-checked on `didBecomeActive` and `UIWindow.didBecomeKey/Visible`.
  `protectedDataDidBecomeAvailable` (device unlocked while we are alive) and `didBecomeActive` also count as a
  touch and, coalesced to once per 2 s, call `pushAction(.phoneUnlocked)` so a grab clears inside its 2-minute
  window. `SafetyNativeTypingView` records a touch per key. **Limits:** the system keyboard, notification
  banners, Control Centre, the lock screen and other apps are outside our windows, so touches there are
  invisible — only the unlock notifications see "the owner is using the phone"; `lastTouchMs` is in-memory
  (0 after a relaunch until the first touch / unlock); while suspended nothing is recorded. No `sendEvent`
  swizzle is used (RN owns `UIWindow`), which is why keyboard touches are reported from the typing view.
- **Dashboard (CONTRACTS §6):** `getDashboard()` → `{ metrics: LiveMetrics, incidents: IncidentRecord[] }`
  straight from `engine.metrics()` / `engine.incidentLog()`; `setDashboardStreaming(true)` runs a 1 s timer on
  the coordinator queue emitting `dashboard` with the same payload (idempotent; `false` or module teardown
  stops it). Field names are the Rust names in camelCase; enums are lowercase snake strings (`kind`:
  `gait_drift | impact | grab | stillness | separated | typing_off`; `placement`, `activity` likewise);
  non-finite floats are sent as 0. With no engine yet, `metrics` is a neutral record (`pNormal = 1`,
  empty `bands`) and `incidents` is `[]`.
- **v1.1 events:** `signalIncident` (the `IncidentRecord` dict; deduped by `id` through a 64-entry native ring
  buffer; also boosts the audio classifier for 2 min in session), `callOption` (`{ summary }`; additionally
  inserts `incident_events.kind='call_option'` on the open incident and calls `functions/v1/push` with
  `kind: 'call_option'`). `samplingRateChanged` never reaches JS; it reconfigures `MotionSampler`. A grab's
  immediate `headsUp` goes through the normal `heads_up` path (row + push, **no** key release); keys are released
  only by the `unlockLocation` that follows unless the owner unlocked.
- **Incidents:** first friend-visible level (`heads_up` / `unlocked` / `snatch` / `sos`) inserts the
  `incidents` row; later levels PATCH it; each step adds an `incident_events` row and calls
  `functions/v1/push`. `UnlockLocation` and `SnatchDetected` also seal the current + next `K_h` to each
  member into `released_keys`.
- **Escrow conventions** follow CONTRACTS §5 exactly (shared with Android; friends on either platform
  decrypt each other's data): `hour_index` = floor(unixSeconds / 3600) (UTC-absolute) for `derive_hour_key`,
  `location_blobs.hour_index` and `released_keys.hour_index` (friends read it back from the row); `seq` =
  upload wall-clock ms. AADs: `key_shares` `"share|{epochId}|{recipientUserId}"`, `released_keys`
  `"hour|{epochId}|{hourIndex}"`, `unlock_approvals` `"approval|{subjectUserId}|{epochId}"` with plaintext
  `[index as u8] ++ share`. Group proximity key = `SHA-256("safe/proximity|{groupId}|{YYYY-MM-DD UTC}")`.
  Shamir: n = active members excluding self, k = clamp(max(2, threshold_k), 2, n), n < 2 → no shares.
  `approveUnlock` returns the sealed share; JS inserts the `unlock_approvals` row.

## Known day-1 spike: mic restart in background

iOS will generally not let an app *start* `AVAudioEngine` input while backgrounded (`AVAudioSession`
activation fails or the tap gets no buffers). Mitigation implemented: the engine is started when the night
session begins and kept running; the classifier only runs on duty windows (5 s of every 30 s, continuous for
2 min after any motion signal / risk-band change). If the session starts in the background and the mic
cannot start, `AlertManager.postMicNudge()` posts a one-tap "Enable sound detection" notification; tapping it
foregrounds the app and `retryAudio()` starts the engine. Confirm on hardware (M0) whether background start
ever succeeds; if it does, the duty cycle can stop the engine between windows to save battery.

## Contract deviations (flagged)

Escrow AADs, `hour_index`, the group proximity key and the Shamir parameters are no longer deviations: they
match CONTRACTS §5 (see "Behaviour notes").

1. **Typing practice** uses `pushTyping` while escalation is Idle (no dedicated FFI entry point).
2. **Pedometer** has no engine input; steps only back-fill `Context.activity = walking` when
   `CMMotionActivityManager` reports unknown.
3. **Notification permission** is reported from a cached value refreshed asynchronously (API is async).
4. `approveUnlock` does not insert the `unlock_approvals` row (JS does); `decryptLocations` needs
   `openReleasedKey` or `recoverFromShares` first (keys are cached in memory only).
5. **Touch coverage** (§6 "root view touch listener"): only touches inside the app's own windows are seen; the
   system keyboard is covered via `SafetyNativeTypingView`, not generically. Lock-screen unlock is inferred from
   `protectedDataDidBecomeAvailable` / `didBecomeActive`, which fire only while the process is alive.
6. `callOptionAvailable` with no open incident (should not happen: it follows an unlock) only emits the JS
   event; no row or push is written.
7. `signalIncident` posts no local notification; the dashboard is opt-in and the engine keeps the log.
