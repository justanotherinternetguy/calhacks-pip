-- 0003_functions.sql — RPCs, watchdog, purge, cron schedules, realtime.

-- ------------------------------------------------------------ heartbeat
-- Native calls this every 2 min in night mode (or PATCHes devices directly).
-- Security invoker: the devices_self_update policy scopes it to the caller.
create or replace function public.heartbeat(
  night_mode boolean,
  battery_pct int,
  risk_band int default 0,
  status_level text default 'idle'
)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.devices d
     set last_heartbeat = now(),
         night_mode     = heartbeat.night_mode,
         battery_pct    = heartbeat.battery_pct,
         risk_band      = coalesce(heartbeat.risk_band, d.risk_band),
         status_level   = coalesce(heartbeat.status_level, d.status_level)
   where d.user_id = auth.uid();
$$;

-- ------------------------------------------------------------ incidents
-- Maps an incident level to the event kind recorded when it is (re)opened.
create or replace function public.level_event_kind(level text)
returns text
language sql immutable
as $$
  select case level
    when 'check'         then 'nudge'
    when 'heads_up'      then 'heads_up'
    when 'unlocked'      then 'release'
    when 'offline'       then 'phone_offline'
    when 'battery_dying' then 'battery_dying'
    when 'resolved'      then 'resolved'
    else 'heads_up'                      -- snatch, sos
  end;
$$;

-- Subject opens (or escalates) an incident in one of their groups.
-- One open incident per (user, group) for the escalation ladder; returns its id.
create or replace function public.open_incident(group_id uuid, level text, summary text default '')
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_variable
declare
  iid uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.is_group_member(group_id) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;

  select i.id into iid
    from public.incidents i
   where i.user_id = auth.uid() and i.group_id = group_id and i.resolved_at is null
     and i.level not in ('offline', 'battery_dying')
   order by i.opened_at desc limit 1;

  if iid is null then
    insert into public.incidents (user_id, group_id, level, summary)
    values (auth.uid(), group_id, level, coalesce(summary, ''))
    returning id into iid;
  else
    update public.incidents i set level = level, summary = coalesce(summary, i.summary) where i.id = iid;
  end if;

  insert into public.incident_events (incident_id, actor_id, kind, payload)
  values (iid, auth.uid(), public.level_event_kind(level),
          jsonb_build_object('level', level, 'summary', summary));
  return iid;
end $$;

-- Subject or any active group member resolves.
create or replace function public.resolve_incident(incident_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.is_incident_participant(incident_id) then
    raise exception 'not a participant of this incident' using errcode = '42501';
  end if;
  update public.incidents i
     set resolved_at = now(), level = 'resolved'
   where i.id = incident_id and i.resolved_at is null;
  if not found then
    raise exception 'incident already resolved or missing' using errcode = 'P0002';
  end if;
  update public.unlock_requests r set status = 'denied'
   where r.incident_id = incident_id and r.status = 'open';
  insert into public.incident_events (incident_id, actor_id, kind, payload)
  values (incident_id, auth.uid(), 'resolved', '{}'::jsonb);
end $$;

create or replace function public.add_incident_event(incident_id uuid, kind text, payload jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_variable
declare
  eid uuid;
begin
  insert into public.incident_events (incident_id, actor_id, kind, payload)
  values (incident_id, auth.uid(), kind, coalesce(payload, '{}'::jsonb))
  returning id into eid;
  return eid;
end $$;

-- ------------------------------------------------------------ groups
create or replace function public.accept_invite(group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.group_members gm
     set status = 'active'
   where gm.group_id = group_id and gm.user_id = auth.uid() and gm.status = 'invited';
  if not found then
    raise exception 'no pending invite for this group' using errcode = 'P0002';
  end if;
end $$;

-- ------------------------------------------------------------ fallback unlock
-- The ONLY way an unlock_requests row is created. Allowed only while the
-- subject is in an open offline / battery_dying incident.
create or replace function public.open_unlock_request(incident_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  inc public.incidents;
  eid uuid;
  rid uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into inc from public.incidents i where i.id = incident_id;
  if inc.id is null then
    raise exception 'incident not found' using errcode = 'P0002';
  end if;
  if inc.user_id = auth.uid() then
    raise exception 'subject cannot request their own fallback unlock' using errcode = '42501';
  end if;
  if not public.is_group_member(inc.group_id) then
    raise exception 'not a member of this incident''s group' using errcode = '42501';
  end if;
  if inc.resolved_at is not null then
    raise exception 'incident is resolved' using errcode = 'P0001';
  end if;
  if inc.level not in ('offline', 'battery_dying') then
    raise exception 'fallback unlock requires an offline or battery_dying incident (level is %)', inc.level
      using errcode = 'P0001';
  end if;

  -- reuse an open request from the same requester
  select r.id into rid from public.unlock_requests r
   where r.incident_id = incident_id and r.requester_id = auth.uid() and r.status = 'open'
   limit 1;
  if rid is not null then
    return rid;
  end if;

  select e.id into eid from public.epochs e
   where e.user_id = inc.user_id and e.group_id = inc.group_id and e.active
   order by e.day desc, e.created_at desc limit 1;

  insert into public.unlock_requests (incident_id, requester_id, epoch_id, status)
  values (incident_id, auth.uid(), eid, 'open')
  returning id into rid;

  insert into public.incident_events (incident_id, actor_id, kind, payload)
  values (incident_id, auth.uid(), 'unlock_requested',
          jsonb_build_object('request_id', rid, 'epoch_id', eid));
  return rid;
end $$;

-- ------------------------------------------------------------ purge
create or replace function public.purge_old_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  n_blobs int; n_tokens int; n_keys int;
begin
  delete from public.location_blobs where created_at < now() - interval '6 hours';
  get diagnostics n_blobs = row_count;
  delete from public.proximity_tokens where created_at < now() - interval '15 minutes';
  get diagnostics n_tokens = row_count;
  delete from public.released_keys rk
   using public.incidents i
   where i.id = rk.incident_id and i.resolved_at is not null
     and i.resolved_at < now() - interval '24 hours';
  get diagnostics n_keys = row_count;
  return jsonb_build_object('location_blobs', n_blobs, 'proximity_tokens', n_tokens, 'released_keys', n_keys);
end $$;

-- ------------------------------------------------------------ watchdog
-- Opens offline / battery_dying incidents for night-mode devices.
-- Returns the incidents it opened so the edge function can push for them.
create or replace function public.watchdog_tick()
returns setof public.incidents
language plpgsql
security definer
set search_path = public
as $$
declare
  d record;
  g record;
  iid uuid;
begin
  -- 1. missed heartbeat > 10 min
  for d in
    select dv.user_id, dv.last_heartbeat
      from public.devices dv
     where dv.night_mode
       and dv.last_heartbeat is not null
       and dv.last_heartbeat < now() - interval '10 minutes'
  loop
    for g in
      select gm.group_id from public.group_members gm
       where gm.user_id = d.user_id and gm.status = 'active'
         and not exists (select 1 from public.incidents i
                          where i.user_id = d.user_id and i.group_id = gm.group_id
                            and i.level = 'offline' and i.resolved_at is null)
    loop
      insert into public.incidents (user_id, group_id, level, summary)
      values (d.user_id, g.group_id, 'offline',
              'phone went offline at ' || to_char(d.last_heartbeat at time zone 'UTC', 'HH24:MI') || ' UTC')
      returning id into iid;
      insert into public.incident_events (incident_id, actor_id, kind, payload)
      values (iid, null, 'phone_offline', jsonb_build_object('last_heartbeat', d.last_heartbeat));
      return query select * from public.incidents where id = iid;
    end loop;
  end loop;

  -- 2. battery <= 3% while still reporting
  for d in
    select dv.user_id, dv.battery_pct
      from public.devices dv
     where dv.night_mode
       and dv.battery_pct is not null and dv.battery_pct <= 3
       and dv.last_heartbeat >= now() - interval '10 minutes'
  loop
    for g in
      select gm.group_id from public.group_members gm
       where gm.user_id = d.user_id and gm.status = 'active'
         and not exists (select 1 from public.incidents i
                          where i.user_id = d.user_id and i.group_id = gm.group_id
                            and i.level = 'battery_dying' and i.resolved_at is null)
    loop
      insert into public.incidents (user_id, group_id, level, summary)
      values (d.user_id, g.group_id, 'battery_dying',
              'phone battery at ' || d.battery_pct || '%, about to die')
      returning id into iid;
      insert into public.incident_events (incident_id, actor_id, kind, payload)
      values (iid, null, 'battery_dying', jsonb_build_object('battery_pct', d.battery_pct));
      return query select * from public.incidents where id = iid;
    end loop;
  end loop;
  return;
end $$;

-- Calls an edge function with the service key via pg_net, if both pg_net and
-- the vault secrets `edge_url` + `service_role_key` exist. Otherwise no-op.
create or replace function public.call_edge_function(fn text, body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  url text; key text; req_id bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return null;
  end if;
  begin
    select decrypted_secret into url from vault.decrypted_secrets where name = 'edge_url' limit 1;
    select decrypted_secret into key from vault.decrypted_secrets where name = 'service_role_key' limit 1;
  exception when others then
    return null;
  end;
  if url is null or key is null then
    return null;
  end if;
  execute format(
    'select net.http_post(url := %L, body := %L::jsonb, headers := %L::jsonb, timeout_milliseconds := 8000)',
    rtrim(url, '/') || '/' || fn,
    body::text,
    jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key)::text
  ) into req_id;
  return req_id;
end $$;

-- What pg_cron runs every minute: open incidents, then hand the new ids to
-- the watchdog edge function for push fan-out.
create or replace function public.cron_watchdog()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into ids from public.watchdog_tick();
  if cardinality(ids) > 0 then
    perform public.call_edge_function('watchdog', jsonb_build_object('incidentIds', to_jsonb(ids)));
  end if;
  return cardinality(ids);
end $$;

-- ------------------------------------------------------------ privileges
revoke execute on function public.watchdog_tick() from public, anon, authenticated;
revoke execute on function public.cron_watchdog() from public, anon, authenticated;
revoke execute on function public.purge_old_data() from public, anon, authenticated;
revoke execute on function public.call_edge_function(text, jsonb) from public, anon, authenticated;
grant execute on function public.watchdog_tick() to service_role;
grant execute on function public.cron_watchdog() to service_role;
grant execute on function public.purge_old_data() to service_role;
revoke execute on function public.heartbeat(boolean, int, int, text) from anon;
revoke execute on function public.open_incident(uuid, text, text) from anon;
revoke execute on function public.resolve_incident(uuid) from anon;
revoke execute on function public.add_incident_event(uuid, text, jsonb) from anon;
revoke execute on function public.accept_invite(uuid) from anon;
revoke execute on function public.open_unlock_request(uuid) from anon;

-- ------------------------------------------------------------ pg_cron
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('safe-watchdog', '* * * * *', 'select public.cron_watchdog()');
    perform cron.schedule('safe-purge', '*/10 * * * *', 'select public.purge_old_data()');
  else
    raise notice 'pg_cron not installed; schedule watchdog/purge externally';
  end if;
end $$;

-- ------------------------------------------------------------ realtime
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
alter publication supabase_realtime add table
  public.incidents, public.incident_events, public.location_blobs, public.presence,
  public.released_keys, public.unlock_requests, public.unlock_approvals;
