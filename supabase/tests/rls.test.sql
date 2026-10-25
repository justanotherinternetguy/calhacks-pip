-- pgTAP: RLS + RPC guarantees. Run with `npx supabase test db` or
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/rls.test.sql
-- Everything runs inside one transaction and is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(48);

-- ------------------------------------------------------------ fixtures
-- alice = subject (group owner), bob + carol = active group-mates, dave = outsider
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@test.local', '{}', '{"display_name":"Alice"}', now(), now()),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@test.local',   '{}', '{"display_name":"Bob"}',   now(), now()),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol@test.local', '{}', '{"display_name":"Carol"}', now(), now()),
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave@test.local',  '{}', '{"display_name":"Dave"}',  now(), now()),
  ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin@test.local',  '{}', '{"display_name":"Erin"}',  now(), now()),
  ('00000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank@test.local', '{}', '{"display_name":"Frank"}', now(), now());

insert into public.groups (id, name, owner_id, threshold_k)
values ('11111111-1111-1111-1111-111111111111', 'crew', '00000000-0000-0000-0000-00000000000a', 2);
-- owner trigger made alice active; invite bob + carol, mark active
insert into public.group_members (group_id, user_id, status, invited_by) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000b', 'active', '00000000-0000-0000-0000-00000000000a'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000c', 'active', '00000000-0000-0000-0000-00000000000a');

-- a 2-member group (v1.1 §6: too small for a fallback unlock): erin = subject/owner, frank = only friend
insert into public.groups (id, name, owner_id, threshold_k)
values ('11111111-1111-1111-1111-111111111112', 'duo', '00000000-0000-0000-0000-00000000000e', 2);
insert into public.group_members (group_id, user_id, status, invited_by) values
  ('11111111-1111-1111-1111-111111111112', '00000000-0000-0000-0000-00000000000f', 'active', '00000000-0000-0000-0000-00000000000e');

insert into public.devices (id, user_id, platform, push_token, push_kind, night_mode, battery_pct, last_heartbeat) values
  ('22222222-2222-2222-2222-22222222222a', '00000000-0000-0000-0000-00000000000a', 'ios',     'tok-alice', 'apns', false, 80, now() - interval '1 hour'),
  ('22222222-2222-2222-2222-22222222222b', '00000000-0000-0000-0000-00000000000b', 'android', 'tok-bob',   'fcm',  false, 50, now() - interval '1 hour');

insert into public.epochs (id, user_id, group_id, day, k, n)
values ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', current_date, 2, 3);

insert into public.location_blobs (user_id, epoch_id, hour_index, seq, ciphertext)
values ('00000000-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 1, 1, 'Y2lwaGVydGV4dA==');

insert into public.proximity_tokens (user_id, group_id, tokens)
values ('00000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', array['dG9r']);

-- an ordinary escalation incident (not offline) for alice
insert into public.incidents (id, user_id, group_id, level, summary)
values ('44444444-4444-4444-4444-444444444441', '00000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'heads_up', 'gait drift');
-- an offline incident for erin in the 2-member group
insert into public.incidents (id, user_id, group_id, level, summary)
values ('44444444-4444-4444-4444-444444444442', '00000000-0000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111112', 'offline', 'heartbeat stale');

-- helper: impersonate a user through PostgREST-style claims
create or replace function pg_temp.login(uid uuid) returns void language plpgsql as $$
begin
  execute format('set local role authenticated');
  execute format('set local request.jwt.claim.sub = %L', uid);
  execute format('set local request.jwt.claims = %L', json_build_object('sub', uid, 'role', 'authenticated')::text);
end $$;

-- ------------------------------------------------------------ 1. location_blobs visibility
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select is((select count(*) from public.location_blobs), 0::bigint, 'non-member cannot read location_blobs');
select is((select count(*) from public.device_status where user_id = '00000000-0000-0000-0000-00000000000a'), 0::bigint,
          'non-member cannot see subject in device_status');
select is((select count(*) from public.incidents), 0::bigint, 'non-member cannot read incidents');
reset role;

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is((select count(*) from public.location_blobs), 1::bigint, 'group-mate can read location_blobs');
select is((select count(*) from public.devices where user_id = '00000000-0000-0000-0000-00000000000a'), 0::bigint,
          'group-mate cannot read the subject''s raw devices row (push token, keys)');
select is((select battery_pct from public.device_status where user_id = '00000000-0000-0000-0000-00000000000a'), 80,
          'group-mate sees coarse device_status');
select is((select count(*) from public.proximity_tokens), 0::bigint,
          'proximity tokens are never readable by users, not even their own');
reset role;

-- ------------------------------------------------------------ 2. fallback unlock gate
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select throws_ok(
  $$select public.open_unlock_request('44444444-4444-4444-4444-444444444441')$$,
  'P0001', null, 'open_unlock_request raises when incident is not offline/battery_dying');
select throws_ok(
  $$select public.open_unlock_request('44444444-4444-4444-4444-444444444449')$$,
  'P0002', null, 'open_unlock_request raises for a missing incident');
select throws_ok(
  $$insert into public.unlock_requests (incident_id, requester_id, status)
    values ('44444444-4444-4444-4444-444444444441', '00000000-0000-0000-0000-00000000000b', 'open')$$,
  '42501', null, 'users cannot insert unlock_requests directly');
reset role;

-- v1.1: a group with fewer than 3 active members cannot do a fallback unlock, even for an offline incident
select pg_temp.login('00000000-0000-0000-0000-00000000000f');
select throws_ok(
  $$select public.open_unlock_request('44444444-4444-4444-4444-444444444442')$$,
  'P0001', 'fallback unlock needs at least 3 active members',
  'open_unlock_request raises for a 2-member group in an offline incident');
reset role;

-- watchdog opens an offline incident for alice once her heartbeat is stale
update public.devices set night_mode = true, last_heartbeat = now() - interval '11 minutes'
 where user_id = '00000000-0000-0000-0000-00000000000a';
select is((select count(*) from public.watchdog_tick()), 1::bigint, 'watchdog_tick opens one offline incident');
select is((select count(*) from public.watchdog_tick()), 0::bigint, 'watchdog_tick is idempotent');
select is((select level from public.incidents where user_id = '00000000-0000-0000-0000-00000000000a' and resolved_at is null and level = 'offline'),
          'offline', 'offline incident exists');
-- stash the id where RLS cannot hide it from the impersonated users below
create temp table fx as select id as offline_id from public.incidents
  where level = 'offline' and user_id = '00000000-0000-0000-0000-00000000000a';
grant select on pg_temp.fx to authenticated;

select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select throws_ok(
  $$select public.open_unlock_request((select offline_id from pg_temp.fx))$$,
  '42501', null, 'non-member cannot open an unlock request');
reset role;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select throws_ok(
  $$select public.open_unlock_request((select offline_id from pg_temp.fx))$$,
  '42501', null, 'subject cannot request their own fallback unlock');
reset role;

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select lives_ok(
  $$select public.open_unlock_request((select offline_id from pg_temp.fx))$$,
  'group-mate can open an unlock request during an offline incident');
select is((select count(*) from public.unlock_requests where requester_id = '00000000-0000-0000-0000-00000000000b' and status = 'open'),
          1::bigint, 'unlock request row exists');
reset role;

-- carol approves, alice (subject) sees it in the audit log, dave does not
select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select lives_ok(
  $$insert into public.unlock_approvals (request_id, approver_id, sealed_share, approver_ed25519_pub)
    values ((select id from public.unlock_requests limit 1), '00000000-0000-0000-0000-00000000000c', 'c2VhbGVk', 'cHVi')$$,
  'group-mate can approve an open request');
reset role;

select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select is((select count(*) from public.audit_log where kind in ('unlock_requested', 'unlock_approved')), 2::bigint,
          'subject sees unlock request + approval in audit_log');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select is((select count(*) from public.audit_log), 0::bigint, 'outsider sees no audit_log rows');
reset role;

-- v1.1: 'call_option' is a valid incident_events.kind and is audited
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select lives_ok(
  $$select public.add_incident_event('44444444-4444-4444-4444-444444444441', 'call_option', '{"target":"campus"}'::jsonb)$$,
  'group-mate can log a call_option event');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select is((select count(*) from public.audit_log where kind = 'call_option'), 1::bigint,
          'subject sees the call_option event in audit_log');
reset role;

-- escalation: 'escalated' / 'location_requested' (friends, audited) and 'check_answered' (the subject, not audited)
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select lives_ok(
  $$select public.add_incident_event('44444444-4444-4444-4444-444444444441', 'escalated', '{}'::jsonb)$$,
  'group-mate can log an escalated event');
select lives_ok(
  $$select public.add_incident_event('44444444-4444-4444-4444-444444444441', 'location_requested', '{}'::jsonb)$$,
  'group-mate can log a location_requested event');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select lives_ok(
  $$select public.add_incident_event('44444444-4444-4444-4444-444444444441', 'check_answered', '{"verified":true}'::jsonb)$$,
  'subject can log a check_answered event');
select is((select count(*) from public.audit_log where kind in ('escalated', 'location_requested')), 2::bigint,
          'subject sees escalated and location_requested in audit_log');
select is((select count(*) from public.audit_log where kind = 'check_answered'), 0::bigint,
          'check_answered is not audited');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select throws_ok(
  $$select public.add_incident_event('44444444-4444-4444-4444-444444444441', 'location_requested', '{}'::jsonb)$$,
  '42501', null, 'outsider cannot request a location');
reset role;

-- ------------------------------------------------------------ 3. no decrypt anywhere
select is(
  (select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.proname ilike '%decrypt%'
     and n.nspname not in ('pg_catalog', 'information_schema')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),
  0::bigint, 'no non-extension function named like %decrypt% exists (server never holds plaintext)');

-- ------------------------------------------------------------ 4. heartbeat scope
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select lives_ok($$select public.heartbeat(true, 42, 2, 'check')$$, 'heartbeat runs for the caller');
select is((select battery_pct from public.devices where id = '22222222-2222-2222-2222-22222222222a'), 42,
          'heartbeat updated the caller''s device');
select is((select count(*) from public.devices where id = '22222222-2222-2222-2222-22222222222b'), 0::bigint,
          'caller cannot even see another user''s device');
reset role;
select is((select battery_pct from public.devices where id = '22222222-2222-2222-2222-22222222222b'), 50,
          'heartbeat left the other user''s device untouched');

-- ------------------------------------------------------------ 5. telemetry topic parsing (0010)
-- The realtime.messages policies cannot run on bare postgres (no realtime
-- schema); the parser they rely on can.
select is(public.telemetry_topic_subject('telemetry:00000000-0000-0000-0000-00000000000a'),
          '00000000-0000-0000-0000-00000000000a'::uuid, 'telemetry topic yields the subject uuid');
select is(public.telemetry_topic_subject('telemetry:------------------------------------'), null::uuid,
          '36 dash-only chars is not a uuid: null, no cast error');
select is(public.telemetry_topic_subject('telemetry:00000000-0000-0000-0000-00000000000a-x'), null::uuid,
          'trailing garbage is rejected');
select is(public.telemetry_topic_subject('telemetry:00000000-0000-0000-0000-00000000000A'), null::uuid,
          'uppercase uuid is rejected (topics are built from auth.uid()::text, always lowercase)');
select is(public.telemetry_topic_subject('incidents'), null::uuid, 'unrelated topic yields null');
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select lives_ok($$select public.telemetry_topic_subject('telemetry:zzz')$$,
                'authenticated role may execute the parser (policies call it)');
reset role;

-- ------------------------------------------------------------ 6. purge_incidents (0014)
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select throws_ok($$select public.purge_incidents('00000000-0000-0000-0000-00000000000a')$$,
                 '42501', null, 'outsider cannot purge another user''s incidents');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select throws_ok($$select public.purge_incidents('00000000-0000-0000-0000-00000000000e')$$,
                 '42501', null, 'cannot purge a user from a group you are not in');
select is(public.purge_incidents('00000000-0000-0000-0000-00000000000a'), 2,
          'group-mate purges both of the subject''s incidents');
reset role;
select is((select count(*) from public.incidents where user_id = '00000000-0000-0000-0000-00000000000a'), 0::bigint,
          'the subject''s incidents are gone');
select is((select count(*) from public.incident_events e left join public.incidents i on i.id = e.incident_id where i.id is null)
          + (select count(*) from public.unlock_requests r left join public.incidents i on i.id = r.incident_id where i.id is null),
          0::bigint, 'events and unlock requests went with them (cascade)');
select ok((select count(*) from public.audit_log where subject_user_id = '00000000-0000-0000-0000-00000000000a') > 0,
          'a group-mate''s purge keeps the subject''s audit log');
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select is(public.purge_incidents('00000000-0000-0000-0000-00000000000a'), 0, 'subject purge with nothing left deletes 0 incidents');
select is((select count(*) from public.audit_log where payload ? 'incident_id'), 0::bigint,
          'the subject''s own purge clears their incident audit rows');
reset role;

select * from finish();
rollback;
