//! Escrow and proximity cryptography for the safe night-out app (PLAN.md §5).
//!
//! Modules:
//! - [`identity`]  — per-device X25519 (HPKE) + Ed25519 (signing) keys and the QR fingerprint.
//! - [`epoch`]     — random daily root key `K_day` and HKDF-derived hourly keys `K_h`.
//! - [`shamir`]    — k-of-n Shamir secret sharing over GF(256) for escrowing `K_day`.
//! - [`sealed`]    — HPKE base-mode seal + Ed25519 signature, used for shares and released keys.
//! - [`location`]  — XChaCha20-Poly1305 encryption of location samples under `K_h`.
//! - [`proximity`] — geohash-7 HMAC tokens for server-blind "together / separated".

pub mod epoch;
pub mod identity;
pub mod location;
pub mod proximity;
pub mod sealed;
pub mod shamir;

use zeroize::{Zeroize, ZeroizeOnDrop};

/// The single error type of this crate, mirrored 1:1 by the FFI layer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CryptoError {
    #[error("{msg}")]
    Failed { msg: String },
}

impl CryptoError {
    pub fn new(msg: impl Into<String>) -> Self {
        CryptoError::Failed { msg: msg.into() }
    }
}

pub type Result<T> = core::result::Result<T, CryptoError>;

/// 32 secret bytes that are wiped from memory when dropped.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct Secret32(pub [u8; 32]);

impl Secret32 {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl From<[u8; 32]> for Secret32 {
    fn from(b: [u8; 32]) -> Self {
        Secret32(b)
    }
}

impl core::fmt::Debug for Secret32 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Secret32(<redacted>)")
    }
}

/// Fill a fixed-size array from the OS CSPRNG.
pub(crate) fn random_array<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("OS CSPRNG unavailable");
    out
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret32_zeroizes_on_drop() {
        fn assert_zod<T: ZeroizeOnDrop>() {}
        assert_zod::<Secret32>();
        let mut s = Secret32([0xAB; 32]);
        s.zeroize();
        assert_eq!(s.0, [0u8; 32]);
        // Drop in place and inspect the bytes left behind (plain u8 array, no invalid states).
        let mut slot = core::mem::ManuallyDrop::new(Secret32([0xCD; 32]));
        unsafe { core::mem::ManuallyDrop::drop(&mut slot) };
        let leftover: [u8; 32] = unsafe { core::ptr::read_volatile(&slot.0) };
        assert_eq!(leftover, [0u8; 32]);
    }

    #[test]
    fn error_display_is_message() {
        assert_eq!(CryptoError::new("boom").to_string(), "boom");
    }
}
