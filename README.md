# safe — passive night-out safety

Every safety app needs the person in danger to act. **safe** runs passively on a night out: it
notices when someone *can't* ask for help (gait drifting badly, a hard fall then no movement,
commotion, a snatched phone), asks *them* first ("You okay? type the 3 words"), and only then tells
their friends. Location stays end-to-end encrypted until a check-in goes unanswered, and no single
party — not one friend, not the company — can unlock it. Friends decide what to do; **the app never
calls police itself.** Detection runs in Rust on the device; the server only ever sees ciphertext,
proximity tokens and coarse status.

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

Pipeline: 50 Hz motion, context and (in listening windows only) audio labels → gait / impact / grab /
stillness signals against the user's own baseline per placement → rule-based incidents (possible fall,
down after fall, unsteady gait, stumbles, separated, stopped on the way home, phone left behind, scream,
…), each with a tier and a clearing rule → escalation state machine (Check → Heads-up → Unlock) when a
danger incident is active or two independent kinds of evidence coincide. No probability model.
Escrow: daily key `K_day` split k-of-n (Shamir) to friends, hourly `K_h = HKDF(K_day, hour)`,
locations XChaCha20-Poly1305 under `K_h`, shares HPKE-sealed + Ed25519-signed. Interfaces are fixed
in [docs/CONTRACTS.md](docs/CONTRACTS.md); the full design is [PLAN.md](PLAN.md).

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

Prereqs: Rust 1.99 (rustup), pnpm 12, Node 26, Deno 2, Supabase CLI; optional Android SDK + NDK
r27 (`cargo install cargo-ndk`).

```bash
pnpm install
cargo test --manifest-path core/Cargo.toml                    # Rust: golden stories, Shamir, AEAD/HPKE, proximity
(cd supabase && deno test --allow-all functions)              # edge functions
pnpm --filter mobile typecheck                                # app
cargo run --manifest-path core/Cargo.toml -p sim -- batch core/traces   # regression gate (false alarms / detection delay)
core/build-mobile.sh                                          # android .so + kotlin bindings
pnpm --filter mobile android                                  # debug dev-build with inject-trace enabled
```

Backend locally: `cd supabase && supabase start && supabase db reset && supabase functions serve`.
Copy the URL + anon key into `apps/mobile/.env`.

## Demo for judges

Full script: [docs/DEMO.md](docs/DEMO.md). Short version, one phone/emulator + web mock friend:

1. `pnpm --filter mobile web` → open with `?mock=friend&subject=<user-id>` as the friend screen.
2. On the device/emulator: `adb shell am start -a android.intent.action.VIEW -d 'safe://debug/inject?trace=checkin-dismiss'`
   (iOS: `xcrun simctl openurl booted 'safe://debug/inject?trace=checkin-dismiss'`). Type the
   3 words → dismissed, friend sees nothing.
3. Inject `heads-up`, ignore the check-in → friend gets "might not be okay" **without location** →
   2 min later, still down → friend's map appears. Show `location_blobs.ciphertext` in Studio.
4. Inject `snatch` → immediate "don't chase" alert with the snatch-moment pin; biometric-only dismiss.
5. Hold the SOS button → `manual-sos`. Headless: `maestro test e2e/`.

Trace names (`checkin-dismiss`, `heads-up`, `unlock-map`, `snatch`, `manual-sos`) are shared by
`core/traces/`, `e2e/`, and the app's bundled debug traces.

## Privacy in one paragraph

Home places, baselines and keys never leave the phone. The microphone only listens after a fall, drop,
grab, missed check-in or unsteady walking; audio is classified in memory into scream / shout / snoring
labels and discarded. Location uploads are ciphertext under an hourly key; the server
keeps 6 h and cannot decrypt. Friends learn only together/separated (HMAC'd geohash tokens) and a coarse
status (night mode, battery, escalation level), until a check-in is missed, the user taps "I need help"/SOS, or the phone goes
offline and ≥ 2 friends approve a fallback unlock. Every unlock is logged and shown to the subject
and the whole group. Accepted risks and adversary table: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Status (PLAN §8 milestones)

| Milestone | Status | Notes |
|---|---|---|
| M0 spikes (locked-phone 50 Hz, iOS bg mic, battery, EAS build, Critical Alerts) | todo | hardware spikes need real phones; Apple entitlement deliberately out of hackathon scope |
| M1 foundation (monorepo, CI, schema + RLS, auth, onboarding, QR friends, groups) | done (unverified on device) | workspaces, CI, contracts, 4 migrations (pgTAP 25/25 on Postgres 17), OTP/OAuth sign-in, onboarding, QR add, groups screens; typecheck passes |
| M2 sensing (native services, night-mode controller, Rust features, baselines, trace recorder) | code complete, uncompiled natively | Swift + Kotlin services written against generated uniffi bindings (no Xcode/SDK here); `safety-core` signal/baseline tested |
| M3 reasoning (incident rules, escalation, typing check-in, replayed traces) | done | v2 engine: rule-based incidents with tiers (HMM / P(danger) removed), live signal bands, gyro, grab + stumble detectors, listening windows; 59 core tests, `sim batch` 6/6 (fall trace: check at 3:15, unlock at 7:15; story B quiet) |
| M4 escrow (epochs, Shamir, HPKE, blobs, normal + fallback unlock, proximity, push, watchdog) | done (push unverified live) | `safety-crypto` 19 tests; shared conventions in CONTRACTS §5; APNs/FCM builders unit-tested, no live credentials |
| M5 friend response (incident screens, ring/call/en-route/resolve, escalate card, audit log) | done (web mock verified only) | incident timeline, map after unlock, fallback-unlock approval flow, history + audit screens |
| M6 extra paths (audio classifier, snatch, manual SOS / intents / widgets / QS tile) | code complete | snatch detector tested in Rust; YAMNet wrappers, App Intent, widget, QS tile written; `yamnet.tflite` asset not bundled |
| M7 data + tuning (collection study, threshold tuning in sim) | partial | `tools/collect` + sim gate + protocol/consent written; no study data yet |
| M8 hardening + launch (crypto review, threat model, store compliance, privacy/terms, a11y, beta) | partial | THREAT_MODEL / PRIVACY / STORE_COMPLIANCE drafted; external review, a11y, beta todo |

Update this table at the end of the hackathon.

## Development notes

- All detection logic lives in Rust + native, never JS (`CLAUDE.md`).
- Owners per path are in [docs/CONTRACTS.md §4](docs/CONTRACTS.md); do not cross-write.
- CI: `.github/workflows/ci.yml` runs on every PR; `eas.yml` is manual (`EXPO_TOKEN` secret).
- Live telemetry (phone → `/monitor`) is one WebSocket to Supabase Realtime at 10 frames/s; the phone measures its own
  server round trip. Watch it with `adb logcat -s Telemetry:V SensingService:V Session:V` (one summary line a minute).
  The native service keeps the JWT alive itself (CONTRACTS §8), so the stream and uploads survive a backgrounded app,
  a screen-off / unplugged phone and a reboot; it needs no USB or Metro — only a dev-client build needs Metro for the UI.
- License: MIT.
