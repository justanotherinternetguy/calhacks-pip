-- purge_incidents(subject): deletes a member's incident history for good (the monitor's "Delete all" button).
--   * Deletes the subject's incidents the caller takes part in: the subject deletes all of theirs, a group-mate
--     deletes the ones in groups they share. The foreign keys cascade to incident_events, unlock_requests,
--     unlock_approvals and released_keys.
--   * The subject's audit_log rows about incidents go too, but only when the subject calls. A friend must not be
--     able to erase the record of who opened the subject's location.
-- Returns the number of incidents deleted.
create or replace function public.purge_incidents(subject uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if subject is distinct from auth.uid() and not public.shares_group_with(subject) then
    raise exception 'not a group-mate of this user' using errcode = '42501';
  end if;

  delete from public.incidents i
   where i.user_id = subject and public.is_incident_participant(i.id);
  get diagnostics n = row_count;

  if subject = auth.uid() then
    delete from public.audit_log a
     where a.subject_user_id = subject and a.payload ? 'incident_id';
  end if;
  return n;
end;
$$;

revoke execute on function public.purge_incidents(uuid) from public, anon;
grant execute on function public.purge_incidents(uuid) to authenticated;
