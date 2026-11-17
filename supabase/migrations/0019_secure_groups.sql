-- 0019_secure_groups.sql — membership only by consent, invites only in person (docs/CONTRACTS.md §6).
--
-- Before: group_members_self_update let any user move their own row into any group and set it 'active';
-- group_members_owner_update let an owner force anyone to 'active'; profiles leaked to 'invited' rows.
-- After:
--   * No direct INSERT / UPDATE on group_members for clients. Joining happens only by redeeming a
--     single-use, 10-minute invite token that an active member shows as a QR (in person).
--   * Rows are always 'active' (the 'invited' state is gone).
--   * Profiles are visible to yourself and active group-mates only.
--   * group_members + group_invites are in the realtime publication so phones re-key on a change.

-- ------------------------------------------------------------ membership rows
drop policy if exists group_members_owner_insert on public.group_members;
drop policy if exists group_members_owner_update on public.group_members;
drop policy if exists group_members_self_update on public.group_members;
drop policy if exists group_members_delete on public.group_members;
revoke insert, update on public.group_members from authenticated, anon;

-- Leftover invites from the old flow never got consent through a scan: drop them.
delete from public.group_members where status <> 'active';
alter table public.group_members alter column status set default 'active';
alter table public.group_members drop constraint if exists group_members_status_check;
alter table public.group_members add constraint group_members_status_check check (status = 'active');

-- Leaving (your own row) and removal (by the owner) stay plain deletes; leave_group() below also hands the
-- group over when the owner leaves.
create policy group_members_delete on public.group_members for delete to authenticated
  using (user_id = auth.uid() or public.is_group_owner(group_id));

-- The old accept flow is gone.
drop function if exists public.accept_invite(uuid);

-- ------------------------------------------------------------ profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_group_with(id));

-- ------------------------------------------------------------ invites
create table public.group_invites (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  inviter_id  uuid not null references auth.users(id) on delete cascade,
  token_hash  bytea not null unique,         -- sha256(token); the token itself is never stored
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes',
  used_by     uuid references auth.users(id) on delete set null,
  used_at     timestamptz
);
create index group_invites_inviter_idx on public.group_invites (inviter_id, created_at desc);
alter table public.group_invites enable row level security;
-- The inviter watches their own invite (to confirm the joiner's fingerprint); the joiner sees the one they used.
create policy group_invites_select on public.group_invites for select to authenticated
  using (inviter_id = auth.uid() or used_by = auth.uid());
revoke insert, update, delete on public.group_invites from authenticated, anon;

/** Most members a group may have (bounds push fan-out and share sealing). */
create or replace function public.max_group_members() returns int language sql immutable as $$ select 12 $$;

-- Any active member may invite. Returns the token once; only its hash is kept.
create or replace function public.create_group_invite(p_group uuid)
returns table (invite_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t text;
  r public.group_invites;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.is_group_member(p_group) then
    raise exception 'not a member of this group' using errcode = '42501';
  end if;
  if (select count(*) from public.group_members gm where gm.group_id = p_group) >= public.max_group_members() then
    raise exception 'this group is full' using errcode = 'P0001';
  end if;
  -- Housekeeping + a cap on open invites per person.
  delete from public.group_invites gi where gi.expires_at < now() - interval '1 day';
  if (select count(*) from public.group_invites gi
       where gi.inviter_id = auth.uid() and gi.used_at is null and gi.expires_at > now()) >= 5 then
    raise exception 'too many open invites; wait a few minutes' using errcode = 'P0001';
  end if;
  t := encode(gen_random_bytes(32), 'hex');
  insert into public.group_invites (group_id, inviter_id, token_hash)
  values (p_group, auth.uid(), digest(t, 'sha256'))
  returning * into r;
  invite_id := r.id; token := t; expires_at := r.expires_at;
  return next;
end $$;
revoke execute on function public.create_group_invite(uuid) from public, anon;
grant execute on function public.create_group_invite(uuid) to authenticated;

-- The joiner scanned the inviter's QR in person. Single use, unexpired, inviter still a member.
-- Every failure is the same error so a guessed token tells nothing.
create or replace function public.redeem_group_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  inv public.group_invites;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into inv from public.group_invites gi
   where gi.token_hash = digest(coalesce(p_token, ''), 'sha256')
   for update;
  if not found or inv.used_at is not null or inv.expires_at <= now()
     or inv.inviter_id = auth.uid()
     or not exists (select 1 from public.group_members gm
                     where gm.group_id = inv.group_id and gm.user_id = inv.inviter_id and gm.status = 'active') then
    raise exception 'invite invalid or expired' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.group_members gm where gm.group_id = inv.group_id and gm.user_id = auth.uid()) then
    raise exception 'you are already in this group' using errcode = 'P0001';
  end if;
  if (select count(*) from public.group_members gm where gm.group_id = inv.group_id) >= public.max_group_members() then
    raise exception 'this group is full' using errcode = 'P0001';
  end if;
  update public.group_invites set used_by = auth.uid(), used_at = now() where id = inv.id;
  insert into public.group_members (group_id, user_id, status, invited_by)
  values (inv.group_id, auth.uid(), 'active', inv.inviter_id);
  return inv.group_id;
end $$;
revoke execute on function public.redeem_group_invite(text) from public, anon;
grant execute on function public.redeem_group_invite(text) to authenticated;

-- The owner removes anyone; the inviter may undo their own invite within an hour (the fingerprint did not match).
create or replace function public.remove_member(p_group uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_user = auth.uid() then
    perform public.leave_group(p_group);
    return;
  end if;
  if not (public.is_group_owner(p_group) or exists (
        select 1 from public.group_invites gi
         where gi.group_id = p_group and gi.inviter_id = auth.uid() and gi.used_by = p_user
           and gi.used_at > now() - interval '1 hour')) then
    raise exception 'only the owner can remove members' using errcode = '42501';
  end if;
  if exists (select 1 from public.groups g where g.id = p_group and g.owner_id = p_user) then
    raise exception 'the owner cannot be removed' using errcode = '42501';
  end if;
  delete from public.group_members gm where gm.group_id = p_group and gm.user_id = p_user;
end $$;
revoke execute on function public.remove_member(uuid, uuid) from public, anon;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

-- Leave a group. An owner hands it to the longest-standing member; the last one out deletes it.
create or replace function public.leave_group(p_group uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  heir uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from public.group_members gm where gm.group_id = p_group and gm.user_id = auth.uid();
  if not found then return; end if;
  if exists (select 1 from public.groups g where g.id = p_group and g.owner_id = auth.uid()) then
    select gm.user_id into heir from public.group_members gm
     where gm.group_id = p_group order by gm.created_at, gm.user_id limit 1;
    if heir is null then
      delete from public.groups g where g.id = p_group;
    else
      update public.groups g set owner_id = heir where g.id = p_group;
    end if;
  end if;
end $$;
revoke execute on function public.leave_group(uuid) from public, anon;
grant execute on function public.leave_group(uuid) to authenticated;

-- ------------------------------------------------------------ realtime
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_members') then
    alter publication supabase_realtime add table public.group_members;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'group_invites') then
    alter publication supabase_realtime add table public.group_invites;
  end if;
end $$;
-- DELETE events must carry group_id so the remaining members can react.
alter table public.group_members replica identity full;
