//! safety-core: passive night-out safety detection engine (pure Rust, no I/O).
//!
//! Pipeline: motion (50 Hz + gyro, or ~10 Hz accel-only in low-rate mode), context and audio labels → `signal`
//! (gait / live metric bands / impact / placement / grab / drift / stumble) vs the personal `baseline` → rule-based
//! incidents (`engine`, each with a tier and a clearing rule) in the incident `log` → `escalation` state machine
//! (check-in on a Danger incident or two independent kinds of evidence) → `EngineEvent`s. `Engine::tick` drives
//! everything. There is no probability model.
pub mod baseline;
pub mod config;
pub mod engine;
pub mod escalation;
pub mod log;
pub mod signal;
pub mod synth;
pub mod types;
pub mod typing;

pub use config::Config;
pub use engine::Engine;
pub use types::*;
