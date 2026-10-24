# Audio commotion model (YAMNet)

The night-mode audio booster scores each 0.975 s microphone window with YAMNet and keeps three
numbers: `scream`, `shout`, `glass`. This document records where the bundled model comes from, what it
expects, and how its 521 AudioSet classes are mapped onto those three scores.

## Files

| Platform | Path | Loaded by |
|---|---|---|
| Android | `apps/mobile/modules/safety-native/android/src/main/assets/yamnet.tflite` | `YamnetClassifier.kt` via `assets.openFd()` + mmap |
| Android | `apps/mobile/modules/safety-native/android/src/main/assets/yamnet_class_map.csv` | `YamnetClassifier.loadClassNames()` |
| iOS | `apps/mobile/modules/safety-native/ios/Resources/yamnet.tflite` | `AudioMonitor.swift` (`Bundle.main.path(forResource: "yamnet", ofType: "tflite")`) |
| iOS | `apps/mobile/modules/safety-native/ios/Resources/yamnet_class_map.csv` | `AudioMonitor.swift` `loadClassMap()` |

Android: `assets.srcDirs = ['src/main/assets']` in `android/build.gradle`, and
`androidResources { noCompress 'tflite' }` keeps aapt from deflating the model. That setting is required:
the Kotlin code memory-maps the asset through `openFd()`, which only works for uncompressed assets.
`.csv` is on aapt's default no-compress list, and it is read through a plain stream anyway.
The `copyModelConfig` Gradle task only copies `model-v1.toml`; it never touches the YAMNet files.

iOS: `SafetyNative.podspec` declares `s.resources = 'Resources/*.{tflite,csv,caf,wav,toml}'` whenever the
`Resources/` directory is non-empty, so both files land in the app bundle on the next `pod install`.

Without `yamnet.tflite` the audio booster is disabled (`isLoaded == false` on iOS, throws on Android);
the rest of the safety model keeps working.

## Source and license

| | |
|---|---|
| Model | `google/lite-model/yamnet/classification/tflite/1` (TF Hub, now hosted on Kaggle Models) |
| Model URL | `https://tfhub.dev/google/lite-model/yamnet/classification/tflite/1?lite-format=tflite` (redirects to a signed Kaggle storage URL; no login was needed on 2026-10-24) |
| Model size | 4,126,810 bytes |
| Model SHA-256 | `10c95ea3eb9a7bb4cb8bddf6feb023250381008177ac162ce169694d05c317de` (bundled file is byte-identical to the download) |
| Class map | `https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv` |
| Class map SHA-256 | upstream (CRLF) `cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2`; bundled (LF) `b03d48f9ebe23f69ea825193de7e736934086a12410f0af47babe897b78bc0d3` |
| License | Apache License 2.0 for both the model (TF Hub / Kaggle listing; the TFLite metadata itself embeds "Apache License. Version 2.0") and the class map (`tensorflow/models` repository) |

The mirror `https://storage.googleapis.com/tfhub-lite-models/google/lite-model/yamnet/classification/tflite/1.tflite`
returns 403 and is not usable.

The bundled CSV has its line endings normalised from CRLF to LF. This matters on iOS: Swift's
`text.split(separator: "\n")` treats `"\r\n"` as a single `Character`, so a CRLF file would not split at
all and the Swift classifier would silently fall back to its hard-coded indices. The Kotlin parser
(`trim()`) tolerates either ending. Content is otherwise unchanged (521 rows, header `index,mid,display_name`).

## Model contract (verified by parsing the flatbuffer)

| | |
|---|---|
| TFLite schema version | 3, "MLIR Converted.", 1 subgraph, 47 operators |
| Input 0 | `waveform_binary`, shape `[15600]`, float32: 0.975 s of mono audio at 16 kHz, samples scaled to [-1, 1] |
| Output 0 | `tower0/network/layer32/final_output`, shape `[1, 521]`, float32: per-class scores (sigmoid, not softmax; independent probabilities) |
| Embedded metadata | `TFLITE_METADATA` with associated file `yamnet_label_list.txt` (521 labels, identical in order to the CSV `display_name` column) |

Both native classifiers agree with this contract:

- Kotlin (`YamnetClassifier.kt`): `FRAME_SAMPLES = 15_600`, `NUM_CLASSES = 521`; detects the 1-D input and
  calls `interpreter.run(FloatArray(15600), Array(1) { FloatArray(521) })`, which matches `[15600] -> [1, 521]`.
  Int16 PCM is divided by 32768.
- Swift (`AudioMonitor.swift`): `windowSamples = 15600`, resizes input 0 to `[15600]`, reads output 0 as `[1, 521]`.

## Class mapping

Indices are resolved by `display_name` from the CSV at start-up, so a re-exported model with a shuffled
label list cannot silently change what "scream" means. With the bundled CSV the resolved indices are:

| Score | AudioSet classes (index: display_name, mid) |
|---|---|
| `scream` | 11: Screaming (`/m/03qc9zr`) |
| `shout` | 6: Shout (`/m/07p6fty`), 7: Bellow (`/m/07rwm0c`), 8: Whoop (`/m/0lyf6`), 9: Yell (`/m/07sr1lc`); iOS also 10: Children shouting (`/t/dd00135`) |
| `glass` | 435: Glass (`/m/039jq`), 437: Shatter (`/m/07rn7sz`) |

Each score is the max over its group. Note there is no class literally named "Scream"; the AudioSet label is
"Screaming". Neighbouring classes for reference: 433 Splinter, 434 Crack, 436 "Chink, clink", 464 Breaking.

### Hard-coded fallbacks (used only if the CSV is missing or unparseable)

| | scream | shout | glass | Status |
|---|---|---|---|---|
| Swift `AudioMonitor.swift` | `[11]` | `[6, 7, 9]` | `[435, 437]` | correct |
| Kotlin `YamnetClassifier.kt` | `[11]` | `[6, 9, 7, 8]` | `[434, 435]` | **434 is "Crack", not Shatter; should be `[435, 437]`** |

The Kotlin fallback is harmless while the CSV is bundled (the CSV wins), but it should be corrected to
`intArrayOf(435, 437)` so the no-CSV path matches iOS.

## Updating the model

1. Download the new `.tflite` and class map into a scratch directory, never straight into the repo.
2. Check `bytes[4:8] == b"TFL3"`, input shape `[15600]` float32, output shape `[1, 521]`.
3. Check the CSV has 521 rows, header `index,mid,display_name`, index column `0..520`, and that
   `Screaming`, `Shout`, `Yell`, `Bellow`, `Whoop`, `Glass`, `Shatter` are present. Convert CRLF to LF.
4. Copy the same two files to both the Android assets dir and `ios/Resources/`, and update the hashes above.
