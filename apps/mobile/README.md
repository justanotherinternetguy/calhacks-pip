# Safe — mobile app (Expo)

UI only. All sensing, detection, escalation, crypto and Supabase uploads from the device run in the native module
(`modules/safety-native`, Swift/Kotlin + Rust `safety-core`). JS renders status, handles friend-side actions and routing.

## Run

```sh
pnpm install
cp apps/mobile/.env.example apps/mobile/.env   # fill EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY
cd apps/mobile
pnpm prebuild            # expo prebuild --clean (runs the safety-native config plugin)
pnpm ios | pnpm android  # dev build on device (background location/motion need a real device)
pnpm start               # metro for the dev client
pnpm typecheck && pnpm lint
```

Prebuilt Rust libs: run `core/build-mobile.sh` first; the config plugin copies `core/target/mobile/*.xcframework`
into `ios/Frameworks` and `core/target/mobile/jniLibs` into the Android module. Missing libs = no-op.

## Web / Expo Go mock mode

`pnpm web` (or Expo Go) has no native module, so `SafetyNative` resolves to `modules/safety-native/src/MockSafetyNative.ts`:
every method succeeds, `statusChanged` fires every 10 s with fake battery/night mode, `triggerSos`/`needHelp` emit
escalation events, `decryptLocations` returns a fake trail, and Settings → "Simulate check-in" fires `checkRequested`
so the check-in modal can be demoed. `SafetyNative.isMock === true` in that mode (shown as "MOCK" on the home card).
Leave `EXPO_PUBLIC_SUPABASE_URL` unset to show an anonymous demo sign-in button.

## Layout

- `app/` expo-router screens: `(auth)/sign-in`, `onboarding/*`, `(tabs)/{home,friends,history}`, `settings`,
  `check-in` (modal, from `checkRequested` event or notification `data.route`), `scan`, `incident/[id]`, `unlock-approve/[requestId]`.
- `lib/supabase.ts` client with chunked SecureStore session storage; `lib/db.ts` typed table helpers, RPCs
  (`heartbeat`, `open_incident`, `resolve_incident`, `add_incident_event`, `accept_invite`, `open_unlock_request`,
  args prefixed `p_`), edge-function calls, realtime `subscribe()`; `lib/store.ts` zustand; `lib/native.ts` wires
  auth → `SafetyNative.configure`/`setAccessToken`, native events → store, realtime → store.
- `modules/safety-native/` facade typed exactly to `docs/CONTRACTS.md §2`; `plugin/withSafetyNative.js` config plugin
  (Android foreground service / boot receiver / QS tile / widget, iOS background modes, prebuilt lib copy).
- Native typing view: `CheckInInput` wraps `requireNativeView('SafetyNative', 'SafetyNativeTypingView')` with props in
  `src/CheckInInput.types.ts`; falls back to a JS `TextInput` that measures key timestamps when the view is absent.
