# safe — passive night-out safety app

Monorepo: pnpm workspace (apps/, tools/) + Cargo workspace (core/). See PLAN.md for the full design.

## Layout
- `core/crates/safety-core` — pure Rust: signal, baseline, hmm, escalation, crypto, proximity, typing. No I/O, no platform deps.
- `core/crates/safety-ffi` — uniffi proc-macro bindings over safety-core (`SafetyEngine` object).
- `core/crates/sim` — CLI replaying trace files (CSV/JSON) through the pipeline.
- `core/config/model-v1.toml` — HMM params + thresholds.
- `apps/mobile` — Expo (expo-router, TS). UI only; no detection logic in JS.
- `apps/mobile/modules/safety-native` — Expo module: `ios/*.swift`, `android/**/*.kt`.
- `supabase/` — migrations, RLS, edge functions (Deno), pgTAP tests.

## Rules
- All detection logic lives in Rust + native, never JS.
- Server only ever sees ciphertext, tokens, coarse status.
- Commands: `cargo test --manifest-path core/Cargo.toml`, `pnpm -r typecheck`, `cd supabase && deno test --allow-all functions`.
