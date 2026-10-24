//! `#[wasm_bindgen]` surface over `safety_crypto` for the browser build (CONTRACTS.md §1 crypto.rs,
//! same function set as `safety-ffi/src/crypto.rs`).
//!
//! JS-facing conventions:
//! - bytes in/out are `Uint8Array`; ids are strings; `hourIndex` is a u32 number; `seq` / `tMs` are
//!   f64 numbers (JS cannot hold a u64 natively; unix-ms fits a double exactly).
//! - compound values are plain JS objects/arrays (via serde-wasm-bindgen, no `.free()` needed):
//!   identity `{x25519Secret, x25519Public, ed25519Secret, ed25519Public}`, share `{index, data}`,
//!   location `{lat, lng, accuracyM, tMs}`.
//! - every `Result` error becomes a thrown JS `Error` whose `message` is the `CryptoError` text.

use safety_crypto::{epoch, identity, location, proximity, sealed, shamir};
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    x25519_secret: ByteBuf,
    x25519_public: ByteBuf,
    ed25519_secret: ByteBuf,
    ed25519_public: ByteBuf,
}

#[derive(Serialize, Deserialize)]
struct Share {
    index: u8,
    data: ByteBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Location {
    lat: f64,
    lng: f64,
    accuracy_m: f32,
    t_ms: f64,
}

fn err(msg: impl std::fmt::Display) -> JsError {
    JsError::new(&msg.to_string())
}

fn key32(v: &[u8], what: &str) -> Result<[u8; 32], JsError> {
    <[u8; 32]>::try_from(v).map_err(|_| err(format!("{what} must be 32 bytes, got {}", v.len())))
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    // Default serializer: `serde_bytes` → Uint8Array, structs → plain objects, Vec → Array.
    v.serialize(&serde_wasm_bindgen::Serializer::new()).map_err(err)
}

fn from_js<T: for<'de> Deserialize<'de>>(v: JsValue, what: &str) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(v).map_err(|e| err(format!("{what}: {e}")))
}

fn u64_from_f64(v: f64, what: &str) -> Result<u64, JsError> {
    if !v.is_finite() || v < 0.0 || v.fract() != 0.0 || v > 9_007_199_254_740_992.0 {
        return Err(err(format!("{what} must be a non-negative integer number, got {v}")));
    }
    Ok(v as u64)
}

/// → `{ x25519Secret, x25519Public, ed25519Secret, ed25519Public }` (each a 32-byte Uint8Array).
#[wasm_bindgen]
pub fn generate_identity() -> Result<JsValue, JsError> {
    let id = identity::generate_identity();
    to_js(&Identity {
        x25519_secret: ByteBuf::from(id.x25519_secret.as_bytes().to_vec()),
        x25519_public: ByteBuf::from(id.x25519_public.to_vec()),
        ed25519_secret: ByteBuf::from(id.ed25519_secret.as_bytes().to_vec()),
        ed25519_public: ByteBuf::from(id.ed25519_public.to_vec()),
    })
}

/// `"ab12-cd34-..."` — 8 groups of 4 hex digits.
#[wasm_bindgen]
pub fn fingerprint(user_id: &str, x25519_public: &[u8], ed25519_public: &[u8]) -> String {
    identity::fingerprint(user_id, x25519_public, ed25519_public)
}

/// 32 random bytes.
#[wasm_bindgen]
pub fn new_day_key() -> Vec<u8> {
    epoch::new_day_key().as_bytes().to_vec()
}

/// HKDF-SHA256(day_key, info = "safe/hour/{hour_index}") → 32 bytes.
#[wasm_bindgen]
pub fn derive_hour_key(day_key: &[u8], hour_index: u32) -> Vec<u8> {
    epoch::derive_hour_key_ikm(day_key, hour_index).as_bytes().to_vec()
}

/// Shamir k-of-n over GF(256) → `[{ index, data }]`.
#[wasm_bindgen]
pub fn split_day_key(day_key: &[u8], k: u8, n: u8) -> Result<JsValue, JsError> {
    let key = key32(day_key, "day_key")?;
    let shares: Vec<Share> = shamir::split(&key, k, n)
        .map_err(err)?
        .into_iter()
        .map(|s| Share { index: s.index, data: ByteBuf::from(s.data) })
        .collect();
    to_js(&shares)
}

/// `[{ index, data }]` → day key bytes.
#[wasm_bindgen]
pub fn combine_shares(shares: JsValue) -> Result<Vec<u8>, JsError> {
    let shares: Vec<Share> = from_js(shares, "shares")?;
    let shares: Vec<shamir::Share> = shares
        .into_iter()
        .map(|s| shamir::Share { index: s.index, data: s.data.into_vec() })
        .collect();
    shamir::combine(&shares).map_err(err)
}

/// HPKE base (X25519-HKDF-SHA256 / ChaCha20-Poly1305) + Ed25519 signature appended.
#[wasm_bindgen]
pub fn seal_to(
    recipient_x25519_public: &[u8],
    sender_ed25519_secret: &[u8],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsError> {
    let pk = key32(recipient_x25519_public, "recipient_x25519_public")?;
    let sk = key32(sender_ed25519_secret, "sender_ed25519_secret")?;
    sealed::seal_to(&pk, &sk, plaintext, aad).map_err(err)
}

#[wasm_bindgen]
pub fn open_sealed(
    recipient_x25519_secret: &[u8],
    sender_ed25519_public: &[u8],
    sealed_blob: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, JsError> {
    let sk = key32(recipient_x25519_secret, "recipient_x25519_secret")?;
    let pk = key32(sender_ed25519_public, "sender_ed25519_public")?;
    sealed::open_sealed(&sk, &pk, sealed_blob, aad).map_err(err)
}

/// XChaCha20-Poly1305 under the hour key, AAD = "{user_id}|{epoch_id}|{seq}". `loc` is
/// `{ lat, lng, accuracyM, tMs }`.
#[wasm_bindgen]
pub fn encrypt_location(
    hour_key: &[u8],
    user_id: &str,
    epoch_id: &str,
    seq: f64,
    loc: JsValue,
) -> Result<Vec<u8>, JsError> {
    let key = key32(hour_key, "hour_key")?;
    let seq = u64_from_f64(seq, "seq")?;
    let l: Location = from_js(loc, "loc")?;
    let l = location::Location {
        lat: l.lat,
        lng: l.lng,
        accuracy_m: l.accuracy_m,
        t_ms: u64_from_f64(l.t_ms, "loc.tMs")?,
    };
    location::encrypt_location(&key, user_id, epoch_id, seq, &l).map_err(err)
}

/// → `{ lat, lng, accuracyM, tMs }`.
#[wasm_bindgen]
pub fn decrypt_location(
    hour_key: &[u8],
    user_id: &str,
    epoch_id: &str,
    seq: f64,
    blob: &[u8],
) -> Result<JsValue, JsError> {
    let key = key32(hour_key, "hour_key")?;
    let seq = u64_from_f64(seq, "seq")?;
    let l = location::decrypt_location(&key, user_id, epoch_id, seq, blob).map_err(err)?;
    to_js(&Location { lat: l.lat, lng: l.lng, accuracy_m: l.accuracy_m, t_ms: l.t_ms as f64 })
}

/// 9 tokens (cell + 8 neighbours) → `Uint8Array[]`.
#[wasm_bindgen]
pub fn proximity_tokens(group_epoch_key: &[u8], lat: f64, lng: f64) -> Result<JsValue, JsError> {
    let toks: Vec<ByteBuf> = proximity::proximity_tokens(group_epoch_key, lat, lng)
        .into_iter()
        .map(ByteBuf::from)
        .collect();
    to_js(&toks)
}

/// `a`, `b`: `Uint8Array[]`.
#[wasm_bindgen]
pub fn proximity_match(a: JsValue, b: JsValue) -> Result<bool, JsError> {
    let a: Vec<ByteBuf> = from_js(a, "a")?;
    let b: Vec<ByteBuf> = from_js(b, "b")?;
    let a: Vec<Vec<u8>> = a.into_iter().map(ByteBuf::into_vec).collect();
    let b: Vec<Vec<u8>> = b.into_iter().map(ByteBuf::into_vec).collect();
    Ok(proximity::proximity_match(&a, &b))
}
