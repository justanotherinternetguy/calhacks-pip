//! Signed HPKE envelopes, used to escrow Shamir shares and release hourly keys to friends.
//!
//! # Wire format (`seal_to` output)
//! ```text
//! enc (32 bytes)  ||  ct (plaintext.len() + 16 bytes)  ||  sig (64 bytes)
//! ```
//! - `enc || ct` is RFC 9180 HPKE **base mode** single-shot `Seal` with
//!   DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305,
//!   `info = "safe/sealed/v1"`, and the caller's `aad` bound as HPKE AAD.
//! - `sig` is an Ed25519 signature by the sender over `enc || ct || aad`.
//!
//! `open_sealed` verifies the signature (strict) before attempting HPKE decryption, so a
//! recipient learns nothing from an envelope that is not from the claimed sender.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hpke::aead::ChaCha20Poly1305;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem, OpModeR, OpModeS, Serializable};

use crate::{CryptoError, Result};

pub const INFO: &[u8] = b"safe/sealed/v1";
pub const ENC_LEN: usize = 32;
pub const TAG_LEN: usize = 16;
pub const SIG_LEN: usize = 64;
/// Smallest valid envelope: empty plaintext.
pub const MIN_LEN: usize = ENC_LEN + TAG_LEN + SIG_LEN;

type KemT = X25519HkdfSha256;

/// Seal `plaintext` to `recipient_x25519_pub` and sign it with `sender_ed25519_secret`.
pub fn seal_to(
    recipient_x25519_pub: &[u8; 32],
    sender_ed25519_secret: &[u8; 32],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>> {
    let pk = <KemT as Kem>::PublicKey::from_bytes(recipient_x25519_pub)
        .map_err(|e| CryptoError::new(format!("sealed: bad recipient key: {e}")))?;
    let (enc, ct) = hpke::single_shot_seal::<ChaCha20Poly1305, HkdfSha256, KemT>(
        &OpModeS::Base,
        &pk,
        INFO,
        plaintext,
        aad,
    )
    .map_err(|e| CryptoError::new(format!("sealed: hpke seal failed: {e}")))?;

    let mut out = Vec::with_capacity(ENC_LEN + ct.len() + SIG_LEN);
    out.extend_from_slice(&enc.to_bytes());
    out.extend_from_slice(&ct);
    let signer = SigningKey::from_bytes(sender_ed25519_secret);
    let mut signed = out.clone();
    signed.extend_from_slice(aad);
    out.extend_from_slice(&signer.sign(&signed).to_bytes());
    Ok(out)
}

/// Verify the sender's signature, then HPKE-open the envelope produced by [`seal_to`].
pub fn open_sealed(
    recipient_x25519_secret: &[u8; 32],
    sender_ed25519_pub: &[u8; 32],
    sealed: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>> {
    if sealed.len() < MIN_LEN {
        return Err(CryptoError::new("sealed: envelope too short"));
    }
    let (body, sig) = sealed.split_at(sealed.len() - SIG_LEN);
    let (enc, ct) = body.split_at(ENC_LEN);

    let vk = VerifyingKey::from_bytes(sender_ed25519_pub)
        .map_err(|e| CryptoError::new(format!("sealed: bad sender key: {e}")))?;
    let sig = Signature::from_slice(sig).map_err(|e| CryptoError::new(format!("sealed: bad sig: {e}")))?;
    let mut signed = body.to_vec();
    signed.extend_from_slice(aad);
    vk.verify_strict(&signed, &sig)
        .map_err(|_| CryptoError::new("sealed: signature verification failed"))?;

    let sk = <KemT as Kem>::PrivateKey::from_bytes(recipient_x25519_secret)
        .map_err(|e| CryptoError::new(format!("sealed: bad recipient secret: {e}")))?;
    let enc = <KemT as Kem>::EncappedKey::from_bytes(enc)
        .map_err(|e| CryptoError::new(format!("sealed: bad encapsulated key: {e}")))?;
    hpke::single_shot_open::<ChaCha20Poly1305, HkdfSha256, KemT>(&OpModeR::Base, &sk, &enc, INFO, ct, aad)
        .map_err(|_| CryptoError::new("sealed: hpke open failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::generate_identity;

    fn hexd(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn round_trip_with_identity_keys() {
        let alice = generate_identity();
        let bob = generate_identity();
        let msg = b"share #3 of K_day";
        let aad = b"group:42|epoch:2026-10-24";
        let env = seal_to(&bob.x25519_public, &alice.ed25519_secret.0, msg, aad).unwrap();
        assert_eq!(env.len(), ENC_LEN + msg.len() + TAG_LEN + SIG_LEN);
        let pt = open_sealed(&bob.x25519_secret.0, &alice.ed25519_public, &env, aad).unwrap();
        assert_eq!(pt, msg);
        // Empty plaintext is fine too.
        let env0 = seal_to(&bob.x25519_public, &alice.ed25519_secret.0, b"", b"").unwrap();
        assert_eq!(open_sealed(&bob.x25519_secret.0, &alice.ed25519_public, &env0, b"").unwrap(), b"");
    }

    #[test]
    fn tamper_and_wrong_key_rejections() {
        let alice = generate_identity();
        let bob = generate_identity();
        let eve = generate_identity();
        let aad = b"aad";
        let env = seal_to(&bob.x25519_public, &alice.ed25519_secret.0, b"secret", aad).unwrap();
        let open = |e: &[u8], a: &[u8]| open_sealed(&bob.x25519_secret.0, &alice.ed25519_public, e, a);
        // Flip a byte in enc, ct, and sig respectively.
        for pos in [0usize, ENC_LEN + 1, env.len() - 1] {
            let mut t = env.clone();
            t[pos] ^= 0x01;
            assert!(open(&t, aad).is_err(), "tamper at {pos} must fail");
        }
        assert!(open(&env, b"other aad").is_err());
        assert!(open(&env[..env.len() - 1], aad).is_err());
        assert!(open(&env[..MIN_LEN - 1], aad).is_err());
        // Wrong sender key: signature fails. Wrong recipient: HPKE fails.
        assert!(open_sealed(&bob.x25519_secret.0, &eve.ed25519_public, &env, aad).is_err());
        assert!(open_sealed(&eve.x25519_secret.0, &alice.ed25519_public, &env, aad).is_err());
        // Unsigned re-wrap by eve (valid HPKE, wrong signer) is rejected.
        let forged = seal_to(&bob.x25519_public, &eve.ed25519_secret.0, b"secret", aad).unwrap();
        assert!(open(&forged, aad).is_err());
    }

    /// Fixed envelope produced once by this implementation; pins the wire format.
    #[test]
    fn open_known_vector() {
        let recip_sk = hexd("3c8f298f5cf220d35c44e33df85881931402c62fdf4e31e4c83aa13485124032");
        let sender_pk = hexd("28b8ae669848af1061ffae8a2b4cadb7925d517fea0c96cb60b3c2c9869cce49");
        let env = hexd("e95b794ca7b8a56ecd3851cc0a8f76441a7f79eb2b0ff978929a3e210ea1ad3e809efa1ee24e0f1106b9a5636b6ce035f01a655154b496446d29eabf326d81d209f7eb5be78c5e41bd4d8397e24ea8a196754434b1f47c5702ce25939620b0d82b94143ee1ecae88b94402ff1d08f1f1953f41cd3bc37974c42cb30c");
        let pt = open_sealed(recip_sk.as_slice().try_into().unwrap(), sender_pk.as_slice().try_into().unwrap(), &env, b"vector-aad").unwrap();
        assert_eq!(pt, b"hello escrow");
    }
}
