//! Location samples encrypted under the hourly key.
//!
//! Blob = `nonce (24 random bytes) || XChaCha20-Poly1305(K_h, nonce, encode(loc), aad)` where
//! `encode` is little-endian `lat: f64 || lng: f64 || accuracy_m: f32 || t_ms: u64` (28 bytes)
//! and `aad = "{user_id}|{epoch_id}|{seq}"`. Total blob length is 68 bytes.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};

use crate::{random_array, CryptoError, Result};

pub const NONCE_LEN: usize = 24;
pub const PLAIN_LEN: usize = 8 + 8 + 4 + 8;
pub const BLOB_LEN: usize = NONCE_LEN + PLAIN_LEN + 16;

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Location {
    pub lat: f64,
    pub lng: f64,
    pub accuracy_m: f32,
    pub t_ms: u64,
}

impl Location {
    pub fn encode(&self) -> [u8; PLAIN_LEN] {
        let mut out = [0u8; PLAIN_LEN];
        out[0..8].copy_from_slice(&self.lat.to_le_bytes());
        out[8..16].copy_from_slice(&self.lng.to_le_bytes());
        out[16..20].copy_from_slice(&self.accuracy_m.to_le_bytes());
        out[20..28].copy_from_slice(&self.t_ms.to_le_bytes());
        out
    }

    pub fn decode(b: &[u8]) -> Result<Self> {
        if b.len() != PLAIN_LEN {
            return Err(CryptoError::new("location: bad plaintext length"));
        }
        Ok(Location {
            lat: f64::from_le_bytes(b[0..8].try_into().unwrap()),
            lng: f64::from_le_bytes(b[8..16].try_into().unwrap()),
            accuracy_m: f32::from_le_bytes(b[16..20].try_into().unwrap()),
            t_ms: u64::from_le_bytes(b[20..28].try_into().unwrap()),
        })
    }
}

pub fn location_aad(user_id: &str, epoch_id: &str, seq: u64) -> Vec<u8> {
    format!("{user_id}|{epoch_id}|{seq}").into_bytes()
}

pub fn encrypt_location(hour_key: &[u8; 32], user_id: &str, epoch_id: &str, seq: u64, loc: &Location) -> Result<Vec<u8>> {
    let nonce = random_array::<NONCE_LEN>();
    let aad = location_aad(user_id, epoch_id, seq);
    let ct = XChaCha20Poly1305::new(hour_key.into())
        .encrypt(&XNonce::from(nonce), Payload { msg: &loc.encode(), aad: &aad })
        .map_err(|_| CryptoError::new("location: encrypt failed"))?;
    let mut out = Vec::with_capacity(BLOB_LEN);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt_location(hour_key: &[u8; 32], user_id: &str, epoch_id: &str, seq: u64, blob: &[u8]) -> Result<Location> {
    if blob.len() != BLOB_LEN {
        return Err(CryptoError::new(format!("location: blob must be {BLOB_LEN} bytes, got {}", blob.len())));
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let aad = location_aad(user_id, epoch_id, seq);
    let pt = XChaCha20Poly1305::new(hour_key.into())
        .decrypt(&XNonce::from(<[u8; NONCE_LEN]>::try_from(nonce).unwrap()), Payload { msg: ct, aad: &aad })
        .map_err(|_| CryptoError::new("location: decrypt failed (wrong key or AAD, or tampered)"))?;
    Location::decode(&pt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Location {
        Location { lat: 51.5007, lng: -0.1246, accuracy_m: 12.5, t_ms: 1_761_300_000_123 }
    }

    #[test]
    fn round_trip_and_fresh_nonces() {
        let key = [9u8; 32];
        let a = encrypt_location(&key, "u1", "2026-10-24", 7, &sample()).unwrap();
        let b = encrypt_location(&key, "u1", "2026-10-24", 7, &sample()).unwrap();
        assert_eq!(a.len(), BLOB_LEN);
        assert_ne!(a, b, "nonce must be random");
        assert_eq!(decrypt_location(&key, "u1", "2026-10-24", 7, &a).unwrap(), sample());
        assert_eq!(decrypt_location(&key, "u1", "2026-10-24", 7, &b).unwrap(), sample());
    }

    #[test]
    fn wrong_aad_key_or_tamper_fails() {
        let key = [9u8; 32];
        let blob = encrypt_location(&key, "u1", "e1", 7, &sample()).unwrap();
        assert!(decrypt_location(&key, "u2", "e1", 7, &blob).is_err());
        assert!(decrypt_location(&key, "u1", "e2", 7, &blob).is_err());
        assert!(decrypt_location(&key, "u1", "e1", 8, &blob).is_err());
        assert!(decrypt_location(&[8u8; 32], "u1", "e1", 7, &blob).is_err());
        let mut t = blob.clone();
        t[NONCE_LEN + 3] ^= 1;
        assert!(decrypt_location(&key, "u1", "e1", 7, &t).is_err());
        assert!(decrypt_location(&key, "u1", "e1", 7, &blob[1..]).is_err());
    }

    #[test]
    fn encoding_is_fixed_little_endian() {
        let enc = Location { lat: 1.0, lng: -2.0, accuracy_m: 3.0, t_ms: 4 }.encode();
        assert_eq!(&enc[0..8], &1.0f64.to_le_bytes());
        assert_eq!(&enc[8..16], &(-2.0f64).to_le_bytes());
        assert_eq!(&enc[16..20], &3.0f32.to_le_bytes());
        assert_eq!(&enc[20..28], &4u64.to_le_bytes());
        assert_eq!(location_aad("alice", "2026-10-24", 42), b"alice|2026-10-24|42");
    }
}
