# tools/collect — consented data collection (PLAN M7)

Turns recorded sensor traces into the per-scenario folders `sim batch` replays, and labels them.
No sensor code lives here: recordings come from the debug trace recorder in the app
(`SafetyNative` collect flavor), which writes JSON with the same field names as the Rust
records in `docs/CONTRACTS.md`:

```json
{ "motion":  [{ "t_ms": 0, "ax": 0.01, "ay": -0.02, "az": 0.0, "gx": 0, "gy": 0, "gz": -1 }],
  "context": [{ "t_ms": 0, "away_from_home": true, "separated": false, "hour_local": 23,
                "screen_on": false, "activity": "Walking", "battery_pct": 71, "speed_mps": -1 }],
  "audio":   [{ "t_ms": 0, "scream": 0.01, "shout": 0.02, "snore": 0.0, "level_db": 62.5 }],
  "actions": [{ "t_ms": 91000, "action": "CheckTimeout" }],
  "labels":  [{ "t_start_ms": 0, "t_end_ms": 120000, "label": "normal_walking" }],
  "meta":    { "participant": "p07", "scenario": "normal_walking", "placement": "pocket" } }
```

Motion is 50 Hz: `ax..az` user acceleration in g (gravity removed), `gx..gz` gravity unit vector,
device frame. Audio holds YAMNet class probabilities and a sound level only (listening windows only) — never samples.

## Use

```bash
pnpm install
pnpm --filter collect typecheck
cd tools/collect
node src/label.ts rec/p07-session1.json --list
node src/label.ts rec/p07-session1.json --start 0      --end 180000 --label normal_walking
node src/label.ts rec/p07-session1.json --start 180000 --end 240000 --label padded_fall
node src/label.ts rec/p07-session1.json --start 181200 --end 182000 --label impact
node src/export.ts --in rec/ --out ../../core/traces --split
cargo run --manifest-path ../../core/Cargo.toml -p sim -- batch ../../core/traces
```

`--split` cuts each scenario-labeled segment into its own trace (time rebased to 0). Without it,
one file → one trace, scenario taken from `--scenario`, `meta.scenario`, or the longest scenario
label. Output: `core/traces/<scenario>/<id>.json` plus `core/traces/index.json`. Each trace carries
an `expect` block (`max_escalation` for the false-alarm bound, `min_escalation` for detection) from
`src/schema.ts`; the sim gate fails when a trace violates it. Tuning targets: ≤1 check per 5 nights,
≤1 false unlock per 500 nights.

## Study protocol

Scenarios, each 3–10 min per participant, phone in pocket / hand / bag rotations:

| Scenario | Setup | Must |
|---|---|---|
| `normal_walking` | Sober walk, mixed pace, stairs, stops | stay `Idle` |
| `impairment_goggles` | Fatal-vision goggles, walk a marked course | ≤ `Check` (drift raises P(Impaired) only) |
| `padded_fall` | Crash mat, spotter, fall then lie still 3 min, then get up | reach `Check`; recovery when walking resumes |
| `phone_drop` | Drop phone on a mat from standing, pick up after 30 s | stay `Idle` (drop pattern) |
| `dancing` | 5 min to music, phone in pocket | ≤ `Check` (agitation weighted low) |
| `sitting` | 10 min seated, no screen use | stay `Idle` |
| `transit` | Bus/train/rideshare ride | stay `Idle` |

Rules: participants are 18+, sober (goggles simulate impairment; no alcohol is given), falls only
onto mats with a spotter, no audio samples recorded (only class scores), raw GPS is stripped before
export (`context.speed_mps` only). Participant IDs are random; the mapping sheet is kept offline
and destroyed after the study. Participants can withdraw and have their files deleted at any time.

### Consent text (read and signed before the first session)

> I agree to carry a study phone that records motion sensors, step and activity data, screen
> on/off events, and sound *category scores* (not recordings) while I perform the listed
> activities. No location, contacts, or microphone audio are stored. The data is labeled with an
> anonymous ID, used only to tune the pip app's detection thresholds, and may be published in
> anonymized aggregate form. I am 18 or older, I understand that padded falls carry a small risk
> of injury and will be spotted, and I can stop at any time and ask for my data to be deleted
> by emailing the study contact.
