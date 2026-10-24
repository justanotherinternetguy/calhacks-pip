//! safety-core: passive night-out safety detection engine (pure Rust, no I/O).
//!
//! Pipeline: 50 Hz motion → `signal` (gait / impact / placement / snatch) →
//! `baseline` z-scores → `hmm` forward filter (once a minute + on impact) →
//! `escalation` state machine → `EngineEvent`s. `Engine::tick` drives everything.
pub mod baseline;
pub mod config;
pub mod engine;
pub mod escalation;
pub mod hmm;
pub mod signal;
pub mod synth;
pub mod types;
pub mod typing;

pub use config::Config;
pub use engine::Engine;
pub use types::*;
