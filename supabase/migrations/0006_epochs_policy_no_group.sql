-- Allow a subject to open an epoch with no group (see 0005).
drop policy if exists epochs_insert on public.epochs;
create policy epochs_insert on public.epochs for insert to authenticated
  with check (user_id = auth.uid() and (group_id is null or public.is_group_member(group_id)));
