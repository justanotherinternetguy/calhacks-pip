# Push notifications setup (Android / FCM first)

How a friend's **Ring phone**, a heads-up, an offline/battery alert or an SOS
reaches another phone:

```
app (friend)  ──POST /functions/v1/push──▶  edge fn `push`  ──FCM v1 / APNs──▶  phone (subject)
                                              │ reads devices.push_token / push_kind
                                              │ data: { incidentId, kind, route, … }
apps/mobile/lib/push.ts  ──PATCH devices──▶  push_token (FCM/APNs device token), push_kind
apps/mobile/lib/notifications.ts            reacts: kind 'ring' → SafetyNative.ringAlarm(30); else → /incident/{id}
```

Nothing in the repo contains credentials. You must provide the three things in
**bold** below. Everything is fail-soft: without them the app logs
`push: token registration failed …` and the edge function answers
`{ ok: false, error: "FCM not configured" }` per device instead of crashing.

Supabase project: `ahxzcyqvrodgdymginvs` (already linked in `supabase/`).
Android package / iOS bundle id: `app.safe.mobile`.

---

## 1. Firebase project + `google-services.json` (Android)

1. <https://console.firebase.google.com> → **Add project** (any name, Analytics off is fine).
2. Project overview → **Add app** → Android.
   - Package name: `app.safe.mobile` (must match `android.package` in `apps/mobile/app.config.ts`).
   - Nickname anything; SHA-1 not required for FCM.
3. **Download `google-services.json`** and save it as
   `apps/mobile/google-services.json`.
   It is gitignored (`apps/mobile/.gitignore`). `app.config.ts` only sets
   `android.googleServicesFile` when the file exists, so the repo keeps building
   without it (push just stays disabled).
4. Firebase console → Project settings → **Cloud Messaging** → make sure
   **Firebase Cloud Messaging API (V1)** is *Enabled* (legacy API is not used).

## 2. Service-account key → Supabase secret (`FCM_SERVICE_ACCOUNT_JSON`)

The edge function signs an RS256 JWT with this key to get an OAuth token for
`fcm.googleapis.com/v1/projects/<project>/messages:send`.

1. Firebase console → Project settings → **Service accounts** →
   **Generate new private key** → saves `<project>-firebase-adminsdk-….json`.
   (Equivalent: Google Cloud console → IAM → Service accounts →
   `firebase-adminsdk-…@<project>.iam.gserviceaccount.com` → Keys → Add key → JSON.)
   The account needs the *Firebase Cloud Messaging API Admin* role (the default
   adminsdk account has it).
2. Store it as one line in the hosted project's secrets (from `supabase/`):

   ```sh
   cd supabase
   npx supabase@latest secrets set FCM_SERVICE_ACCOUNT_JSON="$(jq -c . ~/Downloads/<project>-firebase-adminsdk-xxxxx.json)"
   npx supabase@latest secrets list          # should show FCM_SERVICE_ACCOUNT_JSON
   ```

   `jq -c` is required: the value must be a single line of JSON; the function
   reads `project_id`, `client_email`, `private_key` (with its `\n` escapes) from it.
3. Redeploy the function so it picks the secret up (secrets are read at
   invocation, but redeploying also ships the `route` data field added for the app):

   ```sh
   npx supabase@latest functions deploy push
   ```

   For local `functions serve`, put the same line in `supabase/.env.local`
   as `FCM_SERVICE_ACCOUNT_JSON='{"type":"service_account",…}'`.

4. Delete the downloaded key file afterwards or keep it outside the repo
   (`*.json` is **not** gitignored — do not drop it in `supabase/`).

## 3. Rebuild the Android app

`google-services.json` is compiled into the APK (resources + the
`com.google.gms.google-services` Gradle plugin that expo-notifications adds), so
a JS reload is not enough:

```sh
cd apps/mobile
npx expo prebuild --platform android --clean     # regenerates android/ with google-services.json + firebase plugin
npx expo run:android                              # or: cd android && ./gradlew installDebug
```

Check the generated project contains it:

```sh
ls android/app/google-services.json
grep -n "google-services" android/app/build.gradle
grep -n "default_notification_channel_id" android/app/src/main/AndroidManifest.xml   # value "alarm"
```

On first sign-in after the rebuild the app asks for notification permission
(Android 13+ `POST_NOTIFICATIONS`), fetches the FCM token and writes it to
`devices.push_token` with `push_kind = 'fcm'`. Verify in the SQL editor:

```sql
select id, user_id, platform, push_kind, left(push_token, 24) || '…' as token, last_heartbeat
from public.devices order by created_at desc limit 10;
```

If `push_token` stays null, look at Metro / `adb logcat -s ReactNativeJS`
for `push: token registration failed (fcm): …` — the message says whether it
is the missing `google-services.json`, a denied permission, or the demo mode
(`EXPO_PUBLIC_SUPABASE_URL` unset in `apps/mobile/.env`).

## 4. Testing the pipeline

### 4a. End to end from two phones

Sign in on phone A (subject) and phone B (friend) in the same group. On B open
the subject's incident and tap **Ring phone**. A should ring for 30 s via the
native alarm (channel `alarm`, bypasses Do Not Disturb) even in the background,
and tapping the notification opens `/home`. Any other push (heads-up, offline,
SOS …) opens `/incident/<id>` on B.

### 4b. Call the edge function with a user JWT (curl)

You need: the project URL and anon key (`apps/mobile/.env`), a **user JWT**,
and an **incident id** whose subject/group includes both the caller and the
target device's user.

Get a JWT. Easiest is the phone-OTP flow with a test number from
`supabase/config.toml` `[auth.sms.test_otp]`:

```sh
export SUPABASE_URL=https://ahxzcyqvrodgdymginvs.supabase.co
export ANON="$(grep EXPO_PUBLIC_SUPABASE_ANON_KEY apps/mobile/.env | cut -d= -f2-)"

# 1) request OTP, 2) verify it -> access_token
curl -s "$SUPABASE_URL/auth/v1/otp" -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"phone":"+15555550100"}'
export JWT="$(curl -s "$SUPABASE_URL/auth/v1/verify" -H "apikey: $ANON" -H 'content-type: application/json' \
  -d '{"type":"sms","phone":"+15555550100","token":"123456"}' | jq -r .access_token)"
```

(Or copy the token out of the running app: `supabase.auth.getSession()` in the
dev-tools console, or temporarily `console.log(session.access_token)` in
`lib/native.ts`.) Anonymous sign-in (the Demo button) also returns a JWT via
`POST /auth/v1/signup` with body `{}`, but that user has no group, so it can
only push to incidents it opened itself — fine for testing *your own* phone:

```sh
# open an incident for the caller's group (returns the uuid); needs a group the user is in
curl -s "$SUPABASE_URL/rest/v1/rpc/open_incident" -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' -d '{"group_id":"<GROUP_UUID>","level":"heads_up","summary":"push test"}'
```

Send the push (friend → subject "ring"):

```sh
curl -s "$SUPABASE_URL/functions/v1/push" \
  -H "apikey: $ANON" -H "Authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{
    "incidentId": "<INCIDENT_UUID>",
    "kind": "ring",
    "title": "Your friends are ringing you",
    "body": "Tap to answer",
    "recipients": ["<SUBJECT_USER_UUID>"],
    "critical": true,
    "data": { "route": "/home" }
  }' | jq
```

Expected: `{ "recipients": ["<subject>"], "sent": 1, "results": [{ "kind": "fcm", "ok": true, "status": 200 }] }`.
`recipients` is clamped to the incident's group **minus the caller**, so to
ring your *own* phone from curl use a second user's JWT, or omit `recipients`
(defaults to everyone else in the group) and target a phone signed in as
another member.

A generic heads-up (opens the incident screen on every other member):

```sh
curl -s "$SUPABASE_URL/functions/v1/push" -H "apikey: $ANON" -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"incidentId":"<INCIDENT_UUID>","kind":"heads_up","title":"Sam might not be okay","body":"No answer to check-in"}' | jq
```

Troubleshooting `results[].error`:

| error | meaning |
|---|---|
| `no push token` | that device row has no `push_token` — see §3 |
| `FCM not configured (FCM_SERVICE_ACCOUNT_JSON)` | secret missing/unparseable — §2 |
| `google token 400/401 …` | service-account key invalid or revoked |
| FCM `404 UNREGISTERED` / `400 INVALID_ARGUMENT` | stale token (app reinstalled) — sign in again; `apps/mobile/lib/push.ts` re-saves rotated tokens |
| FCM `403 SENDER_ID_MISMATCH` | `google-services.json` is from a different Firebase project than the service account |

Function logs: Supabase dashboard → Edge Functions → `push` → Logs
(`push failed device=… kind=fcm: …` lines come from `_shared/push.ts`).

### 4c. Payload the app receives

```json
{ "incidentId": "…", "kind": "ring", "route": "/home", "critical": "true", "title": "…", "body": "…" }
```

`route` defaults to `/incident/{incidentId}` server-side. The app
(`lib/notifications.ts`) rings on `kind == 'ring'` and otherwise routes to
`route`, for kinds `heads_up | unlocked | snatch | offline | battery_dying | sos`
(also `check | release | unlock_requested`) when it opens the incident.

---

## 5. iOS / APNs (out of scope for now — needs a paid Apple Developer account)

The code path exists (`push_kind = 'apns'`, `_shared/push.ts` → `api.push.apple.com`),
but requires:

1. An Apple Developer Program membership; App ID `app.safe.mobile` with the
   **Push Notifications** capability (and, separately requested from Apple, the
   **Critical Alerts** entitlement — until granted, pushes land as time-sensitive).
2. An APNs auth key (.p8) → secrets `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_P8`,
   `APNS_BUNDLE_ID=app.safe.mobile`, `APNS_SANDBOX=true` for dev builds
   (`npx supabase secrets set …` as above).
3. A real device (no push on the simulator) and an EAS/Xcode build signed with a
   provisioning profile that includes push. `GoogleService-Info.plist` is only
   needed if you also want Firebase on iOS; `app.config.ts` wires it in when present.
4. The alarm sound `alarm.caf` in the iOS bundle (`APNS_SOUND_CRITICAL`).

## Files involved

- `apps/mobile/lib/push.ts` — permission + `getDevicePushTokenAsync()` → `devices.push_token/push_kind`; token-rotation listener.
- `apps/mobile/lib/native.ts` — calls `registerPushToken()` after the device upsert on sign-in; clears the listener on sign-out.
- `apps/mobile/lib/notifications.ts` — foreground/tap handlers, `alarm` channel fallback, ring + routing.
- `apps/mobile/app.config.ts` — conditional `googleServicesFile`, `expo-notifications` plugin (`defaultChannel: 'alarm'`).
- `supabase/functions/push/` + `_shared/push.ts` — auth (subject or group member), recipient clamping, FCM/APNs fan-out, `data.route` default.
