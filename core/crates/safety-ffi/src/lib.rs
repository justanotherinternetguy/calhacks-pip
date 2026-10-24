//! uniffi surface over safety-core (detection engine) and safety-crypto (escrow/proximity).
//! `engine.rs` is owned by the detection work; `crypto.rs` by the crypto work.
uniffi::setup_scaffolding!("safety");

pub mod crypto;
pub mod engine;
