# pip (repo: safe): everything the software does

This is a complete feature list, checked against the code on 2026-10-24 (commit `6cc9b4c`).
[PLAN.md](../PLAN.md) gives the design reasons. [CONTRACTS.md](CONTRACTS.md) gives the exact interfaces.

---

## 1. What it is

**safe** is a passive night-out safety system for a group of friends. The person under protection (the
*subject*) carries an Android phone and does nothing special. The phone watches how the subject moves. It
notices when the subject may not be able to ask for help. Examples are unsteady walking, a hard fall with
no movement after it, a scream, or a snatched phone. It **asks the subject first** ("You okay?") and tells their
friends only if the subject does not answer.

Until then, location stays end-to-end encrypted. No single party can decrypt it alone. This includes any
one friend and the server operator. Friends decide what to do. **The app never calls the police or anyone
else on its own.**

The system has three pieces:

| Piece | Tech | Role |
|---|---|---|
| Android app | Expo / React Native UI + Kotlin foreground service + Rust core (uniffi) | Sensing, detection, escalation, encryption, uploads |
| Backend | Supabase: Postgres + row-level security, Realtime, Deno edge functions, pg_cron | Stores only ciphertext, proximity tokens and coarse status. Push fan-out. Watchdog |
| Web monitor | The same Expo code built for the browser, Rust crypto compiled to WebAssembly | The friends' side: live telemetry, incident screens, decryption of released locations |

The project dropped iOS and removed the Swift module. The platforms are Android and the web monitor.

> Not an emergency service. Detection is heuristic and can miss events or raise false alarms. 18+ only.

---

## 2. Subject's phone: sensing (Kotlin, `modules/safety-native/android`)

### Always-on foreground service
- `SensingService` is a persistent Android foreground service. It runs with the screen off, off the
  charger, and after reboots (`BootReceiver`, `START_STICKY`).
- After a reboot, Android does not let the service open the microphone again from the background. The
  service restarts without mic access and posts a **"tap to re-arm"** notification.
- Before the user grants location permission, the service runs as a `specialUse` service. After the
  grant, it upgrades.

### Night mode
- The subject saves **home places** once. They stay on the phone and are never uploaded.
- Night mode starts **automatically** when the subject is away from home inside their **evening window**
  (default 20:00 to 06:00, editable). It ends when the subject gets home or when the window ends.
- Manual modes: `auto`, `on`, `off`, `paused_tonight` (on the home screen and in Settings).
- When the subject goes home, night mode turns off and every active incident clears.
- Geofence and activity-recognition receivers drive night mode, with a 1 s tick at night and a 60 s tick
  by day.

### Two sampling modes (decided by the Rust engine, executed by native)
| Mode | Sensors | When |
|---|---|---|
| **Low** (default) | ~10 Hz accelerometer + gravity, no gyro, batched 1 s | All day while the service runs |
| **Full** | 50 Hz accelerometer + gravity + gyroscope | Away from home 21:00 to 06:00. While any watch/danger incident is active, and for 30 min after any incident. During a baseline walk, or while the engine learns a daytime walk. While the personal dashboard or telemetry stream is open |

During streaming, sensor batching is off, so every sample arrives as it happens. A partial wake lock keeps
the CPU awake.

### Other inputs fed to the engine
- OS activity (still / walking / running / vehicle), GPS speed.
- Screen on/off and owner unlock events. **Time since last touch**, from in-app touches, `USER_PRESENT`
  and keyguard transitions. The app uses no accessibility service.
- Battery level and charging.
- Distance to the nearest home place (the phone computes it).
- Together/separated status from the server.

### Microphone: listening windows only
- The mic is **off by default, also at night.** The engine opens a listening window (night mode only)
  after a phone drop, possible fall, down after fall, hard impact, grab, missed check-in, unsteady gait or
  repeated stumbles. It also opens one while an escalation runs. The window closes 10 min after the newest
  such incident.
- Inside a window, on-device **YAMNet** (TFLite, bundled) classifies ~0.975 s frames of 16 kHz audio. It
  gives three scores (**scream, shout, snoring**) and a sound level in dB SPL.
- Only those numbers reach the engine. PCM stays in one buffer. The phone classifies it, zeroes it and
  drops it. The app does not record, store or upload any audio.

### Location
- In night mode, the phone uploads an **encrypted** location every 5 min. After friends get an alert, it
  uploads one every 60 s.
- Coordinates never appear in telemetry, heartbeats or push payloads.

### Heartbeat
- The phone sends a heartbeat every 2 min in night mode, and at once on any escalation change. It carries
  battery, the night-mode flag and escalation status. **No location.**

---

## 3. Detection (Rust `safety-core`, runs entirely on the phone)

The engine uses no probability model and no machine-learned score. Signals open and clear explicit
**incidents**. Each incident has a tier, a family and a clearing rule. The parameters are in
`core/config/model-v1.toml`.

### Signals computed
- **Gait** (orientation-independent): the engine projects acceleration onto the gravity axis and the
  horizontal plane, then band-passes it at 0.5 to 3 Hz. Metrics: cadence, step-time variability, stride
  regularity, harmonic ratio, side-to-side sway, gyro wobble, jerk, rotation, peak g. The engine
  recomputes them every 1 s over a 6 s window.
- **Impact / fall**: free fall → hard peak → orientation change → low motion. A separate pattern detects
  "phone dropped alone": long free fall, lands flat, no body motion.
- **Grab**: phone in hand + jerk spike + sharp rotation. Running cadence or speed > 3 m/s confirms it.
- **Stumble**: one step interval far off rhythm with a sideways jolt, while walking continues.
- **Stillness / set down**, **placement** (pocket / hand / bag), **audio labels**, **location context**.

### Personal baselines
- The engine compares each live metric to the subject's own band: **mean ± 2.5 SD per placement**.
- The engine learns the bands opportunistically on ordinary walks (with consent) and from an onboarding
  baseline walk.
- The baseline becomes trusted after walking data on **7 distinct days**. It uses a rolling **14-day**
  window and excludes nights that produced incidents. Until then, the engine uses population priors with
  wider **3.5 SD** bands.
- The typing baseline comes from onboarding practice and check-ins (median/MAD + EWMA).
- The phone saves the baseline and the incident log as an opaque blob. AES-GCM encrypts the blob with an
  Android Keystore key, and the phone can read it after a reboot without an unlock. Autosave runs every
  5 min.

### Incident tiers
- **Context**: logged only.
- **Watch**: turns on full sensing and counts toward a check-in.
- **Danger**: asks "You okay?" on its own.

### Incident catalogue
| Incident | Tier | Opens when | Clears when |
|---|---|---|---|
| Phone drop | watch | long free fall, lands flat, dead still, not picked up within 60 s | picked up |
| High-g impact | watch | first reading above 2.5 g (opens at once) | reclassified ~2.4 s later as a fall, cleared as a drop / no-tilt hit |
| Possible fall | watch | impact > 2.5 g + orientation change + micro-motion after (or free fall + hard peak) | steps resume |
| Fall, recovered | context | steps resume after a possible fall | point event |
| Down after fall | danger | after a fall/hard impact: no steps and no touch for 15 s | steps resume |
| Hard impact | watch | hit with a tilt that was neither a fall nor a drop | walking resumes |
| Unsteady gait | watch | variability / regularity / sway / wobble out of band for 30 s of walking | 2 min of in-band walking |
| Slowed walk | watch | cadence > 20 % below baseline for 1 min of walking | 30 s at normal cadence |
| Stumble | context | single rhythm break + sideways jolt | point event, pruned after 30 min |
| Repeated stumbles | watch | 3 stumbles within 5 min | 10 min without one |
| Phone left behind | watch | set down 20 min while away late | picked up / touched |
| Grab | danger | in hand + jerk + rotation, then running away | owner unlocks the phone |
| Separated | watch | > 150 m from all friends for 10 min, not heading home | back with someone |
| Stopped on the way home | watch | distance home fell ≥ 200 m, then not moving 10 min, not home | moving again / home |
| In a vehicle | context | OS reports a vehicle | out of the vehicle |
| Battery critical | context | ≤ 10 % and not charging while away late (uploads a final location) | charging / ≥ 15 % |
| Check-in missed | danger | "You okay?" unanswered for 2 min | answered |
| Check-in typing off | watch | check-in typing far off the personal typing baseline (z > 2.5) | a normal check-in |
| Scream / shout | watch | ≥ 2 frames within 2 min of a fall or grab, venue not loud (median < 80 dB) | 10 min |
| Snoring while down | danger | snoring while down after a fall and a check-in was missed | answered / steps resume |

The server detects **phone offline** (§6). Entries in the on-device log expire after 8 h.

### When it asks "You okay?"
The phone asks when any of these is true:
1. A **danger** incident is not acknowledged.
2. A **possible fall, hard impact or scream** has been open for 5 s (`check_alone`). The delay lets the
   engine reclassify a dropped phone first.
3. Watch incidents from **two independent families** are active at once (fall · gait · phone · location ·
   check-in · audio). Two incidents from one family never ask.

An answer acknowledges everything active. After that, only a **new** incident can ask again (5 min
cooldown).

### Episodes and summaries
A check-in, grab or SOS starts an **episode**. Incidents from the last hour join it. Friends see one plain
sentence built from it, for example *"Unsteady walking, then a hard fall, then down for 2 min, then no
answer to a check-in."* That sentence is the only detail of the subject's signals that a friend ever sees.

### Config
- The backend serves a signed TOML (`config` function, currently `v3`). The engine deep-merges it over the
  bundled defaults, so a bad or old config can never brick the engine. A config that arrives during an
  escalation waits until the escalation is idle.
- The current config sets `auto_escalate = true`, so automatic check-in, heads-up and unlock are on.

---

## 4. Escalation (Rust state machine + Android UI)

Levels: `idle → check → heads_up → unlocked` (plus `snatch`, `resolved`).

| Step | Timing (production) | What happens |
|---|---|---|
| **1. Check** | trigger holds | A full-screen "You okay?" on the lock screen (`CheckInActivity`). It names what the engine detected and shows a countdown and a high-priority notification. The app tells nobody else. |
| **2. Heads-up** | 2 min, no answer, trigger still holds | The engine logs *check-in missed*. Friends get "Sam might not be okay" + the summary, **no location**. If the evidence cleared on its own (got up, rejoined the group), the episode resolves instead. |
| **3. Location unlock** | 4 min after the check, still holds | The phone seals the current and next **hour keys** to each friend and uploads a fresh encrypted fix. Friends' maps open. |
| **4. Call option** | 10 min after the check | Friends get a one-tap campus safety / 911 option with a prefilled card. |

### Answering the check-in
- **I'm OK** first makes the owner prove who they are. The owner unlocks the secure lock screen or passes
  a fingerprint / device-PIN prompt. A thief cannot pass it, and native code refuses a typed answer
  without it. The exception is a phone with no secure lock screen. There, the phone logs the answer as
  unverified.
- Only after this does the phone show a random **three-word phrase**. The subject types it in a native
  input that records per-key timing. A correct phrase in rhythm dismisses the check. If the typing is far
  off the subject's rhythm, friends see "answered, but may be impaired". A wrong phrase keeps the check
  open for another try.
- **I need help** works for anyone. It goes straight to location unlock and counts as consent.
- While friends are involved, the phone shows an ongoing "Your friends were told · Tap if you're OK"
  notification.

### Other ways into escalation
- **Grab / snatch**: skips the check. Friends get an immediate alert that the phone may have been
  snatched. The alert tells them not to chase, because the subject may be without a phone. In the current
  Android code, the snatch handler releases the hour keys and uploads a fix at once (the snatch-moment
  location). The engine's own unlock follows after 2 min unless the owner unlocks the phone. Only the
  owner's biometric can dismiss the snatch screen.
- **Manual SOS** (counts as consent, unlocks at once): the hold button in the app, the Android **Quick
  Settings tile** and the **home-screen widget**. To cancel, the subject must confirm with a biometric.
- **Battery dying**: at the battery-critical incident, the phone uploads a last encrypted location and
  opens a `battery_dying` incident.
- **Phone offline**: server watchdog, §6.

### Friends' actions (from the incident screen or the monitor's escalation dock)
- Ring the phone loudly (a synthesized 880 Hz alarm on the alarm stream at max volume).
- Call the person.
- Alert every friend.
- **Ask for the location now.** If an alert is in progress, the phone releases the location to the group
  and tells its owner who asked.
- "I'm going" (the other friends can see it).
- Mark found/safe. The phone gets the message and stops alerting.
- Call campus safety / 911 with copyable "what to tell them" text.

### Demo sensitivity (Settings)
This setting loads `model-demo.toml` over the production model. Impact triggers at 1.8 g. A grab needs a
yank + twist + 2 s of jogging. Unsteady gait opens after 10 s, and the check-in lasts 30 s. Drop-vs-fall
discrimination is off, a danger incident unlocks the location at once, and check-ins can repeat after
15 s. The setting includes an in-app "how to trigger" guide. Turn it off to restore the production model.

---

## 5. Privacy and cryptography (Rust `safety-crypto`, also compiled to WebAssembly)

### Identity and friends
- Each device has an **X25519** key (sealing) and an **Ed25519** key (signing). Both stay in the Android
  Keystore and are never uploaded.
- Friends add each other **in person by scanning a QR code** (user id + public keys + fingerprint). The
  person who adds confirms that the fingerprint matches the other screen. This stops the server from
  replacing the keys with its own. Both sides must accept the group invite.

### Keys
- Every day the phone generates a random **day key** `K_day`. Hour keys are `K_h = HKDF-SHA256(K_day, hour)`.
- The phone splits `K_day` with **Shamir secret sharing** (k-of-n over GF(256)). It **HPKE-seals** each
  share to one friend's key and **Ed25519-signs** it. Default k = 2. Each group can choose k = 2/3/4. With
  fewer than 2 friends, the phone makes no shares, fallback unlock is disabled and the UI says so.
- The phone zeroizes keys at day end and rotates them when group membership changes.

### Location encryption
- The phone encrypts each fix with **XChaCha20-Poly1305** under the current hour key, with authenticated
  data `user|epoch|seq`. The server keeps only the last **6 h** of ciphertext and has no way to decrypt
  it. A pgTAP test checks that no decrypt path exists in the database.

### Two ways to unlock
- **Normal unlock** (phone online): the subject's own phone seals the current and next hour keys to each
  friend. Friends can read at most a two-hour window, never the whole day.
- **Fallback unlock** (phone offline or battery dying): a friend opens a request. The server allows it
  only during an `offline` / `battery_dying` incident, and only in groups of ≥ 3 active members. Each
  approving friend's device re-seals its share to the requester. With k shares, the requester rebuilds
  `K_day` and decrypts the last known locations.
- **Every unlock goes into an audit trail** that the subject and the whole group can see.

### Together / separated
- Every 2 min, each phone uploads `HMAC(group_key, geohash7)` tokens for its cell and 8 neighbors (~150 m).
- The `proximity` function compares members' tokens and writes back only `together` / `separated`. The
  server never sees coordinates.

### What leaves the phone
| Data | Who can read it |
|---|---|
| Encrypted location | Nobody until an unlock, then the group |
| Night mode, battery, escalation status | Group + server |
| Together/separated | Group (server sees only yes/no) |
| That an incident happened + one-line summary | Group + server |
| Live telemetry (motion magnitudes, metrics, incidents, engine events, **no location**) | Subject + group, over a private channel |
| Every unlock | Subject + whole group |

Home places, baselines, private keys and audio never leave the phone.

---

## 6. Backend (Supabase)

### Tables (RLS on all of them)
`profiles`, `devices`, `groups`, `group_members`, `epochs`, `key_shares`, `location_blobs`,
`proximity_tokens`, `presence`, `incidents`, `incident_events`, `released_keys`, `unlock_requests`,
`unlock_approvals`, `audit_log`, `model_configs`. A `device_status` view lets group-mates see coarse
device state, never push tokens.

Access rules in short:
- Members read their group.
- The subject writes their own rows.
- No user can read proximity tokens.
- Only `open_unlock_request()` can create unlock requests.
- Only database triggers write audit rows.

### Database functions (RPCs and triggers)
`heartbeat`, `open_incident`, `resolve_incident`, `add_incident_event`, `accept_invite`,
`open_unlock_request`, `purge_old_data`, `watchdog_tick` / `cron_watchdog`, `call_edge_function`,
`handle_new_user`, membership helpers, and audit triggers on released keys, unlock requests/approvals and
friend actions.

### Edge functions (Deno)
| Function | What it does |
|---|---|
| `push` | Fan-out to group members directly via **APNs** and **FCM v1** (critical / time-sensitive fields, no location in payloads) |
| `watchdog` | Runs every minute (pg_cron). Opens an **offline** incident when night-mode heartbeats stop for 10 min, and **battery_dying** at ≤ 3 %. Pushes "Sam's phone went offline at 1:42am" |
| `proximity` | Compares proximity tokens, writes together/separated |
| `unlock` | Gates and reports fallback unlock (level check, ≥ 3 members, approval count vs threshold) |
| `purge` | Retention: location blobs > 6 h, old proximity tokens, released keys |
| `config` | Serves the signed model TOML with ETag caching |

### Realtime
- Friends' screens subscribe to incidents, events, released keys, location blobs, presence and unlock
  requests/approvals.
- Private broadcast channel `telemetry:{uid}`: the subject publishes, and only group-mates may subscribe.
- Private command channel `telemetry-cmd:{uid}`: group-mates send `reset_incidents`,
  `friend_marked_safe`, `release_location`. Only the subject's phone subscribes. It checks the incident
  row before it acts.

### Auth
Supabase Auth: phone **SMS OTP**, **Google** sign-in (Apple on iOS builds), and an anonymous / offline
**demo** sign-in. The Android service keeps the JWT alive itself (`SessionKeeper`, refresh 5 min before
expiry). Uploads and telemetry thus survive a sleeping JS runtime, a backgrounded app and reboots.

---

## 7. App screens (Expo Router)

### Subject / everyone
| Screen | What it does |
|---|---|
| Sign-in | Phone OTP, Google, demo |
| Onboarding: welcome | Four-point explanation of how it works |
| Onboarding: permissions | Location "Always", motion, mic (optional), notifications, unrestricted battery, each with a plain reason. Link to dontkillmyapp.com |
| Onboarding: home places | Map tap or "use current location", 150 m radius, stored on device only |
| Onboarding: baseline walk | Timed walk to seed the gait baseline (skippable) |
| Onboarding: typing practice | Three rounds of the three-word phrase to seed the typing baseline |
| Home | The radar: you in the middle, and every friend placed by bearing and distance. The scale is logarithmic, with 100 m, 1 km and 10 km rings. It turns with the compass on the phone and is north-up on the web. Marks are colored by concern. One sentence under the radar shows your own alert, the friend who needs you most, or "All quiet.". **Hold for help**: a 2 s hold sends an SOS. The button is solid red once sent. Tap it and confirm with a fingerprint to stand down. **I'm okay**: answers an open check-in or stands an SOS down. With nothing going on, it tells friends you are fine through an `okay` event on your telemetry channel, and they see it for 30 min. The lock line says whether your location is sealed or open. The top-right button opens the Friends sidebar |
| Friends (sidebar + screen) | You, then friends who are out (worst first), then friends at home. Each row has a dot, a name, one line (what is up, distance and direction) and a call button. Links to groups, history, settings |
| Friend | A friend's page: the radar focused on them, a headline sentence, tonight's timeline, Call / Campus safety / Go to (opens the maps app) |
| Check-in | Opens the native lock-screen check-in (JS fallback where none exists) |
| Snatch | "Don't chase" alert, biometric-only "I have my phone" |
| Groups | Your QR + fingerprint, create groups, scan to invite, accept/leave, threshold k, campus safety number |
| Scan | Camera QR scanner with fingerprint confirmation |
| History | Past incidents and the audit log of everything that touched your location or keys |
| Settings | Emergency phone number, sound detection, walk learning, evening window, night mode, personal dashboard, live telemetry (with link status / round trip), demo sensitivity, debug trace injection, sign out |
| Personal dashboard | Live metrics vs your bands, sensing / mic status, the on-device incident log. Only you see it |

### Friend side
| Screen | What it does |
|---|---|
| Incident | What triggered it, map once unlocked (OpenStreetMap on web), Ring / Call / I'm going / Found, Get location now, fallback-unlock request with approval progress, escalate card with dispatcher text, live timeline |
| Approve unlock | Gives your sealed share to the requesting friend |
| **Monitor** (web) | See §8 |

### Debug-only
`safe://debug/inject?trace=<name>` replays bundled traces through the real native → Rust pipeline.
`safe://debug/friend-view` renders the friend view on the same device. Release builds include neither one.

---

## 8. Web monitor (`/monitor`, friends in a browser)

- **Real-time telemetry console**: ten frames a second over one persistent Realtime WebSocket, with no
  database writes. It draws scrolling 50 Hz accelerometer and gyroscope waveforms on the phone's own
  sensor clock, so network jitter does not distort them. It also shows metric tiles with band flashes and
  sparklines, a five-minute mic-listening strip and the live incident log. Below these are an engine event
  ticker, a check-in countdown banner and the phone's measured server round trip. Location is never part
  of it.
- **Escalation dock** (bottom right): it appears while the subject has an open heads-up / unlocked /
  snatch / SOS / offline / battery-dying incident. It shows the elapsed time. When the incident is overdue
  (10 min), the dock turns red, beeps and opens itself. It has all friend actions, and an inline map once
  keys arrive. A red record in the live log opens it at once, before the database row lands.
- **Delete all** button: deletes the subject's incidents for good. It removes the server rows (with their events,
  unlock requests and released keys), wipes the on-device log, resets sensing and drops the AI read. Any group
  member can use it. Only the subject's own delete also removes their audit-log rows.
- **AI read of the incident log** (right column, advisory only):
  - The monitor first turns the log into a structured timeline: kinds, tiers, families, times, gaps,
    durations, bursts, overlaps, a 15-minute trend, and matched ordered **chains**. The chains are
    impact → scream within 2 min, fall → down → missed check-in → snoring, impaired → separated → vehicle,
    and grab → moving away. Reassuring chains, like a recovered fall or a lone drop, are also matched. The
    timeline also shows which step would come next. No measurements, location or audio go in.
  - The friend's browser sends it to **Claude** (default `claude-haiku-5-5`, structured outputs) when
    `EXPO_PUBLIC_ANTHROPIC_API_KEY` is set. Otherwise, or on failure, it goes to a free **OpenRouter**
    model (default `nvidia/nemotron-3.5-lightning:free`, with fallbacks).
  - The result has a risk level and a 0 to 100 score (low / elevated / high / critical), a trajectory and
    a confidence. It also lists factors up and down, how incidents chain, the innocent explanation, what
    would change the read, and short pop-up reminders. The engine's own escalation sets a floor: heads-up
    ⇒ at least high, unlocked / snatch ⇒ critical.
  - The monitor asks again only when the picture changes. It debounces the request and asks at most every
    45 s unless escalation rises. It caches the last read per person.
  - Both keys end up in the web bundle by design. Use a low spend limit or a free-tier key.

---

## 9. Tooling, tests and CI

| Tool | What it does |
|---|---|
| `sim` (Rust CLI) | `sim replay [--lowrate] <file\|dir>`, `sim synth --scenario walk\|drunk\|fall\|drop\|still\|dance\|snatch --minutes N --out f.json`, `sim batch <dir>`. Replays traces through the full engine and gates CI on false alarms and detection delay |
| `core/traces/` | Bundled traces: dance, drop, drunk, fall, snatch, still |
| `tools/collect` | Export + label CLIs for a consented data-collection study (protocol, scenarios and consent text in its README). No study data yet |
| `e2e/` | Five Maestro flows: check-in dismiss, heads-up, unlock with map, snatch, manual SOS |
| `core/build-mobile.sh` | cargo-ndk build of the Rust `.so` + Kotlin bindings |
| `safety-wasm` | wasm-bindgen build of the crypto for the browser |

The tree has 68 Rust tests in `safety-core`. They cover golden stories, every incident's open/clear rule,
the check-in trigger, grab timing, the listening window, episodes, baselines and config compatibility.
There are 19 crypto tests (Shamir k-of-n, HPKE tamper cases, AEAD vectors, zeroization, proximity). There
are also 25 Deno edge-function tests, a 40-assertion pgTAP RLS suite, and TypeScript chain tests for the
monitor timeline.

CI (`.github/workflows/ci.yml`): `rust`, `sim-gate`, `functions`, `mobile` (typecheck/lint), `android-bindings`.
`eas.yml` builds binaries on demand.

---

## 10. Known gaps and accepted risks

- **Server + one friend colluding** could brute-force proximity cells (~150 m) during night mode.
  Accepted for v1. Planned fix: pairwise keys / PSI.
- **k colluding friends** can unlock during a real offline incident. That is the feature. The audit log
  deters it but does not prevent it.
- **Coarse status** (when you are out, alert levels): the group and the server can see it.
- **Any group member can wipe the subject's incident log** from the monitor. This does not stop new
  detection.
- The snatch alert includes the snatch-moment location by design.
- Open items:
  - external crypto review
  - on-device verification of the model-config signature (the field exists, verification is TODO)
  - replay binding of released keys to an incident
  - rate limits on unlock requests
  - Play Store background-location / foreground-service declarations
  - accessibility
  - beta
- The Settings switch "Learn my walking on normal days" only changes screen state. It is not wired to
  native code yet. Turning "Sound detection" off does not revoke the mic. The switch only asks for
  permission when the user turns it on.
- Push delivery via APNs/FCM has unit tests but no check with live credentials. Nobody has run the
  6-hour battery / locked-phone field test or the data-collection study yet.
