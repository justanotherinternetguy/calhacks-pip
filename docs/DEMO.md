# 5-minute judge demo

Two setups. **A** (preferred): two phones, both with the debug dev-build. **B**: one phone (or
emulator) plus the web mock friend view. Both use the debug inject-trace deep link
`safe://debug/inject?trace=<name>`, which replays a recorded trace through the real native → Rust
pipeline at 10× speed. No alcohol, no actual falls.

## Setup (before judges arrive)

```bash
core/build-mobile.sh                      # android (+ios on mac)
pnpm --filter mobile android              # install dev build on phone A (subject) and B (friend)
supabase start && supabase db reset       # or point .env at the hosted project
supabase functions serve                  # push/watchdog/proximity/unlock/purge/config
```

- Phone A = "Sam" (subject). Phone B = "Jo" (friend). Pair them in person via QR (Friends → Add).
- Set Sam's evening window to cover now; mark a "home" far away so night mode is active.
- Setup B: open `apps/mobile` web (`pnpm --filter mobile web`) with `?mock=friend&subject=<sam-id>`
  as the friend screen; it subscribes to the same `incidents` / `incident_events` / `location_blobs`
  rows via Realtime and decrypts with the released key.
- Have `adb shell am start -a android.intent.action.VIEW -d 'safe://debug/inject?trace=...'` (or
  `xcrun simctl openurl booted ...`) in a terminal history.

## Script

**0:00 — Pitch (30 s).** "Every safety app needs the victim to act. This one notices when you can't
— bad gait, a fall then stillness, a snatched phone — asks *you* first, then tells your friends.
Location is end-to-end encrypted; no single friend and not even we can unlock it."

**0:30 — Home screen (30 s).** Phone A: night mode *active, away from home*; Jo shown *together*.
Point at the risk band and the SOS hold button. Phone B shows Sam as *Night mode on, fine*.

**1:00 — Story B, no false alarm (45 s).** Inject `heads-up` is tempting; instead inject
`checkin-dismiss` first. Narrate the trace: stumble → hard impact → still. Phone A lights up
"You okay? Type the 3 words". Type them. "Glad you're okay." Phone B: nothing happened. **Point:**
the user gets the first say, and a good dismiss lowers sensitivity for 30 min.

**1:45 — Story A, escalation (75 s).** Inject `heads-up`. Ignore the check-in. After the 90 s
timeout (9 s at 10×) Phone B gets "Sam might not be okay" **with no location**. Show the server
table in Supabase Studio: `location_blobs.ciphertext` is base64 garbage; `incidents.summary` reads
"hard fall, no movement 4 min". Keep ignoring; `P(danger)` crosses `T_unlock`. Phone B: map appears
with Sam's live position; buttons *Ring phone*, *Call*, *I'm going*, *Found*. Tap *Ring phone* →
Phone A rings loudly. Tap *I'm going* → visible on all friends' screens.

**3:00 — Privacy (45 s).** Phone A → History → Audit log: "Jo unlocked your location at 21:14".
Explain the escrow: daily key split k-of-n among friends with Shamir, hourly keys, HPKE-sealed
shares, zeroized nightly; the company never holds a key. Open `docs/THREAT_MODEL.md` table if asked.

**3:45 — Snatch (30 s).** Inject `snatch`. Phone B instantly: "Sam's phone may have been snatched
— Sam may be without a phone. Don't chase." with the snatch-moment pin. Phone A: the alert can only
be dismissed with biometrics ("I have my phone" → Face/fingerprint).

**4:15 — Offline fallback (30 s, if time).** Force-stop the app on Phone A or airplane mode.
Within the watchdog window (shortened in debug) Phone B gets "Sam's phone went offline at 21:19",
no location, plus *Request unlock*. With a third phone/web mock approving, 2-of-n shares rebuild
the key and the last location shows. Audit log on A shows it afterwards.

**4:45 — Close (15 s).** "Runs in Rust on the device, replayable in CI (`sim batch`), never calls
911 itself — friends do. Not an emergency service; 18+." Show the CI badge / `sim` output if asked.

## Fallbacks

- No second phone: use setup B's web friend view for every B-side step.
- Push not delivered: the friend screen also updates via Realtime; narrate that.
- Trace inject fails: `maestro test e2e/heads-up.yaml` runs the same path headlessly.

## Friend on an iPhone (web client)

The friend role needs no sensing, so an iPhone can use the web build in Safari with real crypto
(Rust `safety-crypto` compiled to WebAssembly):

```sh
core/build-wasm.sh                 # → apps/mobile/public/wasm/
cd apps/mobile && npx expo export --platform web
npx serve -s dist -l 3000          # SPA fallback
npx cloudflared tunnel --url http://localhost:3000   # prints a https://*.trycloudflare.com URL
```

Open the URL on the iPhone, tap "Demo (anonymous)", then add the friend to the group via QR from the
subject's phone. Realtime updates work while the tab is open; there is no web push in v1.
Native iOS needs a Mac with Xcode (free Apple ID, 7-day certificate) or an Apple Developer account for EAS.
