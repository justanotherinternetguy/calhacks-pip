-- 0002_rls.sql — row level security on every table + helper predicates.
-- Rules of thumb:
--   * group-mates (active members of a shared group) can read coarse state
--   * only the subject writes their own ciphertext
--   * the service role (edge functions, cron) bypasses RLS; nothing here
--     ever lets anyone decrypt anything, because nothing here can.

-- ------------------------------------------------------------ helpers
-- Security definer so policies on group_members can use them without
-- recursing into group_members' own policies.

create or replace function public.is_group_member(gid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = gid and gm.user_id = auth.uid() and gm.status = 'active'
  );
$$;

create or replace function public.has_group_row(gid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = gid and gm.user_id = auth.uid()
  );
$$;

create or replace function public.is_group_owner(gid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.groups g where g.id = gid and g.owner_id = auth.uid());
$$;

create or replace function public.shares_group_with(uid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.group_members me
    join public.group_members them on them.group_id = me.group_id
    where me.user_id = auth.uid() and me.status = 'active'
      and them.user_id = uid and them.status = 'active'
  );
$$;

create or replace function public.owns_epoch(eid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.epochs e where e.id = eid and e.user_id = auth.uid());
$$;

-- subject of the incident, or an active member of the incident's group
create or replace function public.is_incident_participant(iid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.incidents i
    where i.id = iid
      and (i.user_id = auth.uid() or public.is_group_member(i.group_id))
  );
$$;

create or replace function public.incident_subject(iid uuid)
returns uuid
language sql stable security definer
set search_path = public
as $$
  select i.user_id from public.incidents i where i.id = iid;
$$;

-- ------------------------------------------------------------ enable RLS
alter table public.profiles          enable row level security;
alter table public.devices           enable row level security;
alter table public.groups            enable row level security;
alter table public.group_members     enable row level security;
alter table public.epochs            enable row level security;
alter table public.key_shares        enable row level security;
alter table public.location_blobs    enable row level security;
alter table public.proximity_tokens  enable row level security;
alter table public.presence          enable row level security;
alter table public.incidents         enable row level security;
alter table public.incident_events   enable row level security;
alter table public.released_keys     enable row level security;
alter table public.unlock_requests   enable row level security;
alter table public.unlock_approvals  enable row level security;
alter table public.audit_log         enable row level security;
alter table public.model_configs     enable row level security;

-- ------------------------------------------------------------ grants
-- Explicit, so this also works on a bare postgres without Supabase's
-- default privileges.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke all on public.audit_log from authenticated;
grant select on public.audit_log to authenticated;
revoke all on public.model_configs from authenticated;
grant select on public.model_configs to anon, authenticated;
-- unlock_requests rows are created only through open_unlock_request()
revoke insert on public.unlock_requests from authenticated;
-- presence is written only by the proximity edge function
revoke insert, update, delete on public.presence from authenticated;
-- nobody edits location history; purge runs as a definer function
revoke update, delete on public.location_blobs from authenticated;
revoke update, delete on public.proximity_tokens from authenticated;
revoke update, delete on public.incident_events from authenticated;
revoke update, delete on public.unlock_approvals from authenticated;

-- ------------------------------------------------------------ profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_group_with(id)
         -- invitees and inviters can see each other's names
         or exists (select 1 from public.group_members a
                    join public.group_members b on a.group_id = b.group_id
                    where a.user_id = auth.uid() and b.user_id = profiles.id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ------------------------------------------------------------ devices
-- Self: everything. Group-mates: only the coarse view below.
create policy devices_self_select on public.devices for select to authenticated
  using (user_id = auth.uid());
create policy devices_self_insert on public.devices for insert to authenticated
  with check (user_id = auth.uid());
create policy devices_self_update on public.devices for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy devices_self_delete on public.devices for delete to authenticated
  using (user_id = auth.uid());

-- Coarse status for group-mates (no push token, no keys). Runs as the view
-- owner, so the WHERE clause is the access check.
create or replace view public.device_status
  with (security_invoker = false, security_barrier = true)
as
  select d.id as device_id, d.user_id, d.platform, d.last_heartbeat, d.night_mode,
         d.battery_pct, d.risk_band, d.status_level, d.x25519_pub, d.ed25519_pub
  from public.devices d
  where d.user_id = auth.uid() or public.shares_group_with(d.user_id);
grant select on public.device_status to authenticated;

-- ------------------------------------------------------------ groups
create policy groups_select on public.groups for select to authenticated
  using (owner_id = auth.uid() or public.has_group_row(id));
create policy groups_insert on public.groups for insert to authenticated
  with check (owner_id = auth.uid());
create policy groups_update on public.groups for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy groups_delete on public.groups for delete to authenticated
  using (owner_id = auth.uid());

-- The owner is an active member of their own group from the start.
create or replace function public.add_owner_membership()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.group_members (group_id, user_id, status, invited_by)
  values (new.id, new.owner_id, 'active', new.owner_id)
  on conflict (group_id, user_id) do update set status = 'active';
  return new;
end $$;
create trigger groups_add_owner after insert on public.groups
  for each row execute function public.add_owner_membership();

-- ------------------------------------------------------------ group_members
create policy group_members_select on public.group_members for select to authenticated
  using (user_id = auth.uid() or public.is_group_member(group_id));
-- owner invites
create policy group_members_owner_insert on public.group_members for insert to authenticated
  with check (public.is_group_owner(group_id) and status = 'invited' and invited_by = auth.uid());
-- owner may change rows (e.g. demote), invited user may accept their own row
create policy group_members_owner_update on public.group_members for update to authenticated
  using (public.is_group_owner(group_id)) with check (public.is_group_owner(group_id));
create policy group_members_self_update on public.group_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- owner removes, member leaves / declines
create policy group_members_delete on public.group_members for delete to authenticated
  using (user_id = auth.uid() or public.is_group_owner(group_id));

-- ------------------------------------------------------------ epochs / key_shares
create policy epochs_select on public.epochs for select to authenticated
  using (user_id = auth.uid() or public.is_group_member(group_id));
create policy epochs_insert on public.epochs for insert to authenticated
  with check (user_id = auth.uid() and public.is_group_member(group_id));
create policy epochs_update on public.epochs for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy epochs_delete on public.epochs for delete to authenticated
  using (user_id = auth.uid());

create policy key_shares_select on public.key_shares for select to authenticated
  using (recipient_user_id = auth.uid() or public.owns_epoch(epoch_id));
create policy key_shares_insert on public.key_shares for insert to authenticated
  with check (public.owns_epoch(epoch_id));
create policy key_shares_delete on public.key_shares for delete to authenticated
  using (public.owns_epoch(epoch_id));

-- ------------------------------------------------------------ location_blobs
create policy location_blobs_select on public.location_blobs for select to authenticated
  using (user_id = auth.uid() or public.shares_group_with(user_id));
create policy location_blobs_insert on public.location_blobs for insert to authenticated
  with check (user_id = auth.uid() and public.owns_epoch(epoch_id));
-- no update / delete policies on purpose

-- ------------------------------------------------------------ proximity_tokens / presence
create policy proximity_tokens_insert on public.proximity_tokens for insert to authenticated
  with check (user_id = auth.uid() and public.is_group_member(group_id));
-- no select policy: only the service role (proximity function) reads tokens

create policy presence_select on public.presence for select to authenticated
  using (public.is_group_member(group_id));

-- ------------------------------------------------------------ incidents / events
create policy incidents_select on public.incidents for select to authenticated
  using (user_id = auth.uid() or public.is_group_member(group_id));
create policy incidents_insert on public.incidents for insert to authenticated
  with check (user_id = auth.uid() and public.is_group_member(group_id));
-- the subject's phone may escalate its own incident; members resolve via resolve_incident()
create policy incidents_subject_update on public.incidents for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy incident_events_select on public.incident_events for select to authenticated
  using (public.is_incident_participant(incident_id));
create policy incident_events_insert on public.incident_events for insert to authenticated
  with check (actor_id = auth.uid() and public.is_incident_participant(incident_id));

-- ------------------------------------------------------------ released_keys
create policy released_keys_select on public.released_keys for select to authenticated
  using (recipient_user_id = auth.uid() or subject_user_id = auth.uid());
create policy released_keys_insert on public.released_keys for insert to authenticated
  with check (subject_user_id = auth.uid() and public.owns_epoch(epoch_id)
              and public.is_incident_participant(incident_id));

-- ------------------------------------------------------------ unlock_requests / approvals
-- Visible to the whole group + subject: every unlock is seen by everyone.
create policy unlock_requests_select on public.unlock_requests for select to authenticated
  using (requester_id = auth.uid() or public.is_incident_participant(incident_id));
-- insert only through open_unlock_request() (insert privilege revoked above)
create policy unlock_requests_requester_update on public.unlock_requests for update to authenticated
  using (requester_id = auth.uid()) with check (requester_id = auth.uid());

create policy unlock_approvals_select on public.unlock_approvals for select to authenticated
  using (approver_id = auth.uid()
         or exists (select 1 from public.unlock_requests r
                    where r.id = request_id and r.requester_id = auth.uid()));
create policy unlock_approvals_insert on public.unlock_approvals for insert to authenticated
  with check (
    approver_id = auth.uid()
    and exists (
      select 1 from public.unlock_requests r
      where r.id = request_id
        and r.status = 'open'
        and r.requester_id <> auth.uid()
        and public.is_incident_participant(r.incident_id)
    )
  );

-- ------------------------------------------------------------ audit_log
create policy audit_log_select on public.audit_log for select to authenticated
  using (subject_user_id = auth.uid() or public.shares_group_with(subject_user_id));
-- inserts only via the definer triggers below

-- ------------------------------------------------------------ model_configs
create policy model_configs_public_read on public.model_configs for select to anon, authenticated
  using (true);
-- writes: service role only

-- ------------------------------------------------------------ audit triggers
create or replace function public.audit_released_key()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.audit_log (subject_user_id, actor_id, kind, payload)
  values (new.subject_user_id, new.subject_user_id, 'key_released',
          jsonb_build_object('incident_id', new.incident_id, 'recipient', new.recipient_user_id,
                             'epoch_id', new.epoch_id, 'hour_index', new.hour_index));
  return new;
end $$;
create trigger released_keys_audit after insert on public.released_keys
  for each row execute function public.audit_released_key();

create or replace function public.audit_unlock_request()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.audit_log (subject_user_id, actor_id, kind, payload)
  values (public.incident_subject(new.incident_id), new.requester_id, 'unlock_requested',
          jsonb_build_object('incident_id', new.incident_id, 'request_id', new.id, 'epoch_id', new.epoch_id));
  return new;
end $$;
create trigger unlock_requests_audit after insert on public.unlock_requests
  for each row execute function public.audit_unlock_request();

create or replace function public.audit_unlock_approval()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  req public.unlock_requests;
begin
  select * into req from public.unlock_requests where id = new.request_id;
  insert into public.audit_log (subject_user_id, actor_id, kind, payload)
  values (public.incident_subject(req.incident_id), new.approver_id, 'unlock_approved',
          jsonb_build_object('incident_id', req.incident_id, 'request_id', new.request_id,
                             'requester', req.requester_id));
  insert into public.incident_events (incident_id, actor_id, kind, payload)
  values (req.incident_id, new.approver_id, 'unlock_approved',
          jsonb_build_object('request_id', new.request_id));
  return new;
end $$;
create trigger unlock_approvals_audit after insert on public.unlock_approvals
  for each row execute function public.audit_unlock_approval();

create or replace function public.audit_incident_event()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.kind in ('ring', 'en_route', 'called_911', 'called_campus', 'found', 'release') then
    insert into public.audit_log (subject_user_id, actor_id, kind, payload)
    values (public.incident_subject(new.incident_id), new.actor_id, new.kind,
            jsonb_build_object('incident_id', new.incident_id, 'event_id', new.id) || coalesce(new.payload, '{}'::jsonb));
  end if;
  return new;
end $$;
create trigger incident_events_audit after insert on public.incident_events
  for each row execute function public.audit_incident_event();
