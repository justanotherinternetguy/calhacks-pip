# pip: feature summary

pip (repo: `safe`) is a night-out safety app for a group of friends. One person carries an Android phone that
watches how they move. When something looks wrong (a hard fall, unsteady walking, a snatched phone), the phone
asks them first: "You okay?". Their friends hear about it only if they don't answer. Until then their location
stays end-to-end encrypted, and no single friend or the server can read it. The app never calls the police or
anyone else by itself.

This page summarizes everything the software does as of 2026-10-25. [FEATURES.md](FEATURES.md) has the long
version and [CONTRACTS.md](CONTRACTS.md) the exact interfaces.

> Not an emergency service. Detection is heuristic: it can miss events and raise false alarms. 18+ only.

| Part | Built with | Job |
|---|---|---|
| Android app | Expo / React Native UI, Kotlin foreground service, Rust engine (uniffi) | Sensing, detection, check-ins, alerts, encryption |
| Backend | Supabase: Postgres with row-level security, Realtime, Deno edge functions, pg_cron | Stores only ciphertext and coarse status, sends pushes, watches for phones going offline |
| Web monitor | The same Expo code in a browser, Rust crypto as WebAssembly | The friends' console: live sensor view, incidents, AI read, location once unlocked |

---

## 1. On the phone: sensing

- **Always on.** A foreground service runs with the screen off, off the charger and after a reboot. After a
  reboot Android blocks the microphone until the app is opened once, so the phone posts a "tap to re-arm" note.
- **Night mode** starts by itself when you are away from your saved home places during your evening window
  (default 20:00 to 06:00), and ends when you get home. You can also set it to on, off or "paused tonight".
  Home places never leave the phone.
- **Two sensor speeds.** Low (10 samples a second, no gyroscope) most of the time. Full (50 a second plus
  gyroscope) late at night away from home, while anything is being watched, for 30 min after any incident,
  during a baseline walk, and while the phone streams to the monitor.
- **Other inputs:** the phone's own activity guess (still, walking, running, in a vehicle), speed, screen and
  unlock events, time since you last touched the phone, battery, distance to home, and whether you are with
  your friends.
- **Microphone only in short windows.** Off by default. After a fall, a grab, a missed check-in or unsteady
  walking it listens for 10 min, and an on-device model (YAMNet) scores each second for scream, shout and
  snoring plus a loudness level. Only those numbers are kept; the audio is never stored or uploaded.
- **Location** is uploaded encrypted every 5 min in night mode, every 60 s once friends are alerted. It never
  appears in heartbeats, pushes or the live stream.
- **Heartbeat** every 2 min at night (battery, night mode, alert level, no location).

## 2. Detection (Rust engine, entirely on the phone)

There is no machine-learned danger score. Clear rules open and close **incidents**, each with a tier:

- **Context**: logged only.
- **Watch**: turns on full sensing and counts toward a check-in.
- **Danger**: asks "You okay?" on its own.

| Incident | Tier | In short |
|---|---|---|
| High-g impact | watch | First reading above 3 g, shown at once. In the middle of a walk the bump is held 10 s and dropped if you keep walking (a pocket sees one every few steps) |
| Possible fall | watch | Impact above 3 g, a tilt, then little movement (or a free fall and a hard landing) |
| Fall recovered | context | Walking again after a fall |
| Down after fall | danger | No steps and no touch for 15 s after a fall |
| Hard impact | watch | A hit with a tilt that was neither a fall nor a dropped phone |
| Phone drop | watch | Long free fall, lands flat, not picked up within 60 s |
| Unsteady walking | watch | Regularity, sway or wobble outside your normal range for 35 s of walking |
| Slowed walking | watch | Pace 20 % below your normal for a minute |
| Stumble / repeated stumbles | context / watch | A broken step with a sideways jolt; three in 5 min |
| Grab | danger | Phone in hand, a yank with a twist, then running away |
| Separated | watch | Over 150 m from every friend for 10 min, not heading home |
| Stopped on the way home | watch | Was heading home, then stopped for 10 min |
| Phone left behind | watch | Set down untouched for 20 min while out late |
| In a vehicle, battery critical | context | Logged (a dying battery also uploads a last location) |
| Check-in missed, typing off | danger, watch | No answer in 2 min; an answer typed far off your normal rhythm |
| Scream / shout, snoring while down | watch, danger | Audio labels after a fall or grab |

**Your own normal ranges.** Each walking measure is compared with your normal range for where the phone is
carried. The phone learns it on ordinary walks and trusts it after walking data from 7 different days (rolling
14 days, nights with incidents left out). Until then it uses starting ranges. The pocket ranges are calibrated
to one person from recorded walks: unsteady walking uses regularity, sway and wobble, but not stride
variability, which a pocket measures badly. Hand and bag still use population values.

**When it asks "You okay?"** When a danger incident is open, when a possible fall, hard impact or scream has
been open for 5 s, or when watch incidents from two different kinds of evidence (fall, walking, phone,
location, check-in, audio) are open together. Answering covers everything open; only a new incident can ask
again, after a 5-min pause.

**Episodes.** A check-in, grab or SOS starts an episode that gathers the last hour of incidents into one
sentence for friends, such as "Unsteady walking, then a hard fall, then down for 2 min, then no answer to a
check-in." That sentence is all a friend learns about your sensors.

**Settings from the server.** The rules are a TOML file served by the backend (now version 6) and merged
over the copy built into the app, so a bad file can't break the engine. **Demo sensitivity** in Settings
swaps in easier thresholds for trying it out in a room (shorter timers, unsteady walking after 12 s, a grab
after 2 s of jogging, check-in lasts 30 s).

## 3. Check-ins and alerts

| Step | When | What happens |
|---|---|---|
| Check-in | A trigger holds | Full-screen "You okay?" on the lock screen with what was detected and a countdown. Nobody else is told |
| Heads-up | 2 min without an answer | Friends get "might not be okay" with the summary, no location |
| Location unlock | 4 min after the check-in | The phone releases the current and next hour's location keys to friends and uploads a fresh fix |
| Call option | 10 min after the check-in | Friends get one-tap campus safety / 911 with ready-to-read text |

- **The check-in withdraws itself** when its cause clears, for example when you get up and walk after a fall.
  Friends are never told.
- **Answering "I'm OK"** first needs proof it's you: face unlock where the phone lets apps use it (Pixel,
  most Samsungs), fingerprint, or PIN. Then you type a random three-word phrase; the phone checks your typing
  rhythm. Way off your rhythm: friends hear "answered, but may be impaired".
- **"I need help"** works for anyone and unlocks the location at once.
- **Grab / snatch** skips the check-in: friends are told at once (with "don't chase"), and the location
  unlocks fully after 2 min unless you unlock the phone. Only your biometric dismisses it.
- **Manual SOS**: hold the button in the app, the Quick Settings tile or the home-screen widget. It unlocks
  at once; cancelling needs your biometric.
- **Phone offline / battery dying**: the server notices missing heartbeats (10 min) or a battery at 3 % and
  tells friends.

**What friends can do:** ring the phone loudly, call, alert the whole group, ask for the location now, say
"I'm going", mark found/safe (the phone stops alerting), or call campus safety / 911.

## 4. Privacy and encryption

- **Device keys** (X25519 for sealing, Ed25519 for signing) stay in the Android Keystore.
- **Friends are added in person** by scanning a QR code and checking that a fingerprint matches on both
  screens, so the server can't swap keys. Both sides accept.
- **Daily keys.** A fresh day key each day; hour keys derived from it. The day key is split with Shamir secret
  sharing (any k of your friends, default 2) and each share is sealed to one friend.
- **Location** is encrypted with XChaCha20-Poly1305 under the hour key. The server keeps 6 h of ciphertext and
  has no way to decrypt it.
- **Two ways to unlock:** your own phone releases two hours of keys during an alert, or, if your phone is
  offline or dying, k friends combine their shares (groups of 3 or more only).
- **Every unlock is audited** and visible to you and the group.
- **Together / separated** is computed from hashed map cells; the server only learns yes or no.
- **Never leaves the phone:** home places, walking and typing baselines, private keys, audio.

## 5. The app

| Screen | What it does |
|---|---|
| Sign-in | Phone code by SMS, Google, or an anonymous demo account |
| Onboarding | How it works, permissions (each with a plain reason), home places, a baseline walk, typing practice |
| Home | A radar with you in the middle and friends by direction and distance, one sentence on who needs you, **Hold for help** (SOS) and **I'm okay** |
| Friends | You, friends who are out (worst first), friends at home, each with a call button |
| Friend page | Their radar, a headline, tonight's timeline, Call / Campus safety / Go to |
| Incident (friend side) | What happened, the map once unlocked, all friend actions, fallback unlock with approval progress, live timeline |
| Groups, Scan | Your QR and fingerprint, groups, invites, how many friends it takes to unlock |
| History | Past incidents and every access to your location or keys |
| Settings | Emergency number, sound detection, evening window, night mode, personal dashboard, live streaming to the monitor, demo sensitivity, **Allow data collection**, debug tools, sign out |
| Personal dashboard | Your live measures against your normal ranges, sensor and mic state, your incident log |

## 6. Web monitor (`/monitor`, for friends on a laptop)

- **Live sensor view** at 10 frames a second over one Realtime connection (nothing stored): motion and
  rotation waveforms on the phone's clock, measure tiles against the normal range, a mic strip, and the round
  trip time. Never location.
- **Incident log** built for scanning: plain incident names, "2 min ago", a status ("Active · 3 min so far",
  "Over · lasted 60 s", "Moment", "Answered"), severity as a coloured edge, incidents of one episode boxed
  together, a "Watch & danger only" filter, and **Confirmed OK** rows whenever you answered a check-in or
  tapped "I'm okay".
- **Engine events**: plain labels with "40 s ago", repeats folded, sensor housekeeping dimmed.
- **Escalation dock**: appears while an alert is open, turns red and beeps when overdue, has every friend
  action and a map once keys arrive.
- **Delete all**: permanently deletes the person's incidents from the server, empties the phone's log, resets
  sensing, and clears the AI read and the OK log.
- **AI read** (advisory only): the incident timeline (kinds, order, gaps, durations, matched patterns; never
  measurements, location or audio) goes to Claude Haiku 5.5 from the friend's browser, with a free OpenRouter
  model as fallback. It re-reads after every new event. You get a risk level and a 0 to 100 score, a
  trajectory, the innocent explanation, what would change the read, and pop-up reminders. The engine's own
  alert level sets a floor.
- **The AI shows its working.** Arrows run from each incident in the log to the AI's reading of it ("+10:
  possible fall right after a missed check-in"), from there into the steps that combine incidents ("impaired,
  then a fall, then down: +4"), and into the total, which adds up to the score. Hovering highlights one path.
- **"I'm OK" resets the AI.** When you confirm you're fine, the score drops to 0 at once and the next read
  counts only what happens afterwards.

## 7. Data collection and calibration

- **`/collect` page** on the web: pick a friend's phone, press Start, and click the action they are doing now
  (normal, slow, fast or unsteady walking, stumbling, stairs, running, standing, sitting, lying down, a fall
  onto a bed, a phone drop, a phone grab, dancing, a vehicle). Keyboard shortcuts work too.
- **The phone must allow it** (Settings → Allow data collection). During a session it records full-rate raw
  motion, runs the detection rules so you see what would fire, but **sends no check-ins, alerts or SOS** and
  learns nothing. Its notification shows the current action and a Stop button. A session ends by itself a few
  minutes after the page closes, and the phone then clears its incident log.
- **Recordings stay in the browser** (the server only relays the stream) and download as JSON files.
- **Calibration panel:** ranges of each measure per action, your normal-walk baseline, a rule tester for
  unsteady walking (range width, wait time, which measures count), and a grid comparing false alarms against
  detection.
- **Offline tools:** `tools/collect` turns recordings into simulator traces; `sim replay --config <file>`
  replays them through the real engine with any settings file. Two recorded walks are kept as permanent tests
  in `core/traces/recorded/`.

## 8. Backend (Supabase)

- **Tables** (row-level security on all): profiles, devices, groups and members, key epochs and shares,
  encrypted location, proximity tokens, presence, incidents and their events, released keys, unlock requests
  and approvals, audit log, model configs.
- **Edge functions:** `push` (APNs and FCM, no location in payloads), `watchdog` (every minute: phone offline,
  battery dying), `proximity` (together / separated), `unlock` (gates fallback unlock), `purge` (retention),
  `config` (serves the rules file).
- **Realtime:** friends' screens follow incidents and keys live; `telemetry:{user}` carries the live stream;
  `telemetry-cmd:{user}` carries commands from the monitor to the phone (reset, friend marked safe, release
  location, data-collection start / label / stop).
- **Database functions** for heartbeats, incidents, invites, unlock requests, audit triggers and
  `purge_incidents` (behind Delete all).
- **Auth:** SMS code, Google, anonymous demo. The phone's service refreshes its own session, so uploads keep
  working while the app is closed.

## 9. Tooling and tests

| Tool | Job |
|---|---|
| `sim` (Rust CLI) | Replay, synthesize and batch-test traces through the full engine; CI gates on false alarms and detection delay |
| `tools/collect` | Label and export recordings into simulator traces |
| `core/build-mobile.sh` | Builds the Rust library and Kotlin bindings for Android |
| `safety-wasm` | Builds the crypto for the browser |
| `e2e/` | Maestro flows: check-in, heads-up, unlock with map, snatch, SOS |

Tests: 92 Rust (engine stories and rules, including the recorded walks, plus crypto), 25 Deno edge-function
tests, 48 pgTAP database checks, and 22 TypeScript tests (monitor timeline, collection recorder and analysis,
OK log). CI runs Rust, the simulator gate, functions, mobile typecheck and lint, and Android bindings.

## 10. Known limits

- The pocket calibration comes from one person and about a minute of walking; hand and bag are not
  calibrated yet.
- Face unlock at check-in depends on the phone: some phones (such as the Nothing test phone) keep face unlock
  for the lock screen only, so the app offers fingerprint or PIN.
- The "Learn my walking on normal days" switch only changes the screen, and turning sound detection off does
  not revoke the microphone.
- The server plus one friend working together could narrow down proximity cells (about 150 m) at night.
- k friends together can unlock during a real offline incident; that is the feature, and the audit log shows
  it.
- Any group member can wipe a friend's incident log from the monitor, and the AI keys sit in the web bundle
  (use a low spend limit).
- Open items: an external crypto review, checking the rules file's signature on the phone, rate limits on
  unlock requests, Play Store declarations, accessibility, a field test of battery life and a real
  data-collection study.
