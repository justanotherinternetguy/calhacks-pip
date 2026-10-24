-- 0007_v11_groups.sql — spec v1.1 §6 "Groups" (docs/CONTRACTS.md).
--   * groups.threshold_k: default 2, never below 2 (0001 already had both; restated so it is explicit).
--   * incident_events.kind gains 'call_option' (10 min with no response → one-tap campus safety / 911).
--   * open_unlock_request(): fallback unlock additionally needs >= 3 active members in the group.
--   * audit_log trigger records 'call_option' events.
-- incidents.level is unchanged (grab detection reuses 'heads_up' + 'snatch').

-- ------------------------------------------------------------------ groups
update public.groups set threshold_k = 2 where threshold_k is null or threshold_k < 2;
alter table public.groups alter column threshold_k set default 2;
alter table public.groups alter column threshold_k set not null;
alter table public.groups drop constraint if exists groups_threshold_k_check;
alter table public.groups add constraint groups_threshold_k_check check (threshold_k >= 2);

-- --------------------------------------------------------- incident_events
alter table public.incident_events drop constraint if exists incident_events_kind_check;
alter table public.incident_events add constraint incident_events_kind_check check (kind in
  ('nudge','heads_up','release','ring','en_route','called_911','called_campus',
   'found','resolved','unlock_requested','unlock_approved','phone_offline','battery_dying',
   'call_option'));

-- ------------------------------------------------------ open_unlock_request
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
  members int;
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

  -- v1.1: k-of-n only makes sense with the subject + at least two friends (active members incl. subject)
  select count(*) into members from public.group_members gm
   where gm.group_id = inc.group_id and gm.status = 'active';
  if members < 3 then
    raise exception 'fallback unlock needs at least 3 active members' using errcode = 'P0001';
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

-- ----------------------------------------------------------- audit trigger
create or replace function public.audit_incident_event()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.kind in ('ring', 'en_route', 'called_911', 'called_campus', 'found', 'release', 'call_option') then
    insert into public.audit_log (subject_user_id, actor_id, kind, payload)
    values (public.incident_subject(new.incident_id), new.actor_id, new.kind,
            jsonb_build_object('incident_id', new.incident_id, 'event_id', new.id) || coalesce(new.payload, '{}'::jsonb));
  end if;
  return new;
end $$;
