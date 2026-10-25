# Store compliance checklist

Hackathon scope: this list includes items marked **out of scope** so nobody forgets them. We are not
working on them now. Apple entitlement requests (Critical Alerts, etc.) are deliberately out of scope.

## Google Play

- [ ] **Background location declaration** in Play Console (Policy → App content → Location
      permissions). Core feature: encrypted location escrow for friend-group safety. The app uses
      location in the background only while night mode is active.
- [ ] **Demo video** (≤ 30 s) that shows: onboarding prominent disclosure → "Allow all the time" prompt
      → night mode active → friend receives alert → map. Record it from the `docs/DEMO.md` web-mock flow.
- [ ] **Prominent disclosure** screen before the runtime prompt (why, what, when), per policy.
- [ ] `AndroidManifest.xml`: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`,
      `FOREGROUND_SERVICE_MICROPHONE`, `ACCESS_BACKGROUND_LOCATION`, `ACTIVITY_RECOGNITION`,
      `RECORD_AUDIO`, `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT` (request approval, with a
      high-importance notification as the fallback), `RECEIVE_BOOT_COMPLETED`.
- [ ] Declare the service with `android:foregroundServiceType="location|microphone"`. In Play Console, add
      **foreground service type declarations** for `location` and `microphone` with the use-case
      text and video link.
- [ ] Mic after reboot: Android does not allow a `microphone` FGS to start from boot. The app posts a
      "tap to re-arm" notification instead (already in design).
- [ ] Data safety form: location (collected, encrypted, not shared with third parties), device IDs,
      audio **not** collected (class scores only, on device).
- [ ] Target API 35+. `SCHEDULE_EXACT_ALARM` is not necessary (the app uses FGS timers).
- [ ] Battery: avoid a flag for "excessive background battery". Cite the <8%/night target.

## Apple App Store

- [ ] `Info.plist` strings: `NSLocationAlwaysAndWhenInUseUsageDescription`,
      `NSLocationWhenInUseUsageDescription`, `NSMotionUsageDescription`,
      `NSMicrophoneUsageDescription`, `NSFaceIDUsageDescription`.
- [ ] `UIBackgroundModes`: `location`, `audio`, `processing`.
- [ ] **Background location justification** in App Review notes: continuous location in night mode
      keeps the process alive for 50 Hz motion sampling. It also uploads *encrypted* fixes that the
      developer cannot read. Show the "Always" prompt only after a plain-language screen.
- [ ] Privacy nutrition label: Location (linked to user, app functionality), Identifiers. Audio not
      collected.
- [ ] App Privacy → data encrypted in transit and end-to-end. State that the developer cannot
      decrypt location.
- [ ] Age rating 17+ / "18+" gate in onboarding (per terms).
- [ ] Guideline 5.1.1: the user must be able to continue to use the app without location/mic
      permissions (reduced functionality mode).
- [ ] **Out of scope (hackathon):** Critical Alerts entitlement request
      (`com.apple.developer.usernotifications.critical-alerts`), `BGProcessingTask` identifiers,
      App Intents / widgets review, Siri entitlements. Fallback in demo: `timeSensitive` notifications.

## Both

- [ ] Privacy policy URL (publish `docs/PRIVACY.md`).
- [ ] "Not an emergency service" disclaimer in store listing, onboarding, and incident screens.
- [ ] Account deletion in-app (both stores require it).
- [ ] Accessibility pass on check-in screen (large text, VoiceOver/TalkBack labels, haptics).
