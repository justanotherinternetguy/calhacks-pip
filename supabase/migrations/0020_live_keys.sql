-- 0020_live_keys.sql — encrypted live location for the friends' map (docs/CONTRACTS.md §7).
--
-- Telemetry used to carry the phone's position in plaintext. Now each phone holds a random 32-byte "live key",
-- seals it (HPKE + Ed25519 signature, the same sealed-box format as key_shares) to every pinned friend, and
-- sends only `locEnc` (XChaCha20-Poly1305 under that key) over telemetry. The server stores the sealed copies
-- below and never sees the key or a position.
--
-- A phone rotates its live key daily and whenever a friend leaves, so an ex-member cannot read new positions.

create table public.live_keys (
  owner_id      uuid not null references auth.users(id) on delete cascade,
  key_id        text not null check (key_id ~ '^[0-9a-f]{16}$'),
  recipient_id  uuid not null references auth.users(id) on delete cascade,
  sealed        text not null,               -- b64 sealed box, opened only on the recipient's phone
  created_at    timestamptz not null default now(),
  primary key (owner_id, key_id, recipient_id)
);
create index live_keys_recipient_idx on public.live_keys (recipient_id, created_at desc);
alter table public.live_keys enable row level security;

create policy live_keys_select on public.live_keys for select to authenticated
  using (owner_id = auth.uid() or (recipient_id = auth.uid() and public.shares_group_with(owner_id)));
create policy live_keys_insert on public.live_keys for insert to authenticated
  with check (owner_id = auth.uid() and recipient_id <> auth.uid() and public.shares_group_with(recipient_id));
create policy live_keys_delete on public.live_keys for delete to authenticated
  using (owner_id = auth.uid());
revoke update on public.live_keys from authenticated, anon;

-- A friend's phone fetches new keys as they appear.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'live_keys') then
    alter publication supabase_realtime add table public.live_keys;
  end if;
end $$;
