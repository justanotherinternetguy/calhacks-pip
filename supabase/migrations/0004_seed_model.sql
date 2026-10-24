-- 0004_seed_model.sql — placeholder model config served by the `config` edge
-- function. Replace `toml` with core/config/model-v1.toml and sign it for prod.
insert into public.model_configs (version, toml, signature)
values (
  'v1',
  $toml$
# placeholder — mirrors core/config/model-v1.toml shape
version = "v1"

[hmm]
states = ["normal", "impaired", "incident", "unresponsive"]
step_seconds = 60

[thresholds]
check = 0.60
heads_up = 0.80
unlock = 0.95
check_timeout_seconds = 90
dismiss_cooldown_minutes = 30

[heartbeat]
interval_seconds = 120
offline_after_minutes = 10
battery_dying_pct = 3

[location]
min_interval_seconds = 60
max_interval_seconds = 300
retention_hours = 6

[proximity]
interval_seconds = 120
token_ttl_minutes = 15
$toml$,
  'unsigned-dev'
)
on conflict (version) do update
  set toml = excluded.toml, signature = excluded.signature;
