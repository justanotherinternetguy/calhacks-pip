//! safety-core: passive night-out safety detection engine (pure Rust, no I/O).
//!
//! Pipeline: motion (50 Hz + gyro, or ~10 Hz accel-only in low-rate mode) → `signal` (gait / live
//! metric bands / impact / placement / grab / drift) → `baseline` bands + z-scores → incident `log`
//! (+ sequence agent) → `hmm` forward filter (once a minute + on impact) → `escalation` state
//! machine → `EngineEvent`s. `Engine::tick` drives everything.
pub mod baseline;
pub mod config;
pub mod engine;
pub mod escalation;
pub mod hmm;
pub mod log;
pub mod signal;
pub mod synth;
pub mod types;
pub mod typing;

pub use config::Config;
pub use engine::Engine;
pub use types::*;
