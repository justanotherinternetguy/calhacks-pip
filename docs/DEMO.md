# 5-minute judge demo

There are two setups. **A** (preferred): two phones, both with the debug dev-build. **B**: one phone
(or emulator) plus the web mock friend view. Both use the debug inject-trace deep link
`safe://debug/inject?trace=<name>`. This link replays a recorded trace through the real native → Rust
pipeline at 10× speed. No alcohol, no actual falls.

## Setup (before judges arrive)

```bash
core/build-mobile.sh                      # android (+ios on mac)
pnpm --filter mobile android              # install dev build on phone A (subject) and B (friend)
supabase start && supabase db reset       # or point .env at the hosted project
supabase functions serve                  # push/watchdog/proximity/unlock/purge/config
```

1. Use Phone A as "Sam" (subject) and Phone B as "Jo" (friend).
2. Pair the two phones in person via QR (Friends → Add).
3. Set Sam's evening window to include the current time.
4. Mark a "home" far away, so that night mode is active.
5. For setup B, open the `apps/mobile` web build (`pnpm --filter mobile web`) with
   `?mock=friend&subject=<sam-id>` as the friend screen. This screen subscribes to the same
   `incidents` / `incident_events` / `location_blobs` rows via Realtime. It decrypts with the released key.
6. Put `adb shell am start -a android.intent.action.VIEW -d 'safe://debug/inject?trace=...'` (or
   `xcrun simctl openurl booted ...`) in a terminal history.

## Script

**0:00 Pitch (30 s).**

1. Say: "This app notices when you cannot ask for help: bad gait, a fall then stillness, a snatched
   phone. It asks *you* first, then tells your friends. Location is end-to-end encrypted. No single
   friend can unlock it, and not even we can."

**0:30 Home screen (30 s).**

1. Show Phone A: night mode *active, away from home*, and Jo shown *together*.
2. Point at the SOS hold button.
3. Show Phone B: it shows Sam as *Night mode on, fine*.

**1:00 Story B, no false alarm (45 s).**

1. Inject `checkin-dismiss` first. Do not inject `heads-up` yet.
2. Narrate the trace: stumble → hard impact → still.
3. When Phone A shows "You okay? Type the 3 words", type the 3 words.
4. Show that Phone A says "Glad you're okay." and that nothing happened on Phone B.
5. Make this **point:** the user gets the first say. The answer acknowledges what was going on. Only
   a new incident can ask again.

**1:45 Story A, escalation (75 s).**

1. Inject `heads-up`.
2. Ignore the check-in.
3. Wait for the 2 min check-in deadline (12 s at 10×). Phone B gets "Sam might not be okay" **with
   no location**.
4. Show the server table in Supabase Studio. `location_blobs.ciphertext` is base64 garbage.
   `incidents.summary` reads "Unsteady walking, then a hard fall, then down for 2 min".
5. Continue to ignore the check-in. 2 min later, with the person still down, the location unlocks.
6. Show Phone B: the map appears with Sam's live position. The buttons are *Ring phone*, *Call*,
   *I'm going*, and *Found*.
7. Tap *Ring phone*. Phone A rings loudly.
8. Tap *I'm going*. All friends' screens show it.

**3:00 Privacy (45 s).**

1. On Phone A, go to History → Audit log. It shows "Jo unlocked your location at 21:14".
2. Explain the escrow: a daily key split k-of-n among friends with Shamir, hourly keys, HPKE-sealed
   shares, zeroized nightly. The company never holds a key.
3. If asked, open the `docs/THREAT_MODEL.md` table.

**3:45 Snatch (30 s).**

1. Inject `snatch`.
2. Show Phone B. It shows at once: "Sam's phone may have been snatched. Sam may be without a phone.
   Don't chase." with the snatch-moment pin.
3. Show Phone A: only biometrics can dismiss the alert ("I have my phone" → Face/fingerprint).

**4:15 Offline fallback (30 s, if time).**

1. On Phone A, force-stop the app or turn on airplane mode.
2. Wait for the watchdog window (shorter in debug). Phone B gets "Sam's phone went offline at 21:19",
   with no location, plus *Request unlock*.
3. Approve the request from a third phone or the web mock. 2-of-n shares rebuild the key, and the last
   location shows.
4. Show the audit log on Phone A. It shows the unlock afterwards.

**4:45 Close (15 s).**

1. Say: "It runs in Rust on the device and is replayable in CI (`sim batch`). It never calls 911
   itself. Friends do. Not an emergency service. 18+."
2. If asked, show the CI badge / `sim` output.

## Fallbacks

- If there is no second phone, use the setup B web friend view for every B-side step.
- If a push does not arrive, narrate that the friend screen also updates via Realtime.
- If the trace inject fails, run `maestro test e2e/heads-up.yaml`. It runs the same path headlessly.

## Friend on an iPhone (web client)

The friend role needs no sensing. So an iPhone can use the web build in Safari with real crypto
(Rust `safety-crypto` compiled to WebAssembly):

```sh
core/build-wasm.sh                 # → apps/mobile/public/wasm/
cd apps/mobile && npx expo export --platform web
npx serve -s dist -l 3000          # SPA fallback
npx cloudflared tunnel --url http://localhost:3000   # prints a https://*.trycloudflare.com URL
```

1. Open the URL on the iPhone.
2. Tap "Demo (anonymous)".
3. On the subject's phone, add the friend to the group via QR.

Realtime updates work while the tab is open. There is no web push in v1.
Native iOS needs a Mac with Xcode (free Apple ID, 7-day certificate) or an Apple Developer account for EAS.
