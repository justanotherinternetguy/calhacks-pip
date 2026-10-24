# Plan: Friend-group night-out safety app (iOS + Android, production v1)

## Context
Every existing safety app needs the person in danger to act (press a button, set a timer, share a location). This app runs passively, notices when a user can't ask for help (bad gait drift, hard fall then no movement, commotion, phone snatched), gives them a chance to say "I'm fine", and then alerts their trusted friends. Location stays end-to-end encrypted until the danger estimate is high, and no single party (one friend, or the company) can unlock it. Friends decide what to do; the app never calls police itself.

`/home/thinkies/Git/safe` is empty, so this is a greenfield build. Decisions made: **Expo (React Native) UI + Swift/Kotlin native sensing + shared Rust core**, **Supabase backend**, **production v1 scope**, **mic duty-cycled only during night mode**.

---

## 1. Architecture

```
┌──────────────── Phone (iOS / Android) ────────────────┐
│ Expo app (TS, expo-router)  ← UI only, may be asleep  │
│   └─ Expo modules facade (events + commands)          │
│ Native sensing service (Swift / Kotlin)  ← always up  │
│   motion 50Hz · pedometer · activity · location ·     │
│   audio classifier · screen/unlock events · battery   │
│        │ windows of samples                           │
│ Rust safety-core (uniffi)                             │
│   features → baselines → incidents → escalation       │
│   crypto: epoch keys, Shamir, AEAD, HPKE, proximity   │
└───────────────┬───────────────────────────────────────┘
                │ only ciphertext, tokens, coarse status
┌───────────────▼──────────── Supabase ─────────────────┐
│ Postgres + RLS · Auth · Realtime · Edge Functions     │
│ push fan-out (APNs direct + FCM v1) · heartbeat       │
│ watchdog (pg_cron) · proximity matcher · purge job    │
└───────────────────────────────────────────────────────┘
```

Key rule: **all detection logic lives in native + Rust**, never in JS. The JS runtime can be suspended in the background; the native service and Rust core keep running.

### Repo layout (pnpm workspace + Cargo workspace)
```
safe/
  apps/mobile/                    Expo app (dev build, New Architecture)
    app/                          screens (expo-router)
    modules/safety-native/        Expo module: ios/*.swift, android/*.kt
    modules/safety-native/rust/   generated uniffi Swift/Kotlin bindings + prebuilt libs
  core/
    crates/safety-core/           signal, baseline, incident rules, log, escalation, typing
    crates/safety-ffi/            uniffi interface (.udl or proc-macro)
    crates/sim/                   CLI: replay recorded traces through the full pipeline
    config/model-v1.toml          incident rules + thresholds (signed, versioned)
  supabase/
    migrations/  functions/{push,watchdog,proximity,purge,unlock}/  tests/ (pgTAP)
  tools/collect/                  data-collection build flavor + labeling export
  e2e/                            Maestro flows
```
Build: `cargo-ndk` (Android .so for arm64/x86_64) and `cargo` + `xcframework` (iOS arm64 + sim) via a `core/build-mobile.sh`; Expo config plugin copies artifacts and sets entitlements/manifest. EAS Build for CI binaries.

---

## 2. Layer 1: Background sensing (native)

### Night mode: always on, nothing to set up each night
- User saves home/dorm places once during onboarding. **Stored only on the device.**
- **Night mode starts automatically** when the user is away from home *and* inside their evening window (default 8pm–6am, adjusted as the app learns their habits). It ends when they get home or the window ends.
- **iOS:** home geofence exit (`CLCircularRegion`) plus significant-location-change monitoring wake the app, even after it was killed. It then starts continuous location (`allowsBackgroundLocationUpdates`, `pausesLocationUpdatesAutomatically = false`, ~100 m accuracy), which keeps the process alive so `CMMotionManager` can keep sampling at 50 Hz.
- **Android:** a persistent foreground service (`foregroundServiceType="location|microphone"`) is started while the app is visible and stays up all the time. During the day it does minimal work; in night mode it runs everything. Geofence and Activity Recognition transitions switch modes. After a reboot it restarts without mic access (an Android rule) and posts a "tap to re-arm" notification.
- Both platforms send a **heartbeat** every 2 min in night mode: status level and battery. No location.

### Signals (all computed on the device)
| Signal | Implementation |
|---|---|
| Gait drift | Device motion (user accel + gravity). Rust projects acceleration onto the gravity axis (vertical) and the horizontal plane, so phone orientation doesn't matter. It band-passes 0.5–3 Hz, detects steps by peaks, and computes cadence, step-time CV, stride regularity (autocorrelation), harmonic ratio, and side-to-side sway RMS. Each value is z-scored against the user's own baseline for the detected **placement** (pocket / hand / bag, inferred from orientation and proximity). |
| Impact / fall | Free-fall phase (<0.5 g) → peak magnitude >3 g → orientation change → low motion. Separate "phone dropped alone" pattern: long free fall, lands flat, no body motion before or after. A drop resolves itself once the phone is picked up. |
| Stillness | Activity = stationary, no steps, motion variance below threshold, and no screen-on/unlock events. Duration is tracked. |
| Agitation / struggle | High-energy acceleration with no periodic gait. Weighted low, because dancing looks similar. |
| Commotion audio | YAMNet (LiteRT) on both platforms, so the outputs match. Classes: scream, shout/yell, glass shatter. Scored as a **jump above the rolling venue background**, not as raw loudness. Audio is analyzed in memory only and never stored or uploaded. |
| Phone snatch | Sudden jerk/rotation while in hand (screen on) → running cadence or GPS speed >3 m/s → separated from group. Separate fast detector (see §4). |
| Away from home / time | On-device geofence + clock. |
| Separated | Private proximity tokens (§5). The server only learns together or separated. |
| Typing on check-in | Native input view records per-key timestamps: inter-key median and CV, backspace rate, edit distance to the phrase, completion time. |

### Mic: listening windows only (v2)
- The mic is off by default. The engine opens a **listening window** (night mode) after a fall, a phone drop, a grab, a missed check-in or unsteady gait, and closes it 10 min after the last such incident cleared. Inside a window `AudioRecord` captures continuously; ~1 s frames become YAMNet labels (scream, shout, snoring) plus a sound level (dB SPL). Only labels reach the engine.
- Scream/shout counts only within 2 min of a fall or grab and not in a loud venue (median level ≥ 80 dB); snoring counts only while down after a fall with a missed check-in. Vomiting and distress words were considered and left out: YAMNet has no vomiting class, and on-device speech recognition is not reliable from a background service.
- Either way, the mic is a **booster signal**. The model must work without it.

### Personal baselines
- With consent, the app learns opportunistically on normal days: when activity = walking (Android Activity Recognition; iOS during active sessions and `BGProcessingTask` windows), it collects 30 s gait windows. Typing baselines come from practice check-ins during onboarding and occasional optional prompts.
- Statistics are robust (median/MAD, EWMA), kept per placement, and stored encrypted on the device (iOS file protection `CompleteUntilFirstUserAuthentication`, Keychain `AfterFirstUnlockThisDeviceOnly`; Android Keystore-wrapped key) so they can be read while the phone is locked.
- Cold start: use population priors until about 2 h of walking has been collected, with a higher alert bar meanwhile.

---

## 3. Reasoning: rule-based incidents (Rust `engine` + `log`)
v1 used a 4-state HMM producing `P(danger)`; v2 replaced it with explicit incidents, because a probability was hard to
explain to the subject or friends and hid *why* something escalated.
- Every signal opens and clears **incidents** (full list and rules: `docs/OVERVIEW.md` §1, `config/model-v1.toml`
  `[incidents]`). Each has a **tier**: context (logged only), watch (full sensing, counts toward a check-in), danger
  (asks on its own), and a **family** (fall, gait, phone, location, check-in, audio).
- **Check-in trigger:** a danger incident (down after fall, …), or watch incidents from two independent families at once
  (e.g. unsteady gait while separated; a fall then screaming). One family never asks alone.
- **Recovery is explicit:** steps after a fall log "fall, recovered" and clear it; in-band walking clears unsteady gait;
  rejoining the group clears separated. This resolves story B with no alarm.
- Episodes: a check-in / grab / SOS links the last hour of incidents into one sequence for the friends' summary,
  e.g. "Unsteady walking, then a hard fall, then down for 2 min".
- Parameters live in `config/model-v1.toml`, signed by the server and updatable without an app release.

---

## 4. Layer 2: Escalation and alarm (Rust `escalation/` + native notifications)
A state machine with hysteresis, cooldowns, and per-step timers:

1. **Check:** the check-in trigger holds (§3). A high-priority notification says "You okay?". Opening it requires unlocking the phone, which blocks a thief. The user types a 3-word random phrase in the native input. They can also tap **"I need help"**, which counts as consent and skips straight to step 3.
2. **Soft heads-up:** no response within 2 min (logged as "check-in missed") while the trigger still holds, or typing far off baseline. Friends get "Sam might not be okay", **with no location**. If the evidence clears on its own, the episode resolves.
3. **Location unlock:** still no answer 4 min after the check and the trigger still holds. The phone releases the current epoch key to friends (§5) and keeps uploading encrypted live location.
4. **Friends act:** ring the phone loudly, call, tap "I'm going" (visible to the other friends), mark found/safe.
5. **Option to escalate:** a one-tap call to the group's configured campus safety number or 911, with a prefilled info card (name, last location, what was detected) to read out or text. **The app never calls on its own.**

- A good dismiss acknowledges every active incident: they stay logged (and keep full sensing on) but only a new incident can ask again.
- A wrong phrase leaves the check open for another try.

**Other paths into escalation:**
- **Snatch detector** → immediate "Sam's phone may have been snatched; Sam may be without a phone" alert. It includes the location *at the snatch moment*, plus a "don't chase" warning. Only the owner's biometric unlock can dismiss it.
- **Manual SOS** (counts as consent, skips the bar): in-app hold button, iOS App Intent (Action Button, lock-screen widget, Siri), Android Quick Settings tile and widget.
- **Phone dying or going offline** (handled by the server watchdog):
  - At 3% battery the phone uploads a final encrypted location and a "battery dying" flag.
  - If the heartbeat is missing for more than 10 min during night mode, friends get "Sam's phone went offline at 1:42am" with no location. They can then start the 2-of-n fallback unlock.

**Alarm delivery:**
- **iOS:** apply for the **Critical Alerts entitlement on day 1** (Apple approval takes time). The fallback is `timeSensitive` notifications. While night mode is active the app is already running with an audio session, so "ring" can also play directly.
- **Android:** a high-importance channel on the alarm audio stream, played from the foreground service. Full-screen intent only if Play approves it.
- Push goes **directly to APNs and FCM v1** from Edge Functions, not through Expo's push service, so critical-alert fields can be set.

---

## 5. Privacy: location escrow and proximity (Rust `crypto/`, `proximity/`)

### Keys
- Each device has an X25519 key (for HPKE) and an Ed25519 signing key, stored with Keychain/Keystore protection that still works while the phone is locked.
- Friends are added **in person by scanning a QR code** (user id + key fingerprint), so the server can't swap in its own keys. Safety-number re-verification is offered if a key changes.

### Rolling epoch keys
- Every day the phone generates a random root key `K_day`, and derives a key per hour: `K_h = HKDF(K_day, hour)`.
- `K_day` is split with **Shamir (k-of-n, GF(256))** among the group's n friends. Default `k = max(2, ⌈n/2⌉)`; with fewer than 2 friends, fallback unlock is disabled and the UI says so.
- Each share is signed, sealed to that friend's device key with HPKE, and uploaded. Friends' phones download and keep their share.
- Old keys and shares are **zeroized when the day ends**.
- When a member leaves or is removed, the key rotates immediately.

### Location upload
- In night mode the phone sends a location every 1–5 min, adapting to the risk level.
- Each update is encrypted with XChaCha20-Poly1305 under `K_h`. Authenticated data is `user|epoch|seq`.
- The server keeps only the **last 6 h** of these encrypted blobs (purge job).

### Normal unlock
- The subject's own phone seals `K_h` (current and next hour, not the whole day) to each friend and posts it to the `released_keys` table.

### Fallback unlock
Used when the subject's phone is offline.
1. A friend opens an `unlock_request`.
2. The server allows it **only if** the subject is in an offline or battery-dying incident.
3. Each approving friend's phone decrypts its share and re-seals it to the requester.
4. Once the requester has k shares, they rebuild `K_day` and decrypt the last known location.
5. **Every unlock is logged and shown to the subject and the whole group.** This discourages a few friends colluding to track someone.

### Together / separated
- Each phone computes `HMAC(group_epoch_key, geohash7(cell))` for its own cell and its 8 neighbors (~150 m), and uploads these tokens every 2 min.
- The `proximity` function compares tokens between group members who are in night mode and writes back only `together` or `separated`.
- The server never sees coordinates. Accepted risk: a friend colluding with the server could brute-force cells (documented in the threat model).
- BLE proximity is a v1.1 booster.

### Abuse resistance
- A k ≥ 2 floor for fallback unlock.
- Mutual consent to join a group.
- Leaving a group is instant and silent.
- The company never holds keys.

---

## 6. Backend (Supabase)
Tables (RLS on all, members-only reads):
- `profiles`, `devices` (push token, public keys, last_heartbeat, night_mode, battery)
- `groups` (threshold_k, campus_safety_number), `group_members` (invited/active)
- `epochs`, `key_shares` (sealed), `location_blobs` (ciphertext)
- `proximity_tokens`, `presence` (together/separated)
- `incidents` (level, coarse trigger summary, timestamps), `incident_events` (nudge, release, ring, en_route, called_911, resolved)
- `released_keys` (sealed), `unlock_requests` / `unlock_approvals` (sealed shares), `audit_log` (visible to the subject)

Edge Functions:
- `push`: fan-out to APNs and FCM
- `watchdog`: pg_cron every minute, catches missed heartbeats and dying batteries
- `proximity`: compares tokens between members
- `unlock`: checks that a fallback unlock is allowed
- `purge`: retention cleanup
- `config`: serves signed model parameters

Realtime: friends' incident screens subscribe to `incidents` / `incident_events` / `location_blobs` for live updates.
Auth: Supabase Auth with phone OTP + Apple/Google sign-in. One active device per user in v1.

## 7. App UI (Expo, TypeScript)
- **Onboarding:** step-by-step permissions with plain-language explanations (location Always, motion, mic, notifications; Android battery-optimization guidance; OEM tips from dontkillmyapp), home places, baseline walk + typing practice.
- **Friends & groups:** QR add, threshold setting, campus safety number.
- **Home:** night-mode status, together/separated, manual SOS.
- **Check-in screen:** native typing view.
- **Friend incident screen:** timeline, map (react-native-maps) after unlock, Ring/Call/I'm going/Found, escalate card.
- **Fallback unlock approval flow.**
- **History and audit log**, and settings: sensor toggles, evening window, pause for tonight.

---

## 8. Milestones
1. **M0 spikes (2 wk):**
   - 6 h locked-phone runs on both platforms to confirm 50 Hz motion keeps flowing.
   - iOS: can the mic restart in the background?
   - Battery cost (target <8% per night).
   - Rust ↔ uniffi ↔ Expo module build in EAS.
   - **File the Critical Alerts entitlement request.**
2. **M1 foundation:** monorepo, CI (cargo test, pgTAP, tsc, EAS), Supabase schema + RLS, auth, onboarding, QR friends, groups.
3. **M2 sensing:** native services, night-mode controller, feature extraction in Rust, baselines, debug trace recorder.
4. **M3 reasoning:** incident rules + escalation engine + check-in with typing. Runs fully on the device against replayed traces.
5. **M4 escrow:** epochs, Shamir, HPKE, location blobs, normal + fallback unlock, proximity tokens, push fan-out, watchdog.
6. **M5 friend response:** incident screens, ring/call/en-route/resolve, escalate card, audit log.
7. **M6 extra paths:** audio classifier, snatch detector, manual SOS (App Intents, widgets, QS tile).
8. **M7 data + tuning:** consented collection study covering normal walking, impairment goggles, padded falls, phone drops, dancing, sitting, transit. Tune thresholds in `sim` for a target false-alarm rate (e.g. ≤1 check per 5 nights, ≤1 false unlock per 500 nights).
9. **M8 hardening + launch:**
   - External crypto/security review, threat model doc.
   - Store compliance: Apple background-location justification; Play background-location declaration + video, foreground-service type declarations.
   - Privacy policy, "not an emergency service" terms, 18+ for v1.
   - Accessibility.
   - TestFlight / Play closed beta.

## 9. Verification
- **Rust (`cargo test`):**
  - Golden story tests: A (stumble → impact → still) must escalate; B (still → acceleration → stumble) must not.
  - Recovery tests, and context only moving transitions.
  - Shamir property tests: any k shares rebuild the key, k−1 shares don't.
  - AEAD/HPKE test vectors, zeroization checks.
  - Proximity token match/mismatch.
  - Typing feature tests.
- **Simulator:** `cargo run -p sim -- replay traces/*.parquet` reports false-alarm rate per night-hour and detection delay per scenario. Runs as a CI regression gate.
- **Backend:**
  - `supabase test db` (pgTAP): RLS. A non-member can't read blobs, the server role never sees plaintext, and fallback unlock is refused without an incident.
  - `deno test` for Edge Functions.
- **E2E (Maestro):**
  - A debug-only "inject trace" mode feeds recorded sensor data into the native pipeline on simulators and emulators.
  - Flows: check-in dismiss, heads-up, unlock with the map visible on a friend device, snatch, manual SOS.
- **Field tests:**
  - A 4-phone group night (staged) on both platforms.
  - Kill the subject's phone mid-session, then confirm the offline alert and a 2-of-4 fallback unlock.
  - Padded fall and drop tests.
  - 6 h battery and sample-continuity logs.
  - Mixed iOS/Android groups.
