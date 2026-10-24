-- 0012_telemetry_command_channel.sql — private Realtime broadcast channel
-- `telemetry-cmd:{subjectUserId}`: commands from the web monitor to a phone (e.g. `{ cmd: "reset_incidents" }`).
--
-- Kept apart from `telemetry:{uid}` on purpose: realtime authorizes publishing per channel, not per event, so
-- letting group-mates publish on the telemetry channel would also let them forge sensor ticks.
--   * the subject and anyone sharing an active group with them may publish (send a command)
--   * only the subject may subscribe (their phone listens)
-- Accepted risk (product decision 2026-10-24): any group-mate can wipe a member's incident log and reset their
-- sensing. See docs/THREAT_MODEL.md.
--
-- Like 0010, a no-op on bare postgres (no realtime schema).

create or replace function public.telemetry_cmd_topic_subject(topic text)
returns uuid
language sql immutable
set search_path = public
as $$
  select case
    when topic ~ '^telemetry-cmd:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then substr(topic, length('telemetry-cmd:') + 1)::uuid
    else null
  end;
$$;
grant execute on function public.telemetry_cmd_topic_subject(text) to anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'realtime' and tablename = 'messages') then
    drop policy if exists telemetry_cmd_select on realtime.messages;
    drop policy if exists telemetry_cmd_insert on realtime.messages;

    -- subscribe: only the subject's own phone
    create policy telemetry_cmd_select on realtime.messages
      for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and public.telemetry_cmd_topic_subject(realtime.messages.topic) = (select auth.uid())
      );

    -- publish: the subject or a group-mate
    create policy telemetry_cmd_insert on realtime.messages
      for insert to authenticated
      with check (
        realtime.messages.extension = 'broadcast'
        and public.telemetry_cmd_topic_subject(realtime.messages.topic) is not null
        and (
          public.telemetry_cmd_topic_subject(realtime.messages.topic) = (select auth.uid())
          or public.shares_group_with(public.telemetry_cmd_topic_subject(realtime.messages.topic))
        )
      );
  end if;
end $$;
