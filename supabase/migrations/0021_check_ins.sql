-- 0021_check_ins.sql — friends check in on each other (docs/CONTRACTS.md §13).
--
-- A friend asks "You okay?" (ask_check_in). The target answers ok / help from a sticky notification
-- (answer_check_in). No answer by the deadline ⇒ the watchdog (check_in_tick) marks it missed and opens a
-- 'missed_check_in' incident in the shared group, so every friend gets the normal incident actions
-- (ring, call, I'm going, found safe). Only coarse status is stored: no location, no free text.

-- --------------------------------------------------------- incident levels / events
alter table public.incidents drop constraint if exists incidents_level_check;
alter table public.incidents add constraint incidents_level_check check (level in
  ('check','heads_up','unlocked','snatch','offline','battery_dying','sos','missed_check_in','resolved'));

alter table public.incident_events drop constraint if exists incident_events_kind_check;
alter table public.incident_events add constraint incident_events_kind_check check (kind in
  ('nudge','heads_up','release','ring','en_route','called_911','called_campus',
   'found','resolved','unlock_requested','unlock_approved','phone_offline','battery_dying',
   'call_option','escalated','location_requested','check_answered','check_in_missed'));

-- ----------------------------------------------------------------- check_ins
create table public.check_ins (
  id           uuid primary key default gen_random_uuid(),
  asker_id     uuid not null references auth.users(id) on delete cascade,
  target_id    uuid not null references auth.users(id) on delete cascade,
  group_id     uuid not null references public.groups(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','ok','help','missed','cancelled')),
  created_at   timestamptz not null default now(),
  deadline_at  timestamptz not null default now() + interval '10 minutes',
  answered_at  timestamptz,
  incident_id  uuid references public.incidents(id) on delete set null,
  check (asker_id <> target_id)
);
create index check_ins_target_idx on public.check_ins (target_id, created_at desc);
create index check_ins_pending_idx on public.check_ins (deadline_at) where status = 'pending';
-- one open question per pair at a time
create unique index check_ins_one_pending on public.check_ins (asker_id, target_id) where status = 'pending';

alter table public.check_ins enable row level security;
-- asker, target, and the target's group-mates (everyone who would be alerted on a miss)
create policy check_ins_select on public.check_ins for select to authenticated
  using (asker_id = auth.uid() or target_id = auth.uid() or public.shares_group_with(target_id));
revoke insert, update, delete on public.check_ins from authenticated, anon;

/** Minutes the target has to answer, and the per-pair cooldown between questions. */
create or replace function public.check_in_deadline() returns interval language sql immutable as $$ select interval '10 minutes' $$;
create or replace function public.check_in_cooldown() returns interval language sql immutable as $$ select interval '2 minutes' $$;

create or replace function public.ask_check_in(p_target uuid)
returns public.check_ins
language plpgsql
security definer
set search_path = public
as $$
declare
  gid uuid;
  r public.check_ins;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_target = auth.uid() then
    raise exception 'you cannot check in on yourself' using errcode = 'P0001';
  end if;
  -- a group both are active in (the oldest one, so it is stable)
  select me.group_id into gid
    from public.group_members me
    join public.group_members them on them.group_id = me.group_id
   where me.user_id = auth.uid() and them.user_id = p_target
     and me.status = 'active' and them.status = 'active'
   order by me.created_at
   limit 1;
  if gid is null then
    raise exception 'not in a group together' using errcode = '42501';
  end if;
  select * into r from public.check_ins c
   where c.asker_id = auth.uid() and c.target_id = p_target and c.status = 'pending';
  if found then
    return r; -- already waiting: idempotent
  end if;
  if exists (select 1 from public.check_ins c
              where c.asker_id = auth.uid() and c.target_id = p_target
                and c.created_at > now() - public.check_in_cooldown()) then
    raise exception 'you just asked; give them a minute' using errcode = 'P0001';
  end if;
  insert into public.check_ins (asker_id, target_id, group_id, deadline_at)
  values (auth.uid(), p_target, gid, now() + public.check_in_deadline())
  returning * into r;
  return r;
end $$;

-- The target answers. A late "ok" still counts and closes the missed-check-in incident it opened.
-- "help" is recorded here; the phone raises the SOS itself (location release lives on the phone).
create or replace function public.answer_check_in(p_id uuid, p_status text)
returns public.check_ins
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.check_ins;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_status not in ('ok', 'help') then
    raise exception 'status must be ok or help' using errcode = '22023';
  end if;
  select * into r from public.check_ins c where c.id = p_id for update;
  if not found or r.target_id <> auth.uid() then
    raise exception 'no such check-in' using errcode = 'P0002';
  end if;
  if r.status not in ('pending', 'missed') then
    return r; -- already answered or cancelled: idempotent (notification action + app can both send)
  end if;
  update public.check_ins c set status = p_status, answered_at = now() where c.id = p_id returning * into r;
  if p_status = 'ok' and r.incident_id is not null then
    update public.incidents i set resolved_at = now(), level = 'resolved'
     where i.id = r.incident_id and i.resolved_at is null and i.level = 'missed_check_in';
    if found then
      insert into public.incident_events (incident_id, actor_id, kind, payload)
      values (r.incident_id, auth.uid(), 'resolved', jsonb_build_object('check_in_id', r.id));
    end if;
  end if;
  return r;
end $$;

create or replace function public.cancel_check_in(p_id uuid)
returns public.check_ins
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.check_ins;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.check_ins c set status = 'cancelled', answered_at = now()
   where c.id = p_id and c.asker_id = auth.uid() and c.status = 'pending'
  returning * into r;
  if not found then
    raise exception 'no pending check-in to cancel' using errcode = 'P0002';
  end if;
  return r;
end $$;

-- Watchdog step: pending past the deadline ⇒ missed + an incident for the group (one open per target and group).
-- Returns only incidents it newly opened (those get pushed); a miss folded into an open one is not pushed again.
create or replace function public.check_in_tick()
returns setof public.incidents
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  iid uuid;
  asker_name text;
begin
  for c in
    update public.check_ins ci set status = 'missed'
     where ci.status = 'pending' and ci.deadline_at <= now()
    returning ci.*
  loop
    -- someone left the group since: nobody to alert there
    if (select count(*) from public.group_members gm
         where gm.group_id = c.group_id and gm.user_id in (c.asker_id, c.target_id) and gm.status = 'active') < 2 then
      update public.check_ins ci set status = 'cancelled' where ci.id = c.id;
      continue;
    end if;
    select i.id into iid from public.incidents i
     where i.user_id = c.target_id and i.group_id = c.group_id
       and i.level = 'missed_check_in' and i.resolved_at is null
     limit 1;
    if iid is null then
      select coalesce(nullif(trim(p.display_name), ''), 'A friend') into asker_name from public.profiles p where p.id = c.asker_id;
      insert into public.incidents (user_id, group_id, level, summary)
      values (c.target_id, c.group_id, 'missed_check_in', 'didn''t answer ' || coalesce(asker_name, 'a friend') || '''s check-in')
      returning id into iid;
      insert into public.incident_events (incident_id, actor_id, kind, payload)
      values (iid, c.asker_id, 'check_in_missed', jsonb_build_object('check_in_id', c.id));
      update public.check_ins ci set incident_id = iid where ci.id = c.id;
      return query select * from public.incidents where id = iid;
    else
      insert into public.incident_events (incident_id, actor_id, kind, payload)
      values (iid, c.asker_id, 'check_in_missed', jsonb_build_object('check_in_id', c.id));
      update public.check_ins ci set incident_id = iid where ci.id = c.id;
    end if;
  end loop;
  return;
end $$;

-- pg_cron runs this every minute: both ticks, then one edge call with the new incident ids.
create or replace function public.cron_watchdog()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into ids
    from (select id from public.watchdog_tick() union all select id from public.check_in_tick()) t;
  if cardinality(ids) > 0 then
    perform public.call_edge_function('watchdog', jsonb_build_object('incidentIds', to_jsonb(ids)));
  end if;
  return cardinality(ids);
end $$;

-- ---------------------------------------------------------------- privileges
revoke execute on function public.ask_check_in(uuid) from public, anon;
revoke execute on function public.answer_check_in(uuid, text) from public, anon;
revoke execute on function public.cancel_check_in(uuid) from public, anon;
revoke execute on function public.check_in_tick() from public, anon, authenticated;
revoke execute on function public.cron_watchdog() from public, anon, authenticated;
grant execute on function public.ask_check_in(uuid) to authenticated;
grant execute on function public.answer_check_in(uuid, text) to authenticated;
grant execute on function public.cancel_check_in(uuid) to authenticated;
grant execute on function public.check_in_tick() to service_role;
grant execute on function public.cron_watchdog() to service_role;

do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'check_ins') then
    alter publication supabase_realtime add table public.check_ins;
  end if;
end $$;

-- ---------------------------------------------------------- resolved ⇒ clear sticky alerts
-- When an incident resolves (any path: a friend's "found safe", the subject's "I'm safe", a late "ok"), the
-- watchdog function sends a silent push so every phone drops the sticky alert. No-op without pg_net + vault.
create or replace function public.notify_incident_resolved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.resolved_at is null and new.resolved_at is not null then
    perform public.call_edge_function('watchdog', jsonb_build_object('resolvedIds', jsonb_build_array(new.id)));
  end if;
  return new;
end $$;
revoke execute on function public.notify_incident_resolved() from public, anon, authenticated;
drop trigger if exists incidents_notify_resolved on public.incidents;
create trigger incidents_notify_resolved after update of resolved_at on public.incidents
  for each row execute function public.notify_incident_resolved();
