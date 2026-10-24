# supabase/ — backend for the night-out safety app

Postgres + RLS + edge functions. The server stores **only ciphertext, proximity
tokens and coarse status**. There is no decrypt path anywhere (pgTAP asserts it).

```
migrations/
  0001_schema.sql      tables from docs/CONTRACTS.md §3 + indexes + pgcrypto/pg_cron/pg_net
  0002_rls.sql         RLS on every table, helper predicates, device_status view, audit triggers
  0003_functions.sql   RPCs (heartbeat, open_incident, resolve_incident, add_incident_event,
                       accept_invite, open_unlock_request, purge_old_data, watchdog_tick),
                       pg_cron schedules, realtime publication
  0004_seed_model.sql  model_configs 'v1' placeholder (signature 'unsigned-dev')
  0005–0009            v1.1 groups / epochs policy fixes, model config updates
  0010_telemetry_channel.sql  RLS on realtime.messages for private `telemetry:{uuid}` broadcast channels
functions/
  _shared/supabase.ts  service / user clients, auth helpers, JSON responses
  _shared/push.ts      APNs + FCM v1 builders, ES256 / RS256 JWTs, fail-soft fan-out
  push/ watchdog/ proximity/ unlock/ purge/ config/
tests/rls.test.sql     pgTAP
```

## Run locally

```sh
cd supabase
npx supabase@latest start          # needs Docker; applies migrations/*.sql
npx supabase@latest status         # prints API URL, anon key, service_role key
npx supabase@latest functions serve --env-file .env.local
```

Reset + re-apply migrations: `npx supabase db reset`.

No Docker-heavy stack? Migrations and the pgTAP test also run against the
bare `supabase/postgres` image (that is how they were verified):

```sh
docker run -d --name safe-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 supabase/postgres:17.6.1.054
for f in migrations/000*.sql; do PGPASSWORD=postgres psql -h 127.0.0.1 -p 55432 -U postgres -v ON_ERROR_STOP=1 -f $f; done
PGPASSWORD=postgres psql -h 127.0.0.1 -p 55432 -U postgres -v ON_ERROR_STOP=1 -f tests/rls.test.sql   # look for "not ok"
```

## Tests

```sh
cd supabase && deno test --allow-all functions     # edge function unit tests (offline)
cd supabase && deno check functions/*/index.ts      # type-check entry points (downloads supabase-js)
npx supabase@latest test db                         # pgTAP (needs `supabase start`)
```

`supabase/deno.json` is a Deno workspace whose only member is `functions/`, so
the import map in `functions/deno.json` applies when you run `deno test` from
`supabase/`. The Supabase CLI picks up `functions/deno.json` on its own.

## Environment (edge functions)

Set these with `npx supabase secrets set --env-file .env.local` (hosted) or in
`.env.local` for `functions serve`. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

| Var | Used by | Notes |
|---|---|---|
| `APNS_KEY_ID` | push | Key ID of the .p8 from developer.apple.com |
| `APNS_TEAM_ID` | push | Apple team id |
| `APNS_P8` | push | contents of the .p8 (PEM; `\n` escapes are fine) |
| `APNS_BUNDLE_ID` | push | `apns-topic`, e.g. `com.yourorg.safe` |
| `APNS_SANDBOX` | push | `true` for dev builds → api.sandbox.push.apple.com |
| `FCM_SERVICE_ACCOUNT_JSON` | push | whole Firebase service-account JSON (one line) |
| `CRON_SECRET` | watchdog, proximity, purge | alternative bearer for schedulers that lack the service key |

Critical alerts on iOS need the Critical Alerts entitlement; until Apple grants
it the payload still carries `interruption-level: time-sensitive` semantics on
the device. Android needs a notification channel named `alarm` (see
`FCM_CHANNEL`) created by the native service.

### Letting pg_cron push

`cron_watchdog()` runs every minute and opens offline / battery_dying incidents
even with no edge function reachable (clients see them via Realtime). To also
get push notifications from cron, store two Vault secrets once per project:

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'edge_url');
select vault.create_secret('<service_role_key>', 'service_role_key');
```

`call_edge_function()` then POSTs `{ incidentIds }` to `/watchdog` via pg_net.
Without the secrets it is a silent no-op. Schedule `proximity` yourself
(e.g. a cron job calling `call_edge_function('proximity')` every 2 min):

```sql
select cron.schedule('safe-proximity', '*/2 * * * *', $$select public.call_edge_function('proximity')$$);
```

## Pointing the app at it

Native (`SafetyNative.configure`) and the Expo app need:

- `supabaseUrl` — `http://<lan-ip>:54321` locally (not `localhost` on a device), or `https://<ref>.supabase.co`
- `supabaseAnonKey` — from `supabase status`
- `accessToken` — the user's JWT from Supabase Auth (phone OTP; dev OTPs are in `config.toml` under `[auth.sms.test_otp]`)

Native talks PostgREST directly (`/rest/v1/<table>`), calls RPCs at
`/rest/v1/rpc/<fn>` (`heartbeat`, `open_incident`, `add_incident_event`,
`resolve_incident`, `accept_invite`) and edge functions at `/functions/v1/<fn>`:

| Function | Auth | Request → response |
|---|---|---|
| `POST /push` | user JWT (group member) | `{ incidentId, kind, title, body, recipients?, critical?, data? }` → `{ recipients, sent, results }` |
| `POST /unlock` | user JWT | `{ incidentId }` → `201 { requestId }`; `409` wrong level / fewer than 3 active members, `403` not a member, `404` missing |
| `GET /unlock?requestId=` | user JWT | `{ requestId, status, approvals, threshold, fulfilled, remaining, members, enabled }` (`enabled` = ≥ 3 active members) |
| `GET /config` | none | `{ version, toml, signature }` + `ETag` / `Cache-Control` (`?version=v1` pins) |
| `POST /watchdog` | service key / `CRON_SECRET` | `{ incidentIds? }` → `{ opened, pushed }` |
| `POST /proximity` | service key / `CRON_SECRET` | → `{ groups, updated }` |
| `POST /purge` | service key / `CRON_SECRET` | → `{ purged: { location_blobs, proximity_tokens, released_keys } }` |

Friends' screens subscribe via Realtime to `incidents`, `incident_events`,
`location_blobs`, `presence`, `released_keys`, `unlock_requests`,
`unlock_approvals` (all in the `supabase_realtime` publication; RLS applies).
Group-mates read coarse device state from the `device_status` view, never from
`devices` (push tokens stay private).

## Telemetry channel (CONTRACTS §7)

Live ticks travel over a **private Realtime broadcast channel**, topic
`telemetry:{subjectUserId}`, event `tick`. No table, no rows. Access is
Supabase Realtime authorization = RLS on `realtime.messages`
(`migrations/0010_telemetry_channel.sql`):

| Policy | Who | Rule |
|---|---|---|
| `telemetry_select` (subscribe) | authenticated | `extension = 'broadcast'`, topic is exactly `telemetry:<uuid>` and the uuid is `auth.uid()` or `shares_group_with(uuid)` |
| `telemetry_insert` (publish) | authenticated | `extension = 'broadcast'` and `topic = 'telemetry:' || auth.uid()` |

`public.telemetry_topic_subject(text)` does the parsing: it regex-checks the
canonical uuid form *before* casting, so garbage topics yield `null` instead of
a cast error. The policies are created inside an `if exists realtime.messages`
guard, so the migration is a no-op on bare postgres (pgTAP run).

Publish. Android native keeps **one WebSocket** open (Phoenix serializer v2, the
same frames realtime-js sends) and pushes a `tick` broadcast 10 times a second
(CONTRACTS §7). The REST endpoint still works for a one-off check from curl:

```sh
curl -i -X POST "$SUPABASE_URL/realtime/v1/api/broadcast" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d '{"messages":[{"topic":"telemetry:'"$USER_ID"'","event":"tick","private":true,"payload":{"v":2,"t":1,"seq":1,"user":"'"$USER_ID"'","accel":[],"gyro":[],"st":0,"sampleHz":0,"incidents":[],"incidentCount":0,"events":[]}}]}'
# HTTP/2 202
```

Over the socket the same authorisation applies: the join carries the user JWT,
`telemetry_select` decides the join, `telemetry_insert` each pushed message.
With `broadcast.self = true` the server echoes an authorised message back to
the sender, which the phone uses as its round-trip probe (`rttMs`).

Subscribe (web monitor, supabase-js v2):

```ts
const supabase = createClient(url, anonKey, { accessToken: async () => userJwt });
await supabase.realtime.setAuth(userJwt);
supabase
  .channel(`telemetry:${subjectId}`, { config: { private: true, broadcast: { ack: false } } })
  .on('broadcast', { event: 'tick' }, ({ payload }) => render(payload as TelemetryTick))
  .subscribe((status, err) => console.log(status, err?.message));
// SUBSCRIBED            -> you are the subject or an active group-mate
// CHANNEL_ERROR          -> "Unauthorized: You do not have permissions to read from this Channel topic: ..."
```

**The REST endpoint always answers 202**, even when the caller may not write
to that topic: Realtime validates the batch, then evaluates `telemetry_insert`
per message and silently drops unauthorized ones (logged server-side as
`UnauthorizedBroadcast`). Do not use the status code as proof of delivery;
verify with a subscriber. Verified against the hosted project with two
anonymous users A and B (no shared group):

| Step | Result |
|---|---|
| A `POST /realtime/v1/api/broadcast` to `telemetry:A` | 202, delivered to A's subscriber socket |
| B `POST` to `telemetry:A` | 202, **not** delivered (dropped by `telemetry_insert`) |
| B subscribes to `telemetry:A` | `CHANNEL_ERROR` Unauthorized |
| B subscribes to `telemetry:B`, A to `telemetry:A` | `SUBSCRIBED` |
| anon key only (no user JWT) `POST` to `telemetry:A` | 202, not delivered |

A client does not receive its own websocket `channel.send()` unless the channel
is created with `broadcast: { self: true }`; REST publishes are delivered to
every subscriber socket, including other sessions of the subject.

## Deploy

```sh
npx supabase@latest login
npx supabase@latest link --project-ref <ref>
npx supabase@latest db push                       # migrations
npx supabase@latest secrets set --env-file .env.production
npx supabase@latest functions deploy push unlock config
npx supabase@latest functions deploy watchdog proximity purge --no-verify-jwt
```

Then replace `model_configs.v1` with the signed `core/config/model-v1.toml`:

```sql
update public.model_configs set toml = $toml$...$toml$, signature = '<base64 ed25519 sig>' where version = 'v1';
```

## Access model (short)

- `profiles`: self + anyone sharing a group (incl. pending invites).
- `devices`: only self; group-mates get `device_status` (heartbeat, night_mode, battery, status, public keys).
- `groups`/`group_members`: members read; owner invites/removes; invitee accepts (`accept_invite`) or deletes own row; anyone can leave.
- `epochs`/`key_shares`: subject writes; recipient reads own share.
- `location_blobs`: subject inserts; group-mates read; nobody updates/deletes (purge is a definer fn).
- `proximity_tokens`: insert only; no user can read any (service role only).
- `incidents`: subject opens/escalates; members read; `resolve_incident` for subject + members.
- `unlock_requests`: created **only** by `open_unlock_request()`, which requires an open `offline`/`battery_dying` incident, membership, not the subject, and ≥ 3 active members (v1.1).
- `unlock_approvals`: approver inserts while request is open; requester/approver read.
- `audit_log`: written only by definer triggers (released_keys, unlock_requests/approvals, ring/en_route/called_*/found/release/call_option events); subject + group-mates read.
- `model_configs`: public read, service write.
