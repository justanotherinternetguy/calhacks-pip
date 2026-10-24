# Store compliance checklist

Hackathon scope: items marked **out of scope** are listed so nobody forgets them, but are not being
pursued now. Apple entitlement requests (Critical Alerts, etc.) are deliberately out of scope.

## Google Play

- [ ] **Background location declaration** in Play Console (Policy → App content → Location
      permissions). Core feature: encrypted location escrow for friend-group safety; location is used
      in the background only while night mode is active.
- [ ] **Demo video** (≤ 30 s) showing: onboarding prominent disclosure → "Allow all the time" prompt
      → night mode active → friend receives alert → map. Record from `docs/DEMO.md` web-mock flow.
- [ ] **Prominent disclosure** screen before the runtime prompt (why, what, when), per policy.
- [ ] `AndroidManifest.xml`: `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`,
      `FOREGROUND_SERVICE_MICROPHONE`, `ACCESS_BACKGROUND_LOCATION`, `ACTIVITY_RECOGNITION`,
      `RECORD_AUDIO`, `POST_NOTIFICATIONS`, `USE_FULL_SCREEN_INTENT` (request approval; fallback is
      high-importance notification), `RECEIVE_BOOT_COMPLETED`.
- [ ] Service declared with `android:foregroundServiceType="location|microphone"`; Play Console
      **foreground service type declarations** for `location` and `microphone` with the use-case
      text and video link.
- [ ] Mic after reboot: Android forbids starting a `microphone` FGS from boot; app posts a
      "tap to re-arm" notification instead (already in design).
- [ ] Data safety form: location (collected, encrypted, not shared with third parties), device IDs,
      audio **not** collected (class scores only, on device).
- [ ] Target API 35+; `SCHEDULE_EXACT_ALARM` not needed (uses FGS timers).
- [ ] Battery: avoid being flagged as "excessive background battery"; cite <8%/night target.

## Apple App Store

- [ ] `Info.plist` strings: `NSLocationAlwaysAndWhenInUseUsageDescription`,
      `NSLocationWhenInUseUsageDescription`, `NSMotionUsageDescription`,
      `NSMicrophoneUsageDescription`, `NSFaceIDUsageDescription`.
- [ ] `UIBackgroundModes`: `location`, `audio`, `processing`.
- [ ] **Background location justification** in App Review notes: continuous location in night mode
      keeps the process alive for 50 Hz motion sampling and uploads *encrypted* fixes that the
      developer cannot read; show the "Always" prompt only after a plain-language screen.
- [ ] Privacy nutrition label: Location (linked to user, app functionality), Identifiers; audio not
      collected.
- [ ] App Privacy → data encrypted in transit and end-to-end; state that the developer cannot
      decrypt location.
- [ ] Age rating 17+ / "18+" gate in onboarding (per terms).
- [ ] Guideline 5.1.1: location/mic permissions must be optional to continue using the app (reduced
      functionality mode).
- [ ] **Out of scope (hackathon):** Critical Alerts entitlement request
      (`com.apple.developer.usernotifications.critical-alerts`), `BGProcessingTask` identifiers,
      App Intents / widgets review, Siri entitlements. Fallback in demo: `timeSensitive` notifications.

## Both

- [ ] Privacy policy URL (publish `docs/PRIVACY.md`).
- [ ] "Not an emergency service" disclaimer in store listing, onboarding, and incident screens.
- [ ] Account deletion in-app (required by both stores).
- [ ] Accessibility pass on check-in screen (large text, VoiceOver/TalkBack labels, haptics).
