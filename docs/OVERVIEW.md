# Safe — what the software does

Safe is a passive night-out safety system. The person being protected (the *subject*) carries an Android
phone and never has to do anything. The phone watches how they move, notices when they can no longer ask
for help, gives them a chance to say "I'm fine", and only then tells their friends. Friends watch from a
web dashboard. Location is end-to-end encrypted and is released to friends only when a check-in goes
unanswered while the evidence still holds (or on a grab / SOS). The app never calls the police itself; friends decide.

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
  **heartbeat** (battery, night mode, escalation status) — never a location.

### Sensing (Kotlin service, 50 Hz)
- **Two sampling modes.** Low rate by default (10 Hz accelerometer, no gyro). Full rate (50 Hz accelerometer
  + gravity + gyroscope) when away from home at night, for 30 minutes after any incident, while the personal
  dashboard or telemetry stream is open, and during baseline walks. Sensor events arrive on their own thread,
  batched up to 1 s normally; while a stream is open batching is off (every sample as it happens) and a partial
  wake lock keeps the CPU up with the screen off and the phone unplugged.
- Also fed in: motion activity (still / walking / running / vehicle), screen and unlock events, time since the
  last touch, battery and charging, distance from home, and together/separated status from the server.
- **Microphone: listening windows only.** The mic is off unless the engine opens a listening window after a
  fall, a phone drop, a grab, a missed check-in or unsteady gait (night mode only): for 10 minutes after each,
  and for as long as an escalation runs. In a
  window, ~1 s frames are classified on-device by **YAMNet** (scream, shout, snoring) plus a sound level in dB.
  Only those labels reach the engine; audio is analysed in memory and never stored or uploaded.

### Detection (Rust core, `safety-core`, runs entirely on the device)
There is no probability model. Signals open and clear explicit **incidents**, each with a clearing rule, and
every one goes into an **on-device incident log** (timestamp, kind, tier, raw values, distance out of band in SDs,
placement, cleared time). Entries expire after 8 hours.

Every second the engine updates **live metrics** and compares each to the subject's **personal baseline band**
(mean ± 2.5 SD per phone placement — pocket / hand / bag; 3.5 SD until the baseline is trusted after 7 days of
ordinary walking; rolling 14-day window; nights that produced incidents are excluded).

Each incident has a **tier**: *context* is logged only; *watch* turns on full sensing (50 Hz + gyro, faster
location) and counts toward a check-in; *danger* asks "You okay?" on its own.

| Incident | Tier | Opens when | Clears when |
|---|---|---|---|
| Phone drop | watch | long free fall, lands flat, dead still, not picked up within 60 s | picked up |
| High-g impact (warning) | watch | the first reading above 2.5 g, at once | replaced by possible fall / cleared by a drop, a grab or no tilt ~2.4 s later |
| Possible fall | watch | impact > 2.5 g + orientation change + micro-motion after (or free fall + hard peak) | steps resume |
| Fall, recovered | context | steps resume after a possible fall | (a moment; expires with the log) |
| Down after fall | danger | after a possible fall or hard impact: no steps and no touch for 15 s | steps resume |
| Hard impact | watch | the high-g warning stays when the impact had a tilt but was neither a fall nor a drop | walking resumes |
| Unsteady gait | watch | stride variability / regularity / sway / wobble out of band for 30 s of walking | 2 min of in-band walking |
| Slowed walk | watch | cadence > 20 % below the baseline for 1 min of walking | 30 s at normal cadence |
| Stumble | context | one step interval > 40 % off rhythm with a sideways jolt, walking continues | (a moment; pruned after 30 min if nothing follows) |
| Repeated stumbles | watch | 3 stumbles within 5 min | 10 min of walking without one |
| Phone left behind | watch | phone set down (no micro-motion) 20 min while away late | picked up / touched |
| Grab | danger | in hand + jerk spike + sharp rotation, then running away | owner unlocks the phone |
| Separated | watch | > 150 m from all friends 10 min, not heading home | back with someone |
| Stopped on the way home | watch | distance home fell ≥ 200 m, then not moving 10 min, not home | moving again / home |
| In a vehicle | context | OS activity reports a vehicle | out of the vehicle |
| Battery critical | context | ≤ 10 % and not charging while away late (uploads the latest location) | charging / ≥ 15 % |
| Check-in missed | danger | "You okay?" unanswered for 2 min | answered |
| Check-in typing off | watch | check-in typing far off the personal typing baseline | a normal check-in |
| Scream / shout | watch | ≥ 2 frames of screaming/shouting within 2 min of a fall or grab, not in a loud venue | 10 min |
| Snoring while down | danger | snoring frames while down after a fall and a check-in was missed | answered / steps resume |

Context conditions that are states rather than events (away from home late, in a loud venue, phone set down) are
shown with the live metrics and used by the rules, not logged. A "phone dropped alone" that is picked up in time is
not an incident. Phone offline is detected server-side by the watchdog (below).

**Incident logging only (current default).** `auto_escalate = false` in `model-v1.toml`: every incident is
logged and drives full sensing and the listening window, but nothing escalates on its own. Set it to `true` to
enable the check-in / heads-up / unlock flow below. Manual SOS works either way.

**When to ask** (with `auto_escalate = true`). A check-in is asked when a danger incident is active, or when watch incidents from **two
independent families** (fall · gait · phone · location · check-in · audio) are active at once — e.g. unsteady
gait while separated, or a fall followed by screaming. Two incidents from one family (unsteady + slowed walk, both
from the same walk) never ask. Answering acknowledges what is active; only a new incident can ask again.

When an episode starts (check-in, grab, SOS) the incidents from the last hour join it, and friends later see its
one-line summary ("Unsteady walking, then a hard fall, then down for 2 min, then no answer to a check-in").

Encrypted location uploads every 5 minutes in night mode, every minute once friends were alerted.

### Escalation (Rust state machine)
1. **Check** — the trigger above holds: a high-priority "You okay?" notification. Opening it requires unlocking
   the phone (which blocks a thief). The subject types a random three-word phrase in a native input that
   measures their typing; they can also tap **"I need help"**, which skips straight to step 3.
2. **Heads-up** — no answer within 2 minutes while the trigger still holds (logged as *check-in missed*), or
   typing far off baseline: friends get "Sam might not be okay", with **no location**. If the evidence clears on
   its own (got up and walked, back with the group) the episode resolves instead.
3. **Location unlock** — still no answer 4 minutes after the check and the trigger still holds: the phone
   releases the current and next hour keys to friends and keeps uploading encrypted live location.
4. **Friends act** — ring the phone loudly, call, "I'm going", mark found/safe.
5. **Call option** — after 10 minutes with no response, friends get a one-tap campus safety / 911 option
   with a prefilled card. The app never calls on its own.

Other paths: a **grab** skips the check (immediate heads-up with no location; location unlocks after
2 minutes unless the owner unlocks the phone). **Manual SOS** (hold button, quick-settings tile, widget)
counts as consent and unlocks immediately. A wrong phrase leaves the check open for another try.

### Personal dashboard and demo mode
- Settings → **Personal dashboard** (off by default): live metrics vs bands, sensing / mic status and
  context, and the incident log (with the time each cleared), refreshed every second. Opening it forces full-rate sampling.
- Settings → **Demo sensitivity**: loads a partial config override (impact at 1.8 g, grab after a yank +
  twist + 2 s of jogging, unsteady gait after 10 s, down after a fall after 30 s, 30 s check-in, drop-vs-fall
  discrimination disabled) so incidents can be triggered by hand. Turning it off restores the production thresholds.
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
  gyroscope waveforms with the impact line, metric band tiles with out-of-band flashes and sparklines,
  a five-minute mic-listening strip, the live incident log (tier, cleared time, answered) and sequence markers,
  the engine event ticker, a check-in countdown, device status (heartbeat age, battery, night mode,
  presence), and the friend actions. Location is never part of telemetry; it stays on the escrow path.

---

## 5. Verification

- Rust: 59 core tests (golden stories A and B; every incident's open and clear rule — falls, drops, recovery,
  down after fall, unsteady / slowed gait, stumbles, left behind, separated, stopped on the way home, vehicle,
  battery, scream and snoring; the two-family check-in trigger, acknowledgement, grab timings, listening window,
  low-rate mode, episodes and summaries, baseline trust, config and old-blob compatibility) plus
  19 crypto tests (Shamir k-of-n properties, HPKE tamper cases, AEAD vectors, zeroization, proximity
  matching). A `sim` CLI replays recorded or synthetic traces through the full pipeline and gates CI on
  false-alarm rate and detection delay.
- Backend: 34 pgTAP assertions on RLS and unlock rules; 25 Deno tests on the edge functions; the telemetry
  channel policy proven live (subject publishes, stranger dropped and refused).
- App: TypeScript strict, lint, Maestro end-to-end flows with a debug trace-injection route; built,
  installed and exercised on a real Android phone against the hosted backend.

## 6. Repository map

```
core/crates/safety-core     detection engine (signal, baseline, incident rules, escalation, log, config)
core/crates/safety-crypto   escrow and proximity cryptography
core/crates/safety-ffi      uniffi bindings (Kotlin)      core/crates/safety-wasm   wasm-bindgen (web)
core/crates/sim             trace replay / synth / CI gate  core/config/model-*.toml  parameters
apps/mobile                 Expo app (phone UI + web monitor); modules/safety-native = Kotlin service + TS facade
supabase                    migrations, RLS, RPCs, edge functions, pgTAP
docs/CONTRACTS.md           the interface contract every layer codes against
```
