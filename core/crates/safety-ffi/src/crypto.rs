//! uniffi surface over `safety_crypto` (CONTRACTS.md §1, crypto.rs). All byte values are plain
//! `Vec<u8>`; the JS layer base64-encodes them.

use safety_crypto::{epoch, identity, location, proximity, sealed, shamir};

#[derive(uniffi::Record)]
pub struct Identity {
    pub x25519_secret: Vec<u8>,
    pub x25519_public: Vec<u8>,
    pub ed25519_secret: Vec<u8>,
    pub ed25519_public: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct Share {
    pub index: u8,
    pub data: Vec<u8>,
}

#[derive(uniffi::Record)]
pub struct Location {
    pub lat: f64,
    pub lng: f64,
    pub accuracy_m: f32,
    pub t_ms: u64,
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum CryptoError {
    #[error("{msg}")]
    Failed { msg: String },
}

impl From<safety_crypto::CryptoError> for CryptoError {
    fn from(e: safety_crypto::CryptoError) -> Self {
        let safety_crypto::CryptoError::Failed { msg } = e;
        CryptoError::Failed { msg }
    }
}

fn key32(v: &[u8], what: &str) -> Result<[u8; 32], CryptoError> {
    <[u8; 32]>::try_from(v).map_err(|_| CryptoError::Failed {
        msg: format!("{what} must be 32 bytes, got {}", v.len()),
    })
}

impl From<Location> for location::Location {
    fn from(l: Location) -> Self {
        location::Location { lat: l.lat, lng: l.lng, accuracy_m: l.accuracy_m, t_ms: l.t_ms }
    }
}
impl From<location::Location> for Location {
    fn from(l: location::Location) -> Self {
        Location { lat: l.lat, lng: l.lng, accuracy_m: l.accuracy_m, t_ms: l.t_ms }
    }
}

#[uniffi::export]
pub fn generate_identity() -> Identity {
    let id = identity::generate_identity();
    Identity {
        x25519_secret: id.x25519_secret.as_bytes().to_vec(),
        x25519_public: id.x25519_public.to_vec(),
        ed25519_secret: id.ed25519_secret.as_bytes().to_vec(),
        ed25519_public: id.ed25519_public.to_vec(),
    }
}

#[uniffi::export]
pub fn fingerprint(user_id: String, x25519_public: Vec<u8>, ed25519_public: Vec<u8>) -> String {
    identity::fingerprint(&user_id, &x25519_public, &ed25519_public)
}

#[uniffi::export]
pub fn new_day_key() -> Vec<u8> {
    epoch::new_day_key().as_bytes().to_vec()
}

#[uniffi::export]
pub fn derive_hour_key(day_key: Vec<u8>, hour_index: u32) -> Vec<u8> {
    epoch::derive_hour_key_ikm(&day_key, hour_index).as_bytes().to_vec()
}

#[uniffi::export]
pub fn split_day_key(day_key: Vec<u8>, k: u8, n: u8) -> Result<Vec<Share>, CryptoError> {
    let key = key32(&day_key, "day_key")?;
    Ok(shamir::split(&key, k, n)?
        .into_iter()
        .map(|s| Share { index: s.index, data: s.data })
        .collect())
}

#[uniffi::export]
pub fn combine_shares(shares: Vec<Share>) -> Result<Vec<u8>, CryptoError> {
    let shares: Vec<shamir::Share> = shares
        .into_iter()
        .map(|s| shamir::Share { index: s.index, data: s.data })
        .collect();
    Ok(shamir::combine(&shares)?)
}

#[uniffi::export]
pub fn seal_to(
    recipient_x25519_public: Vec<u8>,
    sender_ed25519_secret: Vec<u8>,
    plaintext: Vec<u8>,
    aad: Vec<u8>,
) -> Result<Vec<u8>, CryptoError> {
    let pk = key32(&recipient_x25519_public, "recipient_x25519_public")?;
    let sk = key32(&sender_ed25519_secret, "sender_ed25519_secret")?;
    Ok(sealed::seal_to(&pk, &sk, &plaintext, &aad)?)
}

#[uniffi::export]
pub fn open_sealed(
    recipient_x25519_secret: Vec<u8>,
    sender_ed25519_public: Vec<u8>,
    sealed_blob: Vec<u8>,
    aad: Vec<u8>,
) -> Result<Vec<u8>, CryptoError> {
    let sk = key32(&recipient_x25519_secret, "recipient_x25519_secret")?;
    let pk = key32(&sender_ed25519_public, "sender_ed25519_public")?;
    Ok(sealed::open_sealed(&sk, &pk, &sealed_blob, &aad)?)
}

#[uniffi::export]
pub fn encrypt_location(
    hour_key: Vec<u8>,
    user_id: String,
    epoch_id: String,
    seq: u64,
    loc: Location,
) -> Result<Vec<u8>, CryptoError> {
    let key = key32(&hour_key, "hour_key")?;
    Ok(location::encrypt_location(&key, &user_id, &epoch_id, seq, &loc.into())?)
}

#[uniffi::export]
pub fn decrypt_location(
    hour_key: Vec<u8>,
    user_id: String,
    epoch_id: String,
    seq: u64,
    blob: Vec<u8>,
) -> Result<Location, CryptoError> {
    let key = key32(&hour_key, "hour_key")?;
    Ok(location::decrypt_location(&key, &user_id, &epoch_id, seq, &blob)?.into())
}

#[uniffi::export]
pub fn proximity_tokens(group_epoch_key: Vec<u8>, lat: f64, lng: f64) -> Vec<Vec<u8>> {
    proximity::proximity_tokens(&group_epoch_key, lat, lng)
}

#[uniffi::export]
pub fn proximity_match(a: Vec<Vec<u8>>, b: Vec<Vec<u8>>) -> bool {
    proximity::proximity_match(&a, &b)
}
