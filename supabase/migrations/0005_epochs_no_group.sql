-- A subject with no group (or fewer than 2 friends) still rotates a day key and uploads encrypted
-- location blobs (nobody can open them yet). Such epochs carry k = 0 / n < 2 and no group.
alter table public.epochs alter column group_id drop not null;
alter table public.epochs drop constraint if exists epochs_k_check;
alter table public.epochs drop constraint if exists epochs_n_check;
alter table public.epochs add constraint epochs_k_check check (k >= 0);
alter table public.epochs add constraint epochs_n_check check (n >= 0);
alter table public.epochs add constraint epochs_shares_check
  check ((k = 0 and n < 2) or (k >= 2 and n >= k));
