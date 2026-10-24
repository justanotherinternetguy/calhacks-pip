//! Rolling epoch keys: a random `K_day` per day, `K_h = HKDF-SHA256(K_day, info = "safe/hour/{h}")`.

use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{random_array, Secret32};

/// Daily root key. Escrowed with Shamir; zeroized on drop.
#[derive(Clone, Debug, Zeroize, ZeroizeOnDrop)]
pub struct DayKey(pub Secret32);

/// Hourly key derived from a [`DayKey`]; encrypts location samples. Zeroized on drop.
#[derive(Clone, Debug, Zeroize, ZeroizeOnDrop)]
pub struct HourKey(pub Secret32);

impl DayKey {
    pub fn as_bytes(&self) -> &[u8; 32] {
        self.0.as_bytes()
    }
}
impl HourKey {
    pub fn as_bytes(&self) -> &[u8; 32] {
        self.0.as_bytes()
    }
}
impl From<[u8; 32]> for DayKey {
    fn from(b: [u8; 32]) -> Self {
        DayKey(Secret32(b))
    }
}

/// 32 random bytes from the OS CSPRNG.
pub fn new_day_key() -> DayKey {
    DayKey(Secret32(random_array::<32>()))
}

/// `K_h = HKDF-SHA256(salt = none, ikm = K_day, info = "safe/hour/{hour_index}")`.
pub fn derive_hour_key(day_key: &DayKey, hour_index: u32) -> HourKey {
    derive_hour_key_ikm(day_key.as_bytes(), hour_index)
}

/// Same derivation over raw input keying material (HKDF accepts any IKM length). Used by the
/// FFI, whose contract makes `derive_hour_key` infallible.
pub fn derive_hour_key_ikm(ikm: &[u8], hour_index: u32) -> HourKey {
    let info = format!("safe/hour/{hour_index}");
    let mut okm = [0u8; 32];
    Hkdf::<Sha256>::new(None, ikm)
        .expand(info.as_bytes(), &mut okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    HourKey(Secret32(okm))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hex;

    #[test]
    fn hour_keys_differ_per_hour_and_match_vector() {
        let dk = DayKey::from([1u8; 32]);
        let h5 = derive_hour_key(&dk, 5);
        let h6 = derive_hour_key(&dk, 6);
        assert_ne!(h5.as_bytes(), h6.as_bytes());
        assert_eq!(hex(h5.as_bytes()), "7d7c64d806dac88ad1d60e28878f012596376a56d9511693b10620fc18889648");
        assert_eq!(derive_hour_key(&dk, 5).as_bytes(), h5.as_bytes());
    }

    #[test]
    fn day_keys_are_random_and_zeroizable() {
        let a = new_day_key();
        let b = new_day_key();
        assert_ne!(a.as_bytes(), b.as_bytes());
        let mut c = new_day_key();
        c.zeroize();
        assert_eq!(c.as_bytes(), &[0u8; 32]);
    }
}
