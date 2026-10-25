# Safe: what the software does

Safe is a passive night-out safety system. The person under protection (the *subject*) carries an Android
phone and never has to do anything. The phone watches how the subject moves and notices when they can no
longer ask for help. It gives them a chance to say "I'm fine", and only then tells their friends. Friends
watch from a web dashboard.

Location is end-to-end encrypted. Friends get it only when a check-in goes unanswered while the evidence
still holds, or on a grab / SOS. The app never calls the police itself. Friends decide.

The system has three pieces. The **Android app** has an Expo UI, a Kotlin sensing service and a Rust
detection core. The **Supabase backend** has Postgres with row-level security, Realtime and edge
functions. The **web monitor** is the same Expo code base built for the browser, with the Rust crypto
compiled to WebAssembly.

---

## 1. On the phone

### Night mode
- The subject saves home places once (stored only on the device). Night mode starts automatically when
  they are away from home inside their evening window (default 8pm to 6am). It ends when they get home.
  The subject can also turn it on, turn it off, or pause it for tonight from the home screen.
- A persistent Android foreground service keeps sensing alive with the screen off. Every 2 minutes it
  sends a **heartbeat** (battery, night mode, escalation status). The heartbeat never carries a location.

### Sensing (Kotlin service, 50 Hz)
- **Two sampling modes.** Low rate is the default (10 Hz accelerometer, no gyro). Full rate (50 Hz
  accelerometer + gravity + gyroscope) runs when the subject is away from home at night, for 30 minutes
  after any incident, while the personal dashboard or telemetry stream is open, and during baseline walks.
  Sensor events arrive on their own thread, normally in batches of up to 1 s. While a stream is open,
  batching is off, so every sample arrives as it happens. A partial wake lock keeps the CPU awake with the
  screen off and the phone unplugged.
- The engine also gets motion activity (still / walking / running / vehicle), screen and unlock events,
  time since the last touch, battery and charging, distance from home, and together/separated status from
  the server.
- **Microphone: listening windows only.** The mic is off unless the engine opens a listening window
  (night mode only). A window opens after a fall, a phone drop, a grab, a missed check-in or unsteady gait.
  It stays open for 10 minutes after each, and for as long as an escalation runs. In a window, on-device
  **YAMNet** classifies ~1 s frames (scream, shout, snoring) and measures a sound level in dB. Only those
  labels reach the engine. The phone analyzes audio in memory and never stores or uploads it.

### Detection (Rust core, `safety-core`, runs entirely on the device)
The engine has no probability model. Signals open and clear explicit **incidents**, each with a clearing
rule. Every incident goes into an **on-device incident log** (timestamp, kind, tier, raw values, distance
out of band in SDs, placement, cleared time). Entries expire after 8 hours.

Every second, the engine updates **live metrics** and compares each one to the subject's **personal
baseline band**. The band is mean ± 2.5 SD per phone placement (pocket / hand / bag). Until the baseline is
trusted, the band is 3.5 SD. The baseline becomes trusted after 7 days of ordinary walking. It uses a
rolling 14-day window and excludes nights that produced incidents.

Each incident has a **tier**. A *context* incident is logged only. A *watch* incident turns on full sensing
(50 Hz + gyro, faster location) and counts toward a check-in. A *danger* incident asks "You okay?" on its
own.

| Incident | Tier | Opens when | Clears when |
|---|---|---|---|
| Phone drop | watch | long free fall, lands flat, dead still, not picked up within 60 s | picked up |
| High-g impact (warning) | watch | the first reading above 2.5 g, at once | replaced by possible fall / cleared by a drop, a grab or no tilt ~2.4 s later |
| Possible fall | watch | impact > 2.5 g + orientation change + micro-motion after (or free fall + hard peak) | steps resume |
| Fall, recovered | context | steps resume after a possible fall | (a moment, expires with the log) |
| Down after fall | danger | after a possible fall or hard impact: no steps and no touch for 15 s | steps resume |
| Hard impact | watch | the high-g warning stays when the impact had a tilt but was neither a fall nor a drop | walking resumes |
| Unsteady gait | watch | stride variability / regularity / sway / wobble out of band for 30 s of walking | 2 min of in-band walking |
| Slowed walk | watch | cadence > 20 % below the baseline for 1 min of walking | 30 s at normal cadence |
| Stumble | context | one step interval > 40 % off rhythm with a sideways jolt, walking continues | (a moment, pruned after 30 min if nothing follows) |
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

Some context conditions are states, not events: away from home late, in a loud venue, phone set down. The
dashboard shows them with the live metrics and the rules use them, but the log does not record them. A
"phone dropped alone" that is picked up in time is not an incident. The watchdog detects phone offline on
the server (below).

**Incident logging only (current default).** `model-v1.toml` sets `auto_escalate = false`. Every incident
goes into the log and drives full sensing and the listening window, but nothing escalates on its own. Set
it to `true` to turn on the check-in / heads-up / unlock flow below. Manual SOS works either way.

**When to ask** (with `auto_escalate = true`). The phone asks for a check-in when a danger incident is
active. It also asks when watch incidents from **two independent families** (fall · gait · phone ·
location · check-in · audio) are active at once. Examples are unsteady gait while separated, or a fall
followed by screaming. Two incidents from one family never ask, for example unsteady + slowed walk from
the same walk. An answer acknowledges what is active. After that, only a new incident can ask again.

When an episode starts (check-in, grab, SOS), the incidents from the last hour join it. Friends later see
its one-line summary ("Unsteady walking, then a hard fall, then down for 2 min, then no answer to a
check-in").

The phone uploads encrypted location every 5 minutes in night mode. After friends get an alert, it uploads
every minute.

### Escalation (Rust state machine)
Automatic escalation is on (`auto_escalate = true`, served config v3). A possible fall, hard impact or
scream asks on its own once it has been open 5 s (`incidents.check_alone`). The delay lets the engine
reclassify a dropped phone's impact first. Danger incidents always ask. Milder incidents need two families
at once.

1. **Check**: a full-screen "You okay?" on the lock screen. It says what the engine detected ("A possible
   fall") and shows a countdown.
   - **I'm OK** first makes the owner prove who they are. The owner unlocks the secure lock screen, or
     passes a fingerprint / device PIN prompt if the phone is already unlocked. A thief cannot pass it,
     and native code refuses a typed answer without it.
   - Only then does the phone show the random three-word phrase. The subject types it in a native input
     that measures their typing. An accepted phrase dismisses the check. Typing far off their rhythm tells
     friends "answered, but may be impaired".
   - **I need help** works for anyone and goes straight to step 3.
   - Phones without a secure lock screen answer by typing only, and the phone logs the answer as
     unverified.
2. **Heads-up**: this step starts when there is no answer within 2 minutes while the trigger still holds
   (logged as *check-in missed*). It also starts when the typing is far off the baseline. Friends get "Sam
   might not be okay", with **no location**. If the evidence clears on its own (got up and walked, back
   with the group), the episode resolves instead.
3. **Location unlock**: there is still no answer 4 minutes after the check, and the trigger still holds.
   The phone releases the current and next hour keys to friends and keeps uploading encrypted live
   location.
4. **Friends act**: from the monitor's escalation dock or the incident screen, friends can:
   - ring the phone loudly
   - call the person
   - alert every friend
   - call 911 / campus safety
   - ask for the location now (the phone releases it to the group and tells its owner who asked)
   - say "I'm going"
   - mark found/safe (the phone gets the message and stops alerting)

   While friends are involved, the phone keeps an ongoing "Your friends were told · Tap if you're OK"
   notification.
5. **Call option**: after 10 minutes with no response, friends get a one-tap campus safety / 911 option
   with a prefilled card. The app never calls on its own.

**Demo mode** (Settings → Demo sensitivity) shortens every timer. It also makes a red incident (for
example down after a fall) unlock the location at once. The friends' dashboard then opens its escalation
dock with the phone's map within a second of the incident. A new check-in can follow 15 s after the last.

Other paths: a **grab** skips the check. It sends an immediate heads-up with no location, and the location
unlocks after 2 minutes unless the owner unlocks the phone. **Manual SOS** (hold button, quick-settings
tile, widget) counts as consent and unlocks at once. A wrong phrase leaves the check open for another try.

### Personal dashboard and demo mode
- Settings → **Personal dashboard** (off by default): live metrics vs bands, sensing / mic status and
  context, and the incident log (with the time each incident cleared). It refreshes every second. Opening
  it forces full-rate sampling.
- Settings → **Demo sensitivity**: loads a partial config override so you can trigger incidents by hand.
  It sets impact at 1.8 g and grab after a yank + twist + 2 s of jogging. Unsteady gait opens after 10 s,
  down after a fall after 30 s, and the check-in lasts 30 s. It also disables drop-vs-fall discrimination. Turn it off to
  restore the production thresholds.
- The backend serves the model parameters in a signed TOML. The engine merges it over bundled defaults, so
  a config update can never brick the engine.

---

## 2. Privacy and cryptography (Rust `safety-crypto`, also compiled to WebAssembly)

- Each device holds an X25519 key (for sealing) and an Ed25519 key (for signing) in the Android Keystore.
  Friends add each other **in person by QR code**. The code carries the user id and key fingerprint, so
  the server can never replace the keys with its own.
- Every day the phone generates a random **day key**. Hour keys come from it (HKDF). The phone splits the
  day key with **Shamir secret sharing** (k-of-n over GF(256), default k = 2, fallback unlock needs ≥ 3
  members). It seals each share to a friend's key with **HPKE** and signs it.
- In night mode, the phone uploads a location every 1 to 5 minutes (faster as risk rises). It encrypts
  each location with **XChaCha20-Poly1305** under the hour key. The server keeps only the last 6 hours of
  ciphertext and can decrypt nothing. A pgTAP test asserts that no decrypt path exists.
- **Normal unlock**: the phone seals the current and next hour keys to each friend. **Fallback unlock**
  (phone offline or battery dying): a friend opens a request, and each approving friend re-seals their
  share. Any k shares rebuild the day key. An audit trail logs every unlock, and the subject and the whole
  group can see it.
- **Together / separated** uses HMAC'd geohash tokens. The server learns only "together" or "separated",
  never coordinates.
- A server **watchdog** (pg_cron, every minute) opens an "offline" incident when heartbeats stop for
  10 minutes at night. It opens a "battery dying" incident at 3%.

---

## 3. Backend (Supabase)

- Postgres has tables for profiles, devices, groups, epochs, key shares, location blobs, proximity tokens,
  presence, incidents, incident events, released keys, unlock requests/approvals, audit log and model
  configs. All of them sit behind **row-level security**: members-only reads, subject-only writes and
  trigger-written audit rows.
- RPCs for heartbeat, opening/resolving incidents, incident events, invites, fallback unlock, purge and the
  watchdog. The fallback-unlock RPC refuses a request without an offline incident or with fewer than 3
  members.
- Edge functions: `push` (direct APNs/FCM fan-out with critical/time-sensitive fields), `watchdog`,
  `proximity`, `unlock`, `purge`, `config`.
- Realtime: friends' screens subscribe to incidents, events, released keys, location blobs and presence.
- A private **telemetry broadcast channel** per subject (`telemetry:{uid}`) carries the live stream below.
  Policies allow the subject to publish and only group-mates to subscribe. The phone also refreshes its own
  JWT (native `SessionKeeper`). This way, uploads and the channel outlive a sleeping JS runtime, a
  backgrounded app or a reboot.

---

## 4. Web monitor (friend side, runs in any browser)

- The monitor signs in like the app and uses the same screens: groups and QR, incident timeline, map after
  unlock (OpenStreetMap, no key), Ring / Call / I'm going / Found, fallback-unlock approval. All escrow
  operations run in the browser through the Rust crypto compiled to WebAssembly. These operations open
  released keys, decrypt blobs, re-seal shares and recover the day key.
- `/monitor` has an **escalation dock** in the bottom right. It appears while the subject has an escalated,
  unresolved incident, and it shows the elapsed time. If the incident is not resolved in time, the dock
  turns red, beeps and opens itself. The limit is the phone's 10-minute call option, or 10 min with the
  incident open. Actions: call 911 / campus safety (with copyable "what to tell them" text), call or ring
  the person, alert all friends, get location (inline map once keys arrive), I'm going, found / safe.
- `/monitor` is also a **real-time telemetry console** for the subject's phone. It gets ten frames a second
  over one persistent Supabase Realtime WebSocket, with no database writes. The phone measures its own
  server round trip and shows it. The monitor draws the waveform on the phone's sensor clock, so network
  jitter never distorts it.

  The console shows scrolling 50 Hz accelerometer and gyroscope waveforms with the impact line, and metric
  band tiles with out-of-band flashes and sparklines. It also shows a five-minute mic-listening strip, the
  live incident log (tier, cleared time, answered) with sequence markers, the engine event ticker and a
  check-in countdown. Location is never part of telemetry. It stays on the escrow path.
- The monitor's right column is an **AI read of the incident log**.
  - `components/monitor/incidentTimeline.ts` first turns the log into a structured JSON timeline. For each
    incident it records the kind, tier, family, clock time, how long ago, gap since the previous one, how
    long it lasted (or has lasted so far), active / answered, episode, and whether it came after a grab.
    It also records bursts (incidents each within 5 min of the last), pairs open at the same time and a
    weighted 15-minute trend.
  - The timeline also lists matched ordered **chains** with their timing windows: impact → scream within
    2 min, fall → down → missed check-in → snoring, impaired → separated → in a vehicle, and grab → phone
    moving away. Reassuring chains, such as a recovered fall or a lone drop, are also matched. A part-way
    chain says which step would come next and how long that window stays open, or that it stalled. No
    measurements, summaries, sensor state, location or audio go in.
  - The friend's browser sends that timeline to Claude when `EXPO_PUBLIC_ANTHROPIC_API_KEY` is set. The
    default is Claude Haiku 5.5 via the official SDK, at medium effort, with structured outputs to enforce
    the answer shape. Otherwise, or when Claude fails or declines, the timeline goes to a small free
    OpenRouter model. The default is NVIDIA Nemotron 3.5 Lightning (3B active parameters, low reasoning
    effort).
  - The model reasons over order, gaps and durations. It returns a risk level with a 0-100 score (low
    0-24, elevated 25-49, high 50-74, critical 75-100), a trajectory and a confidence. It also returns the
    factors that moved the score up or down, how the incidents chain together, the innocent explanation,
    what would change the read, and short pop-up reminders (`components/monitor/riskAnalysis.ts`). The
    engine's own escalation sets a floor: heads-up ⇒ at least high, unlocked / snatch ⇒ critical.
  - The read is advisory. Detection and escalation stay in the Rust engine.
  - The monitor asks the model only when the picture changes. Changes are a new / cleared / answered
    record, an escalation step, a check-in or a friend action. Time also counts: an open incident that
    crosses 1, 2, 5, 10, 20, 40 or 60 min, or a calm period that crosses 10, 30 or 60 min. The monitor debounces the request
    and asks at most every 45 s unless the escalation rises. It caches the last read per person.
  - Chain tests: `pnpm --filter mobile test`.
  - Keys in `apps/mobile/.env`: `EXPO_PUBLIC_ANTHROPIC_API_KEY` and/or `OPENROUTER_API_KEY`. Both end up
    in the web bundle. Give the Claude key a low monthly spend limit, and use a free-tier OpenRouter key.
    The monitor deliberately does not read a plain `ANTHROPIC_API_KEY`, so a shell-exported key never goes
    into the bundle by accident.

---

## 5. Verification

- Rust: 59 core tests. They cover golden stories A and B and every incident's open and clear rule: falls,
  drops, recovery, down after fall, unsteady / slowed gait, stumbles, left behind, separated, stopped on
  the way home, vehicle, battery, scream and snoring. They also cover the two-family check-in trigger,
  acknowledgment, grab timings, the listening window, low-rate mode, episodes and summaries, baseline
  trust, and config and old-blob compatibility. There are also 19 crypto tests (Shamir k-of-n properties,
  HPKE tamper cases, AEAD vectors, zeroization, proximity matching). A `sim` CLI replays recorded or
  synthetic traces through the full pipeline and gates CI on false-alarm rate and detection delay.
- Backend: 34 pgTAP assertions on RLS and unlock rules, and 25 Deno tests on the edge functions. A live
  test proved the telemetry channel policy: the subject publishes, and the channel drops and refuses a
  stranger.
- App: TypeScript strict, lint, and Maestro end-to-end flows with a debug trace-injection route. The app
  has been built, installed and tested on a real Android phone against the hosted backend.

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
