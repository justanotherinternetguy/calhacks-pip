# pip (repo: safe) — everything the software does

A complete feature inventory, checked against the code on 2026-10-24 (commit `6cc9b4c`).
Design rationale lives in [PLAN.md](../PLAN.md); exact interfaces in [CONTRACTS.md](CONTRACTS.md).

---

## 1. What it is

**safe** is a passive night-out safety system for a group of friends. The person being protected (the
*subject*) carries an Android phone and does nothing special. The phone watches how they move, notices
when they may not be able to ask for help (unsteady walking, a hard fall followed by no movement, a
scream, a snatched phone), **asks them first** ("You okay?"), and tells their friends only if they
don't answer. Location stays end-to-end encrypted until then, and no single party — not one friend, not
the server operator — can decrypt it alone. Friends decide what to do; **the app never calls police or
anyone else on its own.**

It is three pieces:

| Piece | Tech | Role |
|---|---|---|
| Android app | Expo / React Native UI + Kotlin foreground service + Rust core (uniffi) | Sensing, detection, escalation, encryption, uploads |
| Backend | Supabase: Postgres + row-level security, Realtime, Deno edge functions, pg_cron | Stores only ciphertext, proximity tokens and coarse status; push fan-out; watchdog |
| Web monitor | The same Expo code built for the browser, Rust crypto compiled to WebAssembly | The friends' side: live telemetry, incident screens, decrypting released locations |

iOS was dropped (the Swift module was removed); the platform is Android plus the web monitor.

> Not an emergency service. Detection is heuristic and can miss events or raise false alarms. 18+ only.

---

## 2. Subject's phone: sensing (Kotlin, `modules/safety-native/android`)

### Always-on foreground service
- `SensingService` is a persistent Android foreground service that keeps running with the screen off,
  unplugged, and across reboots (`BootReceiver`, `START_STICKY`).
- After a reboot Android won't let it reopen the microphone from the background, so it restarts without
  mic access and posts a **"tap to re-arm"** notification.
- Before location permission is granted it runs as a `specialUse` service, then upgrades.

### Night mode
- The subject saves **home places** once (stored only on the phone, never uploaded).
- Night mode starts **automatically** when they are away from home inside their **evening window**
  (default 20:00–06:00, editable) and ends when they get home or the window ends.
- Manual modes: `auto`, `on`, `off`, `paused_tonight` (home screen + Settings).
- Going home (night mode off) clears every active incident.
- Driven by geofence and activity-recognition receivers plus a 1 s night tick / 60 s day tick.

### Two sampling modes (decided by the Rust engine, executed by native)
| Mode | Sensors | When |
|---|---|---|
| **Low** (default) | ~10 Hz accelerometer + gravity, no gyro, batched 1 s | All day while the service runs |
| **Full** | 50 Hz accelerometer + gravity + gyroscope | Away from home 21:00–06:00; while any watch/danger incident is active; 30 min after any incident; during a baseline walk; while learning a daytime walk; while the personal dashboard or telemetry stream is open |

While streaming, sensor batching is off (every sample as it happens) and a partial wake lock keeps the CPU awake.

### Other inputs fed to the engine
- OS activity (still / walking / running / vehicle), GPS speed.
- Screen on/off and owner unlock events; **time since last touch** (in-app touches, `USER_PRESENT`,
  keyguard transitions — no accessibility service is used).
- Battery level and charging.
- Distance to the nearest home place (computed on the phone).
- Together/separated status from the server.

### Microphone: listening windows only
- Mic is **off by default, also at night.** The engine opens a listening window (night mode only) after a
  phone drop, possible fall, down after fall, hard impact, grab, missed check-in, unsteady gait or repeated
  stumbles, and while an escalation runs. It closes 10 min after the newest such incident.
- Inside a window, ~0.975 s frames of 16 kHz audio are classified on-device by **YAMNet** (TFLite, bundled)
  into three scores — **scream, shout, snoring** — plus a sound level in dB SPL.
- Only those numbers reach the engine. PCM lives in one buffer, is classified, zeroed and dropped. Nothing
  is recorded, stored or uploaded.

### Location
- In night mode the phone uploads an **encrypted** location every 5 min, every 60 s once friends have
  been alerted.
- Coordinates never appear in telemetry, heartbeats or push payloads.

### Heartbeat
- Every 2 min in night mode (and immediately on any escalation change): battery, night-mode flag,
  escalation status. **No location.**

---

## 3. Detection (Rust `safety-core`, runs entirely on the phone)

No probability model and no machine-learned score. Signals open and clear explicit **incidents**, each
with a tier, a family and a clearing rule. Parameters are in `core/config/model-v1.toml`.

### Signals computed
- **Gait** (orientation-independent: acceleration projected onto the gravity axis and horizontal plane,
  band-passed 0.5–3 Hz): cadence, step-time variability, stride regularity, harmonic ratio, side-to-side
  sway, gyro wobble, jerk, rotation, peak g. Recomputed every 1 s over a 6 s window.
- **Impact / fall**: free fall → hard peak → orientation change → low motion; separate "phone dropped
  alone" pattern (long free fall, lands flat, no body motion).
- **Grab**: phone in hand + jerk spike + sharp rotation, confirmed by running cadence or speed > 3 m/s.
- **Stumble**: one step interval far off rhythm with a sideways jolt while walking continues.
- **Stillness / set down**, **placement** (pocket / hand / bag), **audio labels**, **location context**.

### Personal baselines
- Each live metric is compared to the subject's own band: **mean ± 2.5 SD per placement**.
- Learned opportunistically on ordinary walks (with consent) and from an onboarding baseline walk.
- Trusted after walking data on **7 distinct days**; rolling **14-day** window; nights that produced
  incidents are excluded. Until trusted, population priors with wider **3.5 SD** bands.
- Typing baseline from onboarding practice and check-ins (median/MAD + EWMA).
- Baseline + incident log are saved as an opaque blob, AES-GCM encrypted with an Android Keystore key,
  readable after reboot without unlocking. Autosaved every 5 min.

### Incident tiers
- **Context** — logged only.
- **Watch** — turns on full sensing and counts toward a check-in.
- **Danger** — asks "You okay?" on its own.

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
| Stumble | context | single rhythm break + sideways jolt | point event; pruned after 30 min |
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

**Phone offline** is detected server-side (§6). Entries in the on-device log expire after 8 h.

### When it asks "You okay?"
Any of:
1. An unacknowledged **danger** incident.
2. A **possible fall, hard impact or scream** that has been open for 5 s (`check_alone`; the delay lets a
   dropped phone be reclassified first).
3. Watch incidents from **two independent families** at once (fall · gait · phone · location · check-in ·
   audio). Two incidents from one family never ask.

Answering acknowledges everything active; only a **new** incident can ask again (5 min cooldown).

### Episodes and summaries
A check-in, grab or SOS starts an **episode**: incidents from the last hour join it, and friends see one
plain sentence built from it, e.g. *"Unsteady walking, then a hard fall, then down for 2 min, then no
answer to a check-in."* That sentence is the only detail of the subject's signals a friend ever sees.

### Config
- Signed TOML served by the backend (`config` function, currently `v3`), deep-merged over the bundled
  defaults so a bad or old config can never brick the engine. A config arriving mid-escalation waits
  until the escalation is idle.
- `auto_escalate = true` in the current config (automatic check-in / heads-up / unlock is on).

---

## 4. Escalation (Rust state machine + Android UI)

Levels: `idle → check → heads_up → unlocked` (plus `snatch`, `resolved`).

| Step | Timing (production) | What happens |
|---|---|---|
| **1. Check** | trigger holds | Full-screen lock-screen "You okay?" (`CheckInActivity`) naming what was detected, with a countdown and a high-priority notification. Nobody else is told. |
| **2. Heads-up** | 2 min, no answer, trigger still holds | Logged as *check-in missed*. Friends get "Sam might not be okay" + the summary, **no location**. If the evidence cleared on its own (got up, rejoined the group), the episode resolves instead. |
| **3. Location unlock** | 4 min after the check, still holds | Phone seals the current and next **hour keys** to each friend and uploads a fresh encrypted fix; friends' maps open. |
| **4. Call option** | 10 min after the check | Friends get a one-tap campus safety / 911 option with a prefilled card. |

### Answering the check-in
- **I'm OK** first proves the owner: unlocking the secure lock screen, or a fingerprint / device-PIN prompt.
  A thief can't pass it, and native refuses a typed answer without it (except on phones with no secure lock
  screen, where the answer is logged as unverified).
- Only then is a random **three-word phrase** shown, typed in a native input that records per-key timing.
  Correct and in rhythm → dismissed. Far off the subject's typing rhythm → friends are told "answered, but
  may be impaired". Wrong phrase → the check stays open for another try.
- **I need help** works for anyone and skips straight to location unlock (counts as consent).
- While friends are involved the phone shows an ongoing "Your friends were told · Tap if you're OK" notification.

### Other ways into escalation
- **Grab / snatch**: skips the check. Friends get an immediate "phone may have been snatched — don't
  chase, they may be without a phone" alert. In the current Android code the snatch handler releases the
  hour keys and uploads a fix right away (the snatch-moment location); the engine's own unlock follows
  after 2 min unless the owner unlocks the phone. Only the owner's biometric can dismiss the snatch screen.
- **Manual SOS** (counts as consent, unlocks immediately): hold button in the app, Android **Quick
  Settings tile**, and **home-screen widget**. Cancelling requires biometric confirmation.
- **Battery dying**: at the battery-critical incident the phone uploads a last encrypted location and
  opens a `battery_dying` incident.
- **Phone offline**: server watchdog, §6.

### Friends' actions (from the incident screen or the monitor's escalation dock)
Ring the phone loudly (synthesized 880 Hz alarm on the alarm stream at max volume) · call the person ·
alert every friend · **ask for the location now** (the phone releases it to the group if an alert is in
progress and tells its owner who asked) · "I'm going" (visible to the other friends) · mark found/safe
(the phone is told and stops alerting) · call campus safety / 911 with copyable "what to tell them" text.

### Demo sensitivity (Settings)
Loads `model-demo.toml` over production: impact at 1.8 g, grab after a yank + twist + 2 s of jogging,
unsteady gait after 10 s, 30 s check-in, drop-vs-fall discrimination disabled, a danger incident unlocks
the location immediately, back-to-back check-ins after 15 s. Includes an in-app "how to trigger" guide.
Turning it off restores the production model.

---

## 5. Privacy and cryptography (Rust `safety-crypto`, also compiled to WebAssembly)

### Identity and friends
- Each device has an **X25519** key (sealing) and an **Ed25519** key (signing), kept in the Android
  Keystore and never uploaded.
- Friends are added **in person by scanning a QR code** (user id + public keys + fingerprint). The adder
  confirms the fingerprint matches the other screen, so the server can't swap in its own keys. Both sides
  must accept the group invite.

### Keys
- Every day the phone generates a random **day key** `K_day`; hour keys are `K_h = HKDF-SHA256(K_day, hour)`.
- `K_day` is split with **Shamir secret sharing** (k-of-n over GF(256)); each share is **HPKE-sealed** to
  one friend's key and **Ed25519-signed**. Default k = 2; options k = 2/3/4 per group. Fewer than 2 friends
  → no shares, fallback unlock disabled and the UI says so.
- Keys are zeroized at day end and rotated when group membership changes.

### Location encryption
- Each fix is encrypted with **XChaCha20-Poly1305** under the current hour key, authenticated data
  `user|epoch|seq`. The server keeps only the last **6 h** of ciphertext and has no way to decrypt it
  (pgTAP checks that no decrypt path exists in the database).

### Two ways to unlock
- **Normal unlock** (phone online): the subject's own phone seals the current and next hour keys to each
  friend. Friends can read at most a two-hour window, never the whole day.
- **Fallback unlock** (phone offline or battery dying): a friend opens a request; the server allows it only
  during an `offline` / `battery_dying` incident and only in groups of ≥ 3 active members. Each approving
  friend's device re-seals its share to the requester; with k shares the requester rebuilds `K_day` and
  decrypts the last known locations.
- **Every unlock is logged** in an audit trail visible to the subject and the whole group.

### Together / separated
- Every 2 min each phone uploads `HMAC(group_key, geohash7)` tokens for its cell and 8 neighbours (~150 m).
- The `proximity` function compares members' tokens and writes back only `together` / `separated`. The
  server never sees coordinates.

### What leaves the phone
| Data | Who can read it |
|---|---|
| Encrypted location | Nobody until an unlock; then the group |
| Night mode, battery, escalation status | Group + server |
| Together/separated | Group (server sees only yes/no) |
| That an incident happened + one-line summary | Group + server |
| Live telemetry (motion magnitudes, metrics, incidents, engine events — **no location**) | Subject + group, over a private channel |
| Every unlock | Subject + whole group |

Home places, baselines, private keys and audio never leave the phone.

---

## 6. Backend (Supabase)

### Tables (RLS on all of them)
`profiles`, `devices`, `groups`, `group_members`, `epochs`, `key_shares`, `location_blobs`,
`proximity_tokens`, `presence`, `incidents`, `incident_events`, `released_keys`, `unlock_requests`,
`unlock_approvals`, `audit_log`, `model_configs`, plus a `device_status` view (group-mates see coarse
device state, never push tokens).

Access rules in short: members read their group; the subject writes their own rows; proximity tokens are
unreadable by any user; unlock requests can only be created by `open_unlock_request()`; audit rows are
written only by database triggers.

### Database functions (RPCs and triggers)
`heartbeat`, `open_incident`, `resolve_incident`, `add_incident_event`, `accept_invite`,
`open_unlock_request`, `purge_old_data`, `watchdog_tick` / `cron_watchdog`, `call_edge_function`,
`handle_new_user`, membership helpers, and audit triggers on released keys, unlock requests/approvals and
friend actions.

### Edge functions (Deno)
| Function | What it does |
|---|---|
| `push` | Fan-out to group members directly via **APNs** and **FCM v1** (critical / time-sensitive fields; no location in payloads) |
| `watchdog` | Every minute (pg_cron): opens an **offline** incident when night-mode heartbeats stop for 10 min, and **battery_dying** at ≤ 3 %; pushes "Sam's phone went offline at 1:42am" |
| `proximity` | Compares proximity tokens, writes together/separated |
| `unlock` | Gates and reports fallback unlock (level check, ≥ 3 members, approval count vs threshold) |
| `purge` | Retention: location blobs > 6 h, old proximity tokens, released keys |
| `config` | Serves the signed model TOML with ETag caching |

### Realtime
- Friends' screens subscribe to incidents, events, released keys, location blobs, presence and unlock
  requests/approvals.
- Private broadcast channel `telemetry:{uid}` — the subject publishes, only group-mates may subscribe.
- Private command channel `telemetry-cmd:{uid}` — group-mates send `reset_incidents`,
  `friend_marked_safe`, `release_location`; only the subject's phone subscribes, and it checks the
  incident row before acting.

### Auth
Supabase Auth: phone **SMS OTP**, **Google** sign-in (Apple on iOS builds), and an anonymous / offline
**demo** sign-in. The Android service keeps the JWT alive itself (`SessionKeeper`, refresh 5 min before
expiry) so uploads and telemetry survive a sleeping JS runtime, a backgrounded app and reboots.

---

## 7. App screens (Expo Router)

### Subject / everyone
| Screen | What it does |
|---|---|
| Sign-in | Phone OTP, Google, demo |
| Onboarding — welcome | Four-point explanation of how it works |
| Onboarding — permissions | Location "Always", motion, mic (optional), notifications, unrestricted battery, each with a plain reason; link to dontkillmyapp.com |
| Onboarding — home places | Map tap or "use current location", 150 m radius, stored on device only |
| Onboarding — baseline walk | Timed walk to seed the gait baseline (skippable) |
| Onboarding — typing practice | Three rounds of the three-word phrase to seed the typing baseline |
| Home | The radar: you in the middle, every friend placed by bearing and distance (log scale: 100 m, 1 km, 10 km rings; turns with the compass on the phone, north-up on the web), marks coloured by concern. One sentence under it (your own alert, the friend who needs you most, or "All quiet."). **Hold for help** (2 s hold → SOS; solid red once sent, tap + fingerprint to stand down) and **I'm okay** (answers an open check-in, stands an SOS down, or, with nothing going on, tells friends you're fine via an `okay` event on your telemetry channel, shown to them for 30 min). Lock line says whether your location is sealed or open. Friends sidebar from the top-right button |
| Friends (sidebar + screen) | You, then friends out (worst first), then home; dot + name + one line (what's up, distance and direction); call button; links to groups, history, settings |
| Friend | A friend's page: the radar focused on them, headline sentence, tonight's timeline, Call / Campus safety / Go to (hands off to the maps app) |
| Check-in | Opens the native lock-screen check-in (JS fallback where none exists) |
| Snatch | "Don't chase" alert, biometric-only "I have my phone" |
| Groups | Your QR + fingerprint, create groups, scan to invite, accept/leave, threshold k, campus safety number |
| Scan | Camera QR scanner with fingerprint confirmation |
| History | Past incidents and the audit log of everything that touched your location or keys |
| Settings | Emergency phone number, sound detection, walk learning, evening window, night mode, personal dashboard, live telemetry (with link status / round trip), demo sensitivity, debug trace injection, sign out |
| Personal dashboard | Live metrics vs your bands, sensing / mic status, the on-device incident log; only you see it |

### Friend side
| Screen | What it does |
|---|---|
| Incident | What triggered it, map once unlocked (OpenStreetMap on web), Ring / Call / I'm going / Found, Get location now, fallback-unlock request with approval progress, escalate card with dispatcher text, live timeline |
| Approve unlock | Hand over your sealed share to the requesting friend |
| **Monitor** (web) | See §8 |

### Debug-only
`safe://debug/inject?trace=<name>` replays bundled traces through the real native → Rust pipeline;
`safe://debug/friend-view` renders the friend view on the same device. Both are compiled out of release builds.

---

## 8. Web monitor (`/monitor`, friends in a browser)

- **Real-time telemetry console**, ten frames a second over one persistent Realtime WebSocket (no database
  writes): scrolling 50 Hz accelerometer and gyroscope waveforms drawn on the phone's own sensor clock (so
  network jitter doesn't distort them), metric tiles with band flashes and sparklines, a five-minute
  mic-listening strip, the live incident log, an engine event ticker, a check-in countdown banner, and the
  phone's measured server round trip. Location is never part of it.
- **Escalation dock** (bottom right) while the subject has an open heads-up / unlocked / snatch / SOS /
  offline / battery-dying incident: elapsed time, turns red with a beep and opens itself when overdue
  (10 min); all friend actions, inline map once keys arrive. Opens instantly on a red record in the live
  log, before the database row lands.
- **Clear incidents** button: wipes the subject's on-device log and resets sensing (any group member can).
- **AI read of the incident log** (right column, advisory only):
  - The log is first turned into a structured timeline: kinds, tiers, families, times, gaps, durations,
    bursts, overlaps, a 15-minute trend, and matched ordered **chains** (impact → scream within 2 min;
    fall → down → missed check-in → snoring; impaired → separated → vehicle; grab → moving away; and
    reassuring ones like a recovered fall or a lone drop), including which step would come next.
    No measurements, location or audio go in.
  - Sent from the friend's browser to **Claude** (default `claude-haiku-5-5`, structured outputs) when
    `EXPO_PUBLIC_ANTHROPIC_API_KEY` is set, otherwise or on failure to a free **OpenRouter** model
    (default `nvidia/nemotron-3.5-lightning:free`, with fallbacks).
  - Returns a risk level and 0–100 score (low / elevated / high / critical), trajectory, confidence,
    factors up and down, how incidents chain, the innocent explanation, what would change the read, and
    short pop-up reminders. The engine's own escalation sets a floor (heads-up ⇒ at least high; unlocked /
    snatch ⇒ critical).
  - Re-asked only when the picture changes, debounced, at most every 45 s unless escalation rises; last
    read cached per person.
  - Both keys end up in the web bundle by design: use a low spend limit / free-tier key.

---

## 9. Tooling, tests and CI

| Tool | What it does |
|---|---|
| `sim` (Rust CLI) | `sim replay [--lowrate] <file\|dir>`, `sim synth --scenario walk\|drunk\|fall\|drop\|still\|dance\|snatch --minutes N --out f.json`, `sim batch <dir>` — replays traces through the full engine and gates CI on false alarms and detection delay |
| `core/traces/` | Bundled traces: dance, drop, drunk, fall, snatch, still |
| `tools/collect` | Export + label CLIs for a consented data-collection study (protocol, scenarios and consent text in its README); no study data yet |
| `e2e/` | Five Maestro flows: check-in dismiss, heads-up, unlock with map, snatch, manual SOS |
| `core/build-mobile.sh` | cargo-ndk build of the Rust `.so` + Kotlin bindings |
| `safety-wasm` | wasm-bindgen build of the crypto for the browser |

Test counts in the tree: 68 Rust tests in `safety-core` (golden stories, every incident's open/clear rule,
check-in trigger, grab timing, listening window, episodes, baselines, config compatibility), 19 crypto
tests (Shamir k-of-n, HPKE tamper cases, AEAD vectors, zeroization, proximity), 25 Deno edge-function
tests, a 40-assertion pgTAP RLS suite, and TypeScript chain tests for the monitor timeline.

CI (`.github/workflows/ci.yml`): `rust`, `sim-gate`, `functions`, `mobile` (typecheck/lint), `android-bindings`.
`eas.yml` builds binaries on demand.

---

## 10. Known gaps and accepted risks

- **Server + one friend colluding** could brute-force proximity cells (~150 m) during night mode. Accepted
  for v1; pairwise keys / PSI planned.
- **k colluding friends** can unlock during a real offline incident — that is the feature; deterred by the
  audit log, not prevented.
- **Coarse status** (when you're out, alert levels) is visible to the group and the server.
- **Any group member can wipe the subject's incident log** from the monitor (does not stop new detection).
- Snatch alert includes the snatch-moment location by design.
- Open items: external crypto review; on-device verification of the model-config signature (field
  exists, verification is TODO); replay binding of released keys to an incident; rate-limiting unlock
  requests; Play Store background-location / foreground-service declarations; accessibility; beta.
- Settings' "Learn my walking on normal days" switch only changes screen state (it isn't wired to native
  yet), and turning "Sound detection" off doesn't revoke the mic; it only asks for permission when turned on.
- Push delivery via APNs/FCM is unit-tested but not verified with live credentials; a 6-hour battery /
  locked-phone field test and the data-collection study haven't been done yet.
