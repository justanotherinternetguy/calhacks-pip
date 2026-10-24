# e2e — Maestro flows

Five flows mirror PLAN §9: check-in dismiss, heads-up, unlock with map, snatch, manual SOS.
Each one drives the **debug-only** inject-trace deep link

```
safe://debug/inject?trace=<name>
```

which makes `SafetyNative.injectTrace(json)` replay a recorded `MotionSample[]`/`Context[]` trace
from the app's bundled `debug-traces/<name>.json` faster than wall-clock, so the real native →
Rust pipeline (not a JS mock) produces the escalation. The link is compiled out of release builds.

## Run

```bash
curl -fsSL https://get.maestro.mobile.dev | bash      # once
core/build-mobile.sh && pnpm --filter mobile android   # or `ios`; a debug dev-build must be installed
maestro test e2e/                                      # all flows
maestro test e2e/checkin-dismiss.yaml                  # one flow
maestro test --include-tags debug e2e/
```

Emulator/simulator is fine: inject mode bypasses sensors. Only `unlock-map.yaml` touches a
second party and it uses the debug friend view (`safe://debug/friend-view`) on the same device;
on two real phones use `docs/DEMO.md` instead.

## Contract with the app

`appId` is `com.safe.mobile`; change it in all five files if `apps/mobile/app.json` differs.
The flows assert these strings / test IDs, so the app should render them verbatim:

| Flow | Visible text | testID |
|---|---|---|
| check-in | `You okay?`, `Type the 3 words`, `Done`, `Glad you're okay` | `checkin-phrase`, `checkin-input` |
| heads-up | `Friends have been given a heads-up`, `No location shared yet` | |
| unlock | `Location shared with your friends`, `I'm going`, `Ring phone` | `incident-map` |
| snatch | `phone may have been snatched`, `Don't chase`, `I have my phone`, `Confirm it's you` | |
| sos | `Night mode`, `SOS sent`, `Cancel SOS`, `Confirm it's you` | `sos-button` |

Trace names (`checkin-dismiss`, `heads-up`, `unlock-map`, `snatch`, `manual-sos`) are the same
scenario files `sim batch` replays from `core/traces/`.
