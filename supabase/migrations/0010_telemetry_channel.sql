-- 0010_telemetry_channel.sql — private Realtime broadcast channels
-- `telemetry:{subjectUserId}` (docs/CONTRACTS.md §7).
--
-- Realtime authorization: a *private* channel is gated by RLS on
-- realtime.messages. SELECT decides who may subscribe (join), INSERT decides
-- who may publish (websocket send or POST /realtime/v1/api/broadcast).
--   * subject + active group-mates may subscribe (read ticks)
--   * only the subject may publish to their own topic
-- No rows are ever stored; the policies are evaluated against a transient row.
--
-- The realtime schema only exists on a Supabase stack, so the policies are
-- created inside a guard and the migration is a no-op on bare postgres
-- (the pgTAP run in tests/rls.test.sql).

-- ------------------------------------------------------------ helper
-- Extracts the subject uuid from a topic name, or null when the topic is not
-- exactly `telemetry:<canonical lowercase uuid>`. The regex is checked
-- *before* the cast so garbage topics never raise.
create or replace function public.telemetry_topic_subject(topic text)
returns uuid
language sql immutable
set search_path = public
as $$
  select case
    when topic ~ '^telemetry:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then substr(topic, length('telemetry:') + 1)::uuid
    else null
  end;
$$;
grant execute on function public.telemetry_topic_subject(text) to anon, authenticated, service_role;

-- ------------------------------------------------------------ policies
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'realtime' and tablename = 'messages') then
    -- idempotent: re-running the migration (or a hand edit) replaces them
    drop policy if exists telemetry_select on realtime.messages;
    drop policy if exists telemetry_insert on realtime.messages;

    -- subscribe: the subject and anyone sharing an active group with them
    create policy telemetry_select on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and public.telemetry_topic_subject(realtime.messages.topic) is not null
        and (
          public.telemetry_topic_subject(realtime.messages.topic) = (select auth.uid())
          or public.shares_group_with(public.telemetry_topic_subject(realtime.messages.topic))
        )
      );

    -- publish: only the subject, only to their own topic
    create policy telemetry_insert on realtime.messages
      for insert to authenticated
      with check (
        realtime.messages.extension = 'broadcast'
        and (select auth.uid()) is not null
        and realtime.messages.topic = 'telemetry:' || (select auth.uid())::text
      );
  end if;
end $$;
