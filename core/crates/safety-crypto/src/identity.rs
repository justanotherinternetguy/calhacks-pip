//! Device identity: X25519 key for HPKE and Ed25519 key for signatures, plus the QR fingerprint.

use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::{hex, random_array, Secret32};

/// A freshly generated device identity. Secret halves are zeroized on drop.
#[derive(Clone, Debug)]
pub struct Identity {
    pub x25519_secret: Secret32,
    pub x25519_public: [u8; 32],
    pub ed25519_secret: Secret32,
    pub ed25519_public: [u8; 32],
}

/// Generate a new X25519 + Ed25519 keypair from the OS CSPRNG.
pub fn generate_identity() -> Identity {
    let x_sk = StaticSecret::random();
    let x_pk = PublicKey::from(&x_sk);
    let ed_sk = SigningKey::from_bytes(&random_array::<32>());
    Identity {
        x25519_secret: Secret32(x_sk.to_bytes()),
        x25519_public: x_pk.to_bytes(),
        ed25519_public: ed_sk.verifying_key().to_bytes(),
        ed25519_secret: Secret32(ed_sk.to_bytes()),
    }
}

/// Safety-number style fingerprint shown in the QR code and used for re-verification:
/// `SHA-256(user_id || x25519_pub || ed25519_pub)`, first 16 bytes as 8 groups of 4 lowercase
/// hex digits joined by `-` (e.g. `ab12-cd34-...`).
pub fn fingerprint(user_id: &str, x25519_pub: &[u8], ed25519_pub: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(user_id.as_bytes());
    h.update(x25519_pub);
    h.update(ed25519_pub);
    let digest = h.finalize();
    let hx = hex(&digest[..16]);
    hx.as_bytes()
        .chunks(4)
        .map(|c| core::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_consistent_and_distinct() {
        let a = generate_identity();
        let b = generate_identity();
        assert_ne!(a.x25519_public, b.x25519_public);
        assert_ne!(a.ed25519_public, b.ed25519_public);
        let re_x = PublicKey::from(&StaticSecret::from(a.x25519_secret.0));
        assert_eq!(re_x.to_bytes(), a.x25519_public);
        let re_ed = SigningKey::from_bytes(&a.ed25519_secret.0).verifying_key();
        assert_eq!(re_ed.to_bytes(), a.ed25519_public);
    }

    #[test]
    fn fingerprint_format_and_vector() {
        let fp = fingerprint("alice", &[2u8; 32], &[3u8; 32]);
        assert_eq!(fp.len(), 8 * 4 + 7);
        assert_eq!(fp.split('-').count(), 8);
        assert!(fp.chars().all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(fp, "ba8a-e639-ad50-dc4b-f5a8-53b5-a281-c573");
        assert_ne!(fp, fingerprint("alicf", &[2u8; 32], &[3u8; 32]));
    }
}
