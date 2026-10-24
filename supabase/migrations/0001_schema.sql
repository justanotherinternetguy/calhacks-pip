-- 0001_schema.sql — tables from docs/CONTRACTS.md §3.
-- The server only ever stores ciphertext (b64 text), proximity tokens and
-- coarse status. There is deliberately no decrypt function anywhere.

create extension if not exists pgcrypto with schema extensions;
do $$ begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron unavailable: %', sqlerrm;
end $$;
do $$ begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net unavailable: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  phone         text,
  created_at    timestamptz not null default now()
);

-- Auto-create a profile row when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- to_jsonb(new) because auth.users gains its `phone` column from GoTrue's
  -- own migrations, which may not have run on a bare database yet.
  insert into public.profiles (id, display_name, phone)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'display_name', ''),
          to_jsonb(new) ->> 'phone')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------- devices
create table public.devices (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  platform        text not null check (platform in ('ios','android')),
  push_token      text,
  push_kind       text check (push_kind in ('apns','fcm')),
  x25519_pub      text,
  ed25519_pub     text,
  last_heartbeat  timestamptz,
  night_mode      boolean not null default false,
  battery_pct     int check (battery_pct between 0 and 100),
  risk_band       int not null default 0 check (risk_band between 0 and 3),
  status_level    text not null default 'idle'
                  check (status_level in ('idle','check','heads_up','unlocked','snatch','resolved')),
  created_at      timestamptz not null default now()
);
create index devices_user_id_idx on public.devices (user_id);
-- v1: one active device per user.
create unique index devices_one_per_user on public.devices (user_id);
create index devices_night_watch_idx on public.devices (last_heartbeat) where night_mode;

-- ------------------------------------------------------------------ groups
create table public.groups (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null default '',
  owner_id              uuid not null references auth.users(id) on delete cascade,
  threshold_k           int not null default 2 check (threshold_k >= 2),
  campus_safety_number  text,
  created_at            timestamptz not null default now()
);
create index groups_owner_id_idx on public.groups (owner_id);

create table public.group_members (
  group_id    uuid not null references public.groups(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  status      text not null default 'invited' check (status in ('invited','active')),
  invited_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_id_idx on public.group_members (user_id);

-- ------------------------------------------------------------------ epochs
create table public.epochs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  group_id    uuid not null references public.groups(id) on delete cascade,
  day         date not null,
  k           int not null check (k >= 2),
  n           int not null check (n >= k),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index epochs_user_group_idx on public.epochs (user_id, group_id, day desc);

create table public.key_shares (
  id                  uuid primary key default gen_random_uuid(),
  epoch_id            uuid not null references public.epochs(id) on delete cascade,
  recipient_user_id   uuid not null references auth.users(id) on delete cascade,
  share_index         int not null check (share_index between 1 and 255),
  sealed              text not null,
  sender_ed25519_pub  text not null,
  created_at          timestamptz not null default now(),
  unique (epoch_id, recipient_user_id)
);
create index key_shares_recipient_idx on public.key_shares (recipient_user_id);

-- --------------------------------------------------------- location_blobs
create table public.location_blobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  epoch_id    uuid not null references public.epochs(id) on delete cascade,
  hour_index  int not null check (hour_index >= 0), -- floor(unix_ms / 3_600_000), UTC-absolute (CONTRACTS §5)
  seq         bigint not null,
  ciphertext  text not null,
  created_at  timestamptz not null default now(),
  unique (user_id, epoch_id, seq)
);
create index location_blobs_user_created_idx on public.location_blobs (user_id, created_at desc);
create index location_blobs_created_idx on public.location_blobs (created_at);

-- -------------------------------------------------------- proximity_tokens
create table public.proximity_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  group_id    uuid not null references public.groups(id) on delete cascade,
  tokens      text[] not null,
  created_at  timestamptz not null default now()
);
create index proximity_tokens_group_created_idx on public.proximity_tokens (group_id, created_at desc);
create index proximity_tokens_created_idx on public.proximity_tokens (created_at);

create table public.presence (
  group_id    uuid not null references public.groups(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  together    boolean not null,
  updated_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- --------------------------------------------------------------- incidents
create table public.incidents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  group_id     uuid not null references public.groups(id) on delete cascade,
  level        text not null check (level in
                 ('check','heads_up','unlocked','snatch','offline','battery_dying','sos','resolved')),
  summary      text not null default '',
  opened_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index incidents_group_resolved_idx on public.incidents (group_id, resolved_at);
create index incidents_user_open_idx on public.incidents (user_id) where resolved_at is null;

create table public.incident_events (
  id           uuid primary key default gen_random_uuid(),
  incident_id  uuid not null references public.incidents(id) on delete cascade,
  actor_id     uuid references auth.users(id) on delete set null,
  kind         text not null check (kind in
                 ('nudge','heads_up','release','ring','en_route','called_911','called_campus',
                  'found','resolved','unlock_requested','unlock_approved','phone_offline','battery_dying')),
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index incident_events_incident_idx on public.incident_events (incident_id, created_at);

-- ----------------------------------------------------------- released_keys
create table public.released_keys (
  id                  uuid primary key default gen_random_uuid(),
  incident_id         uuid not null references public.incidents(id) on delete cascade,
  subject_user_id     uuid not null references auth.users(id) on delete cascade,
  recipient_user_id   uuid not null references auth.users(id) on delete cascade,
  epoch_id            uuid not null references public.epochs(id) on delete cascade,
  hour_index          int not null check (hour_index >= 0), -- UTC-absolute hour number (CONTRACTS §5)
  sealed              text not null,
  sender_ed25519_pub  text not null,
  created_at          timestamptz not null default now()
);
create index released_keys_recipient_idx on public.released_keys (recipient_user_id, created_at desc);
create index released_keys_incident_idx on public.released_keys (incident_id);

-- --------------------------------------------------------- unlock_requests
create table public.unlock_requests (
  id            uuid primary key default gen_random_uuid(),
  incident_id   uuid not null references public.incidents(id) on delete cascade,
  requester_id  uuid not null references auth.users(id) on delete cascade,
  epoch_id      uuid references public.epochs(id) on delete set null,
  status        text not null default 'open' check (status in ('open','fulfilled','denied')),
  created_at    timestamptz not null default now()
);
create index unlock_requests_incident_idx on public.unlock_requests (incident_id);

create table public.unlock_approvals (
  id                    uuid primary key default gen_random_uuid(),
  request_id            uuid not null references public.unlock_requests(id) on delete cascade,
  approver_id           uuid not null references auth.users(id) on delete cascade,
  sealed_share          text not null,
  approver_ed25519_pub  text not null,
  created_at            timestamptz not null default now(),
  unique (request_id, approver_id)
);

-- --------------------------------------------------------------- audit_log
create table public.audit_log (
  id               uuid primary key default gen_random_uuid(),
  subject_user_id  uuid not null references auth.users(id) on delete cascade,
  actor_id         uuid references auth.users(id) on delete set null,
  kind             text not null,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index audit_log_subject_idx on public.audit_log (subject_user_id, created_at desc);

-- ----------------------------------------------------------- model_configs
create table public.model_configs (
  version     text primary key,
  toml        text not null,
  signature   text not null,
  created_at  timestamptz not null default now()
);
