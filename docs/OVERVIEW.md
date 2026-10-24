# Safe — what the software does

Safe is a passive night-out safety system. The person being protected (the *subject*) carries an Android
phone and never has to do anything. The phone watches how they move, notices when they can no longer ask
for help, gives them a chance to say "I'm fine", and only then tells their friends. Friends watch from a
web dashboard. Location is end-to-end encrypted and is released to friends only when the danger estimate
is high. The app never calls the police itself; friends decide.

Three pieces: an **Android app** (Expo UI + Kotlin sensing service + Rust detection core), a **Supabase
backend** (Postgres with row-level security, Realtime, edge functions), and a **web monitor** (the same
Expo code base built for the browser, with the Rust crypto compiled to WebAssembly).

---

## 1. On the phone

### Night mode
- The subject saves home places once (stored only on the device). Night mode starts automatically when they
  are away from home inside their evening window (default 8pm–6am) and ends when they get home. It can also
  be forced on, off, or paused for tonight from the home screen.
- A persistent Android foreground service keeps sensing alive with the screen off. Every 2 minutes it sends a
  **heartbeat** (battery, night mode, coarse risk band) — never a location.

### Sensing (Kotlin service, 50 Hz)
- **Two sampling modes.** Low rate by default (10 Hz accelerometer, no gyro). Full rate (50 Hz accelerometer
  + gravity + gyroscope) when away from home at night, for 30 minutes after any incident, while the personal
  dashboard or telemetry stream is open, and during baseline walks. Sensor events arrive on their own thread,
  batched up to 1 s normally; while a stream is open batching is off (every sample as it happens) and a partial
  wake lock keeps the CPU up with the screen off and the phone unplugged.
- Also fed in: motion activity (still / walking / running / vehicle), screen and unlock events, time since the
  last touch, battery, distance from home, together/separated status from the server, and (at night) a
  duty-cycled microphone classified on-device by **YAMNet** for screams, shouts and breaking glass. Audio
  is analysed in memory only and never stored or uploaded.

### Detection (Rust core, `safety-core`, runs entirely on the device)
Every second the engine updates a set of **live metrics** and compares each to the subject's **personal
baseline band** (mean ± 2.5 SD per phone placement — pocket / hand / bag; 3.5 SD until the baseline is
trusted after 7 days of ordinary walking; rolling 14-day window; nights that produced incidents are excluded):

| Metric | Source | Rule |
|---|---|---|
| Cadence, stride-time variability, step regularity, lateral sway | accelerometer | out of band for 30 s of walking ⇒ **Gait drift** |
| Wobble while walking | gyroscope | above band 30 s ⇒ Gait drift |
| Peak force | accelerometer | > 2.5 g with orientation change (or a free-fall pattern) ⇒ **Impact** |
| Jerk + rotation rate | accel + gyro | spike while the phone is in hand, followed by running away ⇒ **Grab** |
| Still 3 min + no touch 3 min after an impact | activity + touch | ⇒ **Stillness** |
| Separated > 150 m from all friends 10 min, not heading home | proximity tokens + home distance | ⇒ **Separated** |
| Typing latency / error rate at check-in | native typing view | outside band ⇒ **Typing off** |

- A **"phone dropped alone"** pattern (long free fall, lands flat, no body motion) is deliberately *not* an
  incident; it resolves when the phone is picked up.
- Each incident goes into an **on-device incident log** (timestamp, type, raw values, distance out of band
  in SDs, placement, state probabilities at that moment). Entries expire after 8 hours. A rule-based
  **sequence agent** scans the log for runs that are concerning together (e.g. gait drift → separated →
  impact → stillness), links them into a sequence, boosts the model, prunes isolated minor events, and
  writes the one-line summary friends later see ("Hard fall, then no movement for 4 min").
- A four-state **hidden Markov model** — Normal / Impaired / Incident / Unresponsive — runs a log-space
  forward filter once a minute and immediately on any incident. Emissions are conditioned on the state;
  context (away from home, late, separated, rapid drift onset, sequence boost) shifts only the *forward*
  transitions. Recovery transitions are built in, so "sat still, then got up and walked" never alarms.
  `P(danger) = P(Incident) + P(Unresponsive)`.

### Escalation (Rust state machine with hysteresis and cooldowns)
1. **Check** — `P(danger) ≥ 0.7`: a high-priority "You okay?" notification. Opening it requires unlocking
   the phone (which blocks a thief). The subject types a random three-word phrase in a native input that
   measures their typing; they can also tap **"I need help"**, which skips straight to step 3.
2. **Heads-up** — no response for 2 minutes, or typing far off baseline: friends get "Sam might not be
   okay", with **no location**.
3. **Location unlock** — still no response and `P ≥ 0.9`: the phone releases the current and next hour
   keys to friends and keeps uploading encrypted live location.
4. **Friends act** — ring the phone loudly, call, "I'm going", mark found/safe.
5. **Call option** — after 10 minutes with no response, friends get a one-tap campus safety / 911 option
   with a prefilled card. The app never calls on its own.

Other paths: a **grab** skips the check (immediate heads-up with no location; location unlocks after
2 minutes unless the owner unlocks the phone). **Manual SOS** (hold button, quick-settings tile, widget)
counts as consent and unlocks immediately. A correct check-in resets the model and lowers sensitivity for
30 minutes; a wrong phrase counts as evidence.

### Personal dashboard and demo mode
- Settings → **Personal dashboard** (off by default): live metrics vs bands, the four state probabilities,
  and the incident log, refreshed every second. Opening it forces full-rate sampling.
- Settings → **Demo sensitivity**: loads a partial config override (impact at 1.8 g, grab after a yank +
  twist + 2 s of jogging, gait drift after 10 s, 30 s check-in, drop-vs-fall discrimination disabled) so
  incidents can be triggered by hand. Turning it off restores the production thresholds.
- Model parameters live in a signed TOML served by the backend and merged over bundled defaults, so a
  config update can never brick the engine.

---

## 2. Privacy and cryptography (Rust `safety-crypto`, also compiled to WebAssembly)

- Each device holds an X25519 key (for sealing) and an Ed25519 key (for signing) in the Android Keystore.
  Friends are added **in person by QR code** carrying the user id and key fingerprint, so the server can
  never swap in its own keys.
- Every day the phone generates a random **day key**; hour keys are derived from it (HKDF). The day key is
  split with **Shamir secret sharing** (k-of-n over GF(256), default k = 2, fallback unlock needs ≥ 3
  members) and each share is sealed to a friend's key with **HPKE** and signed.
- In night mode the phone uploads a location every 1–5 minutes (faster as risk rises), encrypted with
  **XChaCha20-Poly1305** under the hour key. The server keeps only the last 6 hours of ciphertext and can
  decrypt nothing — pgTAP asserts no decrypt path exists.
- **Normal unlock**: the phone seals the current and next hour keys to each friend. **Fallback unlock**
  (phone offline or battery dying): a friend opens a request, each approving friend re-seals their share,
  and k shares rebuild the day key. Every unlock is logged in an audit trail visible to the subject and the
  whole group.
- **Together / separated** uses HMAC'd geohash tokens: the server learns only "together" or "separated",
  never coordinates.
- A server **watchdog** (pg_cron, every minute) opens an "offline" incident when heartbeats stop for
  10 minutes at night, and a "battery dying" incident at 3%.

---

## 3. Backend (Supabase)

- Postgres tables for profiles, devices, groups, epochs, key shares, location blobs, proximity tokens,
  presence, incidents, incident events, released keys, unlock requests/approvals, audit log and model
  configs — all behind **row-level security** (members-only reads, subject-only writes, trigger-written
  audit rows).
- RPCs for heartbeat, opening/resolving incidents, incident events, invites, fallback unlock (refused
  without an offline incident or with fewer than 3 members), purge and the watchdog.
- Edge functions: `push` (direct APNs/FCM fan-out with critical/time-sensitive fields), `watchdog`,
  `proximity`, `unlock`, `purge`, `config`.
- Realtime: friends' screens subscribe to incidents, events, released keys, location blobs and presence.
- A private **telemetry broadcast channel** per subject (`telemetry:{uid}`) carries the live stream below;
  the phone also refreshes its own JWT (native `SessionKeeper`) so uploads and the channel outlive a sleeping
  JS runtime, a backgrounded app or a reboot;
  policies allow the subject to publish and only group-mates to subscribe.

---

## 4. Web monitor (friend side, runs in any browser)

- Signs in like the app and uses the same screens: groups and QR, incident timeline, map after unlock
  (OpenStreetMap, no key), Ring / Call / I'm going / Found, fallback-unlock approval. All escrow operations
  (opening released keys, decrypting blobs, re-sealing shares, recovering the day key) run in the browser
  via the Rust crypto compiled to WebAssembly.
- `/monitor` is a **real-time telemetry console** for the subject's phone, fed ten frames a second over one
  persistent Supabase Realtime WebSocket (no database writes; the phone measures and shows its own server round
  trip, and the waveform is drawn on the phone's sensor clock so network jitter never distorts it): scrolling 50 Hz accelerometer and
  gyroscope waveforms with the impact line, metric band tiles with out-of-band flashes and sparklines, a
  five-minute danger strip, the stacked state probabilities, the live incident log and sequence markers,
  the engine event ticker, a check-in countdown, device status (heartbeat age, battery, night mode, risk
  band, presence), and the friend actions. Location is never part of telemetry; it stays on the escrow path.

---

## 5. Verification

- Rust: 48 core tests (golden stories A and B, recovery, context only moving forward transitions, grab
  timings, drift persistence, low-rate mode, sequence agent, baseline trust, config compatibility) plus
  19 crypto tests (Shamir k-of-n properties, HPKE tamper cases, AEAD vectors, zeroization, proximity
  matching). A `sim` CLI replays recorded or synthetic traces through the full pipeline and gates CI on
  false-alarm rate and detection delay.
- Backend: 34 pgTAP assertions on RLS and unlock rules; 25 Deno tests on the edge functions; the telemetry
  channel policy proven live (subject publishes, stranger dropped and refused).
- App: TypeScript strict, lint, Maestro end-to-end flows with a debug trace-injection route; built,
  installed and exercised on a real Android phone against the hosted backend.

## 6. Repository map

```
core/crates/safety-core     detection engine (signal, baseline, hmm, escalation, log, config)
core/crates/safety-crypto   escrow and proximity cryptography
core/crates/safety-ffi      uniffi bindings (Kotlin)      core/crates/safety-wasm   wasm-bindgen (web)
core/crates/sim             trace replay / synth / CI gate  core/config/model-*.toml  parameters
apps/mobile                 Expo app (phone UI + web monitor); modules/safety-native = Kotlin service + TS facade
supabase                    migrations, RLS, RPCs, edge functions, pgTAP
docs/CONTRACTS.md           the interface contract every layer codes against
```
