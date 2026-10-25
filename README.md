# pip: passive night-out safety

**pip** is a safety app for a night out. It runs passively and notices when a person *cannot* ask
for help: gait that drifts badly, a hard fall with no movement after it, commotion, or a snatched
phone. It asks *the person* first ("You okay? type the 3 words"). Only after that does it tell their
friends.

Location stays end-to-end encrypted until a check-in goes unanswered. No single party can unlock it,
not one friend and not the company. Friends decide what to do. **The app never calls the police
itself.** Detection runs in Rust on the device. The server only sees ciphertext, proximity tokens,
and coarse status.

> **Not an emergency service.** Detection is heuristic and alerts can fail or be false. If you
> are in danger, call your local emergency number. 18+ only. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Architecture

```
┌──────────────── Phone (Android) ──────────────────────┐
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

Pipeline: the input is 50 Hz motion, context, and audio labels (audio in listening windows only).
The core turns this input into gait, impact, grab, and stillness signals. It compares each signal
with the user's own baseline for each phone placement. Rules then raise incidents: possible fall,
down after fall, unsteady gait, stumbles, separated, stopped on the way home, phone left behind,
scream, and others. Each incident has a tier and a clearing rule. The incidents feed the escalation
state machine (Check → Heads-up → Unlock). It escalates when a danger incident is active, or when
two independent kinds of evidence coincide. There is no probability model.

Escrow: the phone splits a daily key `K_day` k-of-n (Shamir) among friends. The hourly key is
`K_h = HKDF(K_day, hour)`. The phone encrypts locations with XChaCha20-Poly1305 under `K_h`. It
seals each share with HPKE and signs it with Ed25519. [docs/CONTRACTS.md](docs/CONTRACTS.md) fixes
the interfaces. [PLAN.md](PLAN.md) has the full design.

## Repo layout

```
safe/
  apps/mobile/                     Expo app (expo-router, TS) — UI only
    modules/safety-native/         Expo module: android/**/*.kt, src/ TS facade (iOS removed)
  core/                            Cargo workspace
    crates/safety-core/            signal, baseline, incident rules, log, escalation, typing (pure Rust, no I/O)
    crates/safety-crypto/          identity, Shamir GF(256), HPKE seal/open, location AEAD, proximity
    crates/safety-ffi/             uniffi proc-macro surface (`SafetyEngine` + crypto fns)
    crates/sim/                    `sim batch core/traces` replays traces through the pipeline (CI gate)
    config/model-v1.toml           incident rules + thresholds (signed, served by `config` function)
    traces/<scenario>/*.json       recorded traces for sim + e2e inject
    build-mobile.sh                cargo-ndk / xcframework + uniffi bindings → module dirs
  supabase/                        migrations (RLS), functions/{push,watchdog,proximity,unlock,purge,config}, pgTAP tests
  tools/collect/                   export + label CLIs for the consented collection study
  e2e/                             Maestro flows (inject-trace deep link)
  docs/                            CONTRACTS, THREAT_MODEL, PRIVACY, STORE_COMPLIANCE, DEMO
  .github/workflows/               ci.yml (rust, sim-gate, functions, mobile, android-bindings), eas.yml
```

## Quickstart

Prerequisites: Rust 1.99 (rustup), pnpm 12, Node 26, Deno 2, and the Supabase CLI. Optional: the
Android SDK and NDK r27 (`cargo install cargo-ndk`).

```bash
pnpm install
cargo test --manifest-path core/Cargo.toml                    # Rust: golden stories, Shamir, AEAD/HPKE, proximity
(cd supabase && deno test --allow-all functions)              # edge functions
pnpm --filter mobile typecheck                                # app
cargo run --manifest-path core/Cargo.toml -p sim -- batch core/traces   # regression gate (false alarms / detection delay)
core/build-mobile.sh                                          # android .so + kotlin bindings
pnpm --filter mobile android                                  # debug dev-build with inject-trace enabled
```

To run the backend locally: `cd supabase && supabase start && supabase db reset && supabase functions serve`.
Then copy the URL and the anon key into `apps/mobile/.env`.

## Demo for judges

Full script: [docs/DEMO.md](docs/DEMO.md). Short version, with one phone or emulator and a web mock
friend:

1. Run `pnpm --filter mobile web`. Open it with `?mock=friend&subject=<user-id>` to get the friend screen.
2. On the device or emulator, run `adb shell am start -a android.intent.action.VIEW -d 'safe://debug/inject?trace=checkin-dismiss'`
   (iOS: `xcrun simctl openurl booted 'safe://debug/inject?trace=checkin-dismiss'`). Type the
   3 words. The app dismisses the check-in, and the friend sees nothing.
3. Inject `heads-up` and ignore the check-in. The friend gets "might not be okay" **without location**.
   2 min later, if the user is still down, the friend's map appears. Show `location_blobs.ciphertext` in Studio.
4. Inject `snatch`. An immediate "don't chase" alert appears with the snatch-moment pin. Only
   biometrics can dismiss it.
5. Hold the SOS button to start `manual-sos`. To run the flows headless: `maestro test e2e/`.

`core/traces/`, `e2e/`, and the app's bundled debug traces use the same trace names
(`checkin-dismiss`, `heads-up`, `unlock-map`, `snatch`, `manual-sos`).

## Privacy in one paragraph

Home places, baselines, and keys never leave the phone. The microphone only listens after a fall,
drop, grab, missed check-in, or unsteady walking. The phone classifies the audio in memory into
scream, shout, or snoring labels, then discards it. Location uploads are ciphertext under an hourly
key. The server keeps 6 h of them and cannot decrypt them.

Friends learn only together/separated (HMAC geohash tokens) and a coarse status (night mode,
battery, escalation level). They learn more only when the user misses a check-in, the user taps
"I need help"/SOS, or the phone goes offline and ≥ 2 friends approve a fallback unlock. The app
logs every unlock and shows it to the subject and the whole group. Accepted risks and the adversary
table: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Status (PLAN §8 milestones)

| Milestone | Status | Notes |
|---|---|---|
| M0 spikes (locked-phone 50 Hz, iOS bg mic, battery, EAS build, Critical Alerts) | todo | hardware spikes need real phones. Apple entitlement deliberately out of hackathon scope |
| M1 foundation (monorepo, CI, schema + RLS, auth, onboarding, QR friends, groups) | done (unverified on device) | workspaces, CI, contracts, 4 migrations (pgTAP 25/25 on Postgres 17), OTP/OAuth sign-in, onboarding, QR add, groups screens. Typecheck passes |
| M2 sensing (native services, night-mode controller, Rust features, baselines, trace recorder) | code complete, uncompiled natively | Swift + Kotlin services written against generated uniffi bindings (no Xcode/SDK here). `safety-core` signal/baseline tested |
| M3 reasoning (incident rules, escalation, typing check-in, replayed traces) | done | v2 engine: rule-based incidents with tiers (HMM / P(danger) removed), live signal bands, gyro, grab + stumble detectors, listening windows. 59 core tests, `sim batch` 6/6 (fall trace: check at 3:15, unlock at 7:15, story B quiet) |
| M4 escrow (epochs, Shamir, HPKE, blobs, normal + fallback unlock, proximity, push, watchdog) | done (push unverified live) | `safety-crypto` 19 tests. Shared conventions in CONTRACTS §5. APNs/FCM builders unit-tested, no live credentials |
| M5 friend response (incident screens, ring/call/en-route/resolve, escalate card, audit log) | done (web mock verified only) | incident timeline, map after unlock, fallback-unlock approval flow, history + audit screens |
| M6 extra paths (audio classifier, snatch, manual SOS / intents / widgets / QS tile) | code complete | snatch detector tested in Rust. YAMNet wrappers, App Intent, widget, QS tile written. `yamnet.tflite` asset not bundled |
| M7 data + tuning (collection study, threshold tuning in sim) | partial | `tools/collect` + sim gate + protocol/consent written. No study data yet |
| M8 hardening + launch (crypto review, threat model, store compliance, privacy/terms, a11y, beta) | partial | THREAT_MODEL / PRIVACY / STORE_COMPLIANCE drafted. External review, a11y, beta todo |

Update this table at the end of the hackathon.

## Development notes

- All detection logic lives in Rust + native, never JS (`CLAUDE.md`).
- [docs/CONTRACTS.md §4](docs/CONTRACTS.md) lists the owner of each path. Do not write to paths that you do not own.
- CI: `.github/workflows/ci.yml` runs on every PR. `eas.yml` runs only when started manually (`EXPO_TOKEN` secret).
- Live telemetry (phone → `/monitor`) is one WebSocket to Supabase Realtime at 10 frames/s. The phone measures
  its own server round trip. Watch it with `adb logcat -s Telemetry:V SensingService:V Session:V` (one summary line a minute).
- The native service keeps the JWT alive itself (CONTRACTS §8). The stream and uploads continue when the app is in
  the background, when the screen is off or the phone is unplugged, and after a reboot. The service needs no USB or
  Metro. Only a dev-client build needs Metro for the UI.
- License: MIT.
