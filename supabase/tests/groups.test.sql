-- pgTAP: group membership by in-person invite only, check-ins, live keys (0019-0021).
-- Run with `npx supabase test db` or
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/groups.test.sql
-- Uses psql \gset to carry invite tokens between statements. Everything is rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(44);

-- alice = owner of crew, bob + carol = members, dave + erin = outsiders
insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@test.local', '{}', '{"display_name":"Alice"}', now(), now()),
  ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@test.local',   '{}', '{"display_name":"Bob"}',   now(), now()),
  ('00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol@test.local', '{}', '{"display_name":"Carol"}', now(), now()),
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave@test.local',  '{}', '{"display_name":"Dave"}',  now(), now()),
  ('00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin@test.local',  '{}', '{"display_name":"Erin"}',  now(), now());

insert into public.groups (id, name, owner_id) values ('11111111-1111-1111-1111-111111111111', 'crew', '00000000-0000-0000-0000-00000000000a');
insert into public.groups (id, name, owner_id) values ('11111111-1111-1111-1111-111111111112', 'erins', '00000000-0000-0000-0000-00000000000e');
insert into public.group_members (group_id, user_id, status, invited_by, created_at) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000b', 'active', '00000000-0000-0000-0000-00000000000a', now() + interval '1 second'),
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000c', 'active', '00000000-0000-0000-0000-00000000000a', now() + interval '2 seconds');
insert into public.devices (id, user_id, platform, battery_pct) values
  ('22222222-2222-2222-2222-22222222222a', '00000000-0000-0000-0000-00000000000a', 'android', 77);

create or replace function pg_temp.login(uid uuid) returns void language plpgsql as $$
begin
  execute format('set local role authenticated');
  execute format('set local request.jwt.claim.sub = %L', uid);
  execute format('set local request.jwt.claims = %L', json_build_object('sub', uid, 'role', 'authenticated')::text);
end $$;

-- ------------------------------------------------------------ 1. no self-service membership
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select throws_ok($$insert into public.group_members (group_id, user_id, status) values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000d', 'active')$$,
                 '42501', null, 'outsider cannot insert themselves into a group');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000e');
select throws_ok($$update public.group_members set group_id = '11111111-1111-1111-1111-111111111111' where user_id = '00000000-0000-0000-0000-00000000000e'$$,
                 '42501', null, 'a member cannot move their own row into another group');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select throws_ok($$update public.group_members set status = 'active' where group_id = '11111111-1111-1111-1111-111111111111'$$,
                 '42501', null, 'the owner cannot rewrite membership rows');
select throws_ok($$insert into public.group_members (group_id, user_id) values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000d')$$,
                 '42501', null, 'the owner cannot add someone without their consent');
reset role;
select throws_ok($$insert into public.group_members (group_id, user_id, status) values ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000d', 'invited')$$,
                 '23514', null, 'the invited state no longer exists');

-- ------------------------------------------------------------ 2. profiles: active group-mates only
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select is((select count(*) from public.profiles where id <> '00000000-0000-0000-0000-00000000000d'), 0::bigint, 'outsider reads no other profile');
select throws_ok($$select * from public.create_group_invite('11111111-1111-1111-1111-111111111111')$$,
                 '42501', null, 'outsider cannot create an invite');
select throws_ok($$select public.redeem_group_invite('00')$$, 'P0002', 'invite invalid or expired', 'a made-up token is rejected');
reset role;

-- ------------------------------------------------------------ 3. invite → redeem (single use)
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select token as bob_token, invite_id as bob_invite from public.create_group_invite('11111111-1111-1111-1111-111111111111') \gset
reset role;
select is((select count(*) from public.group_invites where token_hash = digest(:'bob_token', 'sha256')), 1::bigint, 'only the token hash is stored');
select is((select count(*) from public.group_invites gi where encode(gi.token_hash, 'hex') = :'bob_token'), 0::bigint, 'the token itself is not stored');

select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select is((select count(*) from public.group_invites), 0::bigint, 'outsider sees no invites before redeeming');
select is(public.redeem_group_invite(:'bob_token'), '11111111-1111-1111-1111-111111111111'::uuid, 'dave joins by redeeming bob''s token');
select is((select status from public.group_members where group_id = '11111111-1111-1111-1111-111111111111' and user_id = '00000000-0000-0000-0000-00000000000d'), 'active', 'dave is active');
select is((select invited_by from public.group_members where group_id = '11111111-1111-1111-1111-111111111111' and user_id = '00000000-0000-0000-0000-00000000000d'), '00000000-0000-0000-0000-00000000000b'::uuid, 'the inviter is recorded');
select is((select count(*) from public.profiles where id = '00000000-0000-0000-0000-00000000000a'), 1::bigint, 'after joining, dave sees the owner''s profile');
select is((select battery_pct from public.device_status where user_id = '00000000-0000-0000-0000-00000000000a'), 77, 'after joining, dave sees coarse device status');
reset role;

select pg_temp.login('00000000-0000-0000-0000-00000000000e');
select throws_ok(format('select public.redeem_group_invite(%L)', :'bob_token'), 'P0002', 'invite invalid or expired', 'a used token cannot be redeemed again');
reset role;

select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is((select used_by from public.group_invites where id = :'bob_invite'), '00000000-0000-0000-0000-00000000000d'::uuid, 'the inviter sees who used their invite');
reset role;

-- expired
select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select token as carol_token from public.create_group_invite('11111111-1111-1111-1111-111111111111') \gset
reset role;
update public.group_invites set expires_at = now() - interval '1 second' where token_hash = digest(:'carol_token', 'sha256');
select pg_temp.login('00000000-0000-0000-0000-00000000000e');
select throws_ok(format('select public.redeem_group_invite(%L)', :'carol_token'), 'P0002', 'invite invalid or expired', 'an expired token is rejected');
reset role;

-- ------------------------------------------------------------ 4. removal
select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select throws_ok($$select public.remove_member('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000d')$$,
                 '42501', null, 'a member who did not invite dave cannot remove him');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select lives_ok($$select public.remove_member('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000d')$$,
                'the inviter can undo their invite (fingerprint mismatch)');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000d');
select is((select count(*) from public.device_status where user_id = '00000000-0000-0000-0000-00000000000a'), 0::bigint, 'a removed member loses device status');
select is((select count(*) from public.profiles where id = '00000000-0000-0000-0000-00000000000a'), 0::bigint, 'a removed member loses profiles');
reset role;

-- ------------------------------------------------------------ 5. check-ins
select pg_temp.login('00000000-0000-0000-0000-00000000000e');
select throws_ok($$select public.ask_check_in('00000000-0000-0000-0000-00000000000a')$$, '42501', null, 'cannot check in on someone outside your groups');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select (public.ask_check_in('00000000-0000-0000-0000-00000000000a')).id as ci1 \gset
select is((public.ask_check_in('00000000-0000-0000-0000-00000000000a')).id, :'ci1'::uuid, 'asking again while pending returns the same check-in');
select throws_ok($$select public.ask_check_in('00000000-0000-0000-0000-00000000000b')$$, 'P0001', null, 'cannot check in on yourself');
select throws_ok(format('select public.answer_check_in(%L, ''ok'')', :'ci1'), 'P0002', null, 'the asker cannot answer for the target');
select throws_ok($$insert into public.check_ins (asker_id, target_id, group_id) values ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111')$$,
                 '42501', null, 'no direct writes to check_ins');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select is((select count(*) from public.check_ins where id = :'ci1'), 1::bigint, 'a group-mate sees the check-in');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000e');
select is((select count(*) from public.check_ins), 0::bigint, 'an outsider sees no check-ins');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select is((public.answer_check_in(:'ci1', 'ok')).status, 'ok', 'the target answers ok');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select throws_ok($$select public.ask_check_in('00000000-0000-0000-0000-00000000000a')$$, 'P0001', null, 'cooldown between questions to the same friend');
reset role;

-- missed → incident for the group; a late ok closes it
select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select (public.ask_check_in('00000000-0000-0000-0000-00000000000a')).id as ci2 \gset
reset role;
update public.check_ins set deadline_at = now() - interval '1 second' where id = :'ci2';
select is((select count(*) from public.check_in_tick() where level = 'missed_check_in' and user_id = '00000000-0000-0000-0000-00000000000a'), 1::bigint,
          'the watchdog opens a missed_check_in incident');
select is((select status from public.check_ins where id = :'ci2'), 'missed', 'the check-in is marked missed');
select is((select count(*) from public.check_in_tick()), 0::bigint, 'a second tick opens nothing new');
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is((select count(*) from public.incidents where level = 'missed_check_in'), 1::bigint, 'group-mates see the missed incident');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select is((public.answer_check_in(:'ci2', 'ok')).status, 'ok', 'a late ok still counts');
reset role;
select is((select level from public.incidents i join public.check_ins c on c.incident_id = i.id where c.id = :'ci2'), 'resolved', 'and resolves the missed incident');

-- ------------------------------------------------------------ 6. live keys
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select lives_ok($$insert into public.live_keys (owner_id, key_id, recipient_id, sealed) values ('00000000-0000-0000-0000-00000000000a', '0123456789abcdef', '00000000-0000-0000-0000-00000000000b', 'c2VhbGVk')$$,
                'a member seals their live key to a group-mate');
select throws_ok($$insert into public.live_keys (owner_id, key_id, recipient_id, sealed) values ('00000000-0000-0000-0000-00000000000a', '0123456789abcdef', '00000000-0000-0000-0000-00000000000e', 'c2VhbGVk')$$,
                 '42501', null, 'cannot seal a live key to an outsider');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000b');
select is((select count(*) from public.live_keys), 1::bigint, 'the recipient reads their sealed key');
reset role;
select pg_temp.login('00000000-0000-0000-0000-00000000000c');
select is((select count(*) from public.live_keys), 0::bigint, 'nobody else reads it');
reset role;

-- ------------------------------------------------------------ 7. owner leaves → hand-over
select pg_temp.login('00000000-0000-0000-0000-00000000000a');
select lives_ok($$select public.leave_group('11111111-1111-1111-1111-111111111111')$$, 'the owner can leave');
reset role;
select is((select owner_id from public.groups where id = '11111111-1111-1111-1111-111111111111'), '00000000-0000-0000-0000-00000000000b'::uuid,
          'the longest-standing member becomes owner');

select * from finish();
rollback;
