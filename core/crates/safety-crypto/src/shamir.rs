//! k-of-n Shamir secret sharing over GF(2^8) (AES polynomial 0x11b), byte-wise.
//!
//! Each secret byte gets its own random polynomial of degree `k-1` whose constant term is the
//! secret byte; share `i` holds the polynomial evaluated at `x = index` (1..=n). Any `k` shares
//! recover the secret by Lagrange interpolation at `x = 0`; fewer reveal nothing.

use zeroize::Zeroize;

use crate::{random_array, CryptoError, Result};

/// One Shamir share. `index` is the (non-zero) x-coordinate, `data` has the secret's length.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Share {
    pub index: u8,
    pub data: Vec<u8>,
}

/// GF(2^8) multiply, branch-free (Russian peasant with mask-select).
fn gf_mul(mut a: u8, mut b: u8) -> u8 {
    let mut p = 0u8;
    for _ in 0..8 {
        p ^= a & (0u8.wrapping_sub(b & 1));
        let carry = 0u8.wrapping_sub(a >> 7);
        a = (a << 1) ^ (carry & 0x1b);
        b >>= 1;
    }
    p
}

/// a^254 == a^-1 in GF(2^8) (0 maps to 0).
fn gf_inv(a: u8) -> u8 {
    let mut r = 1u8;
    let mut base = a;
    let mut e = 254u8;
    while e > 0 {
        if e & 1 == 1 {
            r = gf_mul(r, base);
        }
        base = gf_mul(base, base);
        e >>= 1;
    }
    r
}

/// Split `secret` into `n` shares of which any `k` reconstruct it. Requires `2 <= k <= n <= 255`.
pub fn split(secret: &[u8], k: u8, n: u8) -> Result<Vec<Share>> {
    if k < 2 || k > n {
        return Err(CryptoError::new(format!("shamir: need 2 <= k <= n, got k={k} n={n}")));
    }
    if secret.is_empty() {
        return Err(CryptoError::new("shamir: empty secret"));
    }
    let mut shares: Vec<Share> = (1..=n)
        .map(|i| Share { index: i, data: Vec::with_capacity(secret.len()) })
        .collect();
    // coeffs[0] = secret byte, coeffs[1..k] random.
    let mut coeffs = vec![0u8; k as usize];
    for &s in secret {
        coeffs[0] = s;
        for c in coeffs[1..].iter_mut() {
            *c = random_array::<1>()[0];
        }
        for share in shares.iter_mut() {
            // Horner evaluation at x = index.
            let x = share.index;
            let mut y = 0u8;
            for &c in coeffs.iter().rev() {
                y = gf_mul(y, x) ^ c;
            }
            share.data.push(y);
        }
    }
    coeffs.zeroize();
    Ok(shares)
}

/// Recover the secret from any `k` (or more) shares via Lagrange interpolation at `x = 0`.
/// Fails on fewer than 2 shares, duplicate or zero indices, or mismatched lengths. Supplying
/// fewer than `k` valid shares yields garbage, not an error (there is no way to tell).
pub fn combine(shares: &[Share]) -> Result<Vec<u8>> {
    if shares.len() < 2 {
        return Err(CryptoError::new("shamir: need at least 2 shares"));
    }
    let len = shares[0].data.len();
    if len == 0 || shares.iter().any(|s| s.data.len() != len) {
        return Err(CryptoError::new("shamir: shares have empty or mismatched lengths"));
    }
    for (i, a) in shares.iter().enumerate() {
        if a.index == 0 {
            return Err(CryptoError::new("shamir: share index 0 is invalid"));
        }
        if shares[..i].iter().any(|b| b.index == a.index) {
            return Err(CryptoError::new(format!("shamir: duplicate share index {}", a.index)));
        }
    }
    // Lagrange basis at x=0: l_i = prod_{j!=i} x_j / (x_j - x_i)  (subtraction is XOR in GF(2^8)).
    let basis: Vec<u8> = shares
        .iter()
        .map(|si| {
            shares
                .iter()
                .filter(|sj| sj.index != si.index)
                .fold(1u8, |acc, sj| gf_mul(acc, gf_mul(sj.index, gf_inv(sj.index ^ si.index))))
        })
        .collect();
    let mut out = vec![0u8; len];
    for (byte, o) in out.iter_mut().enumerate() {
        for (s, &l) in shares.iter().zip(&basis) {
            *o ^= gf_mul(s.data[byte], l);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gf_arith_sanity() {
        assert_eq!(gf_mul(0x53, 0xCA), 0x01); // classic AES inverse pair
        assert_eq!(gf_inv(0x53), 0xCA);
        for a in 1..=255u8 {
            assert_eq!(gf_mul(a, gf_inv(a)), 1, "inverse of {a}");
        }
        assert_eq!(gf_inv(0), 0);
    }

    #[test]
    fn any_k_of_n_rebuild_and_k_minus_1_do_not() {
        let secret = random_array::<32>();
        for (k, n) in [(2u8, 2u8), (2, 3), (3, 5), (4, 7), (5, 5), (3, 255)] {
            let shares = split(&secret, k, n).unwrap();
            assert_eq!(shares.len(), n as usize);
            // A few k-subsets, including rotated windows and the tail.
            for start in 0..(n as usize).min(6) {
                let subset: Vec<Share> = shares.iter().cycle().skip(start).take(k as usize).cloned().collect();
                assert_eq!(combine(&subset).unwrap(), secret.to_vec(), "k={k} n={n} start={start}");
            }
            let tail: Vec<Share> = shares[shares.len() - k as usize..].to_vec();
            assert_eq!(combine(&tail).unwrap(), secret.to_vec());
            // All n shares also work.
            assert_eq!(combine(&shares).unwrap(), secret.to_vec());
            // k-1 shares (when >= 2) give the wrong answer.
            if k >= 3 {
                let few = &shares[..(k - 1) as usize];
                assert_ne!(combine(few).unwrap(), secret.to_vec(), "k-1 shares must not rebuild");
            }
        }
    }

    #[test]
    fn rejects_bad_parameters_and_duplicates() {
        let secret = [7u8; 32];
        assert!(split(&secret, 1, 3).is_err());
        assert!(split(&secret, 4, 3).is_err());
        assert!(split(&[], 2, 3).is_err());
        let shares = split(&secret, 2, 3).unwrap();
        assert!(combine(&[shares[0].clone(), shares[0].clone()]).is_err());
        assert!(combine(&shares[..1]).is_err());
        let mut zero = shares[1].clone();
        zero.index = 0;
        assert!(combine(&[shares[0].clone(), zero]).is_err());
        let mut short = shares[1].clone();
        short.data.pop();
        assert!(combine(&[shares[0].clone(), short]).is_err());
    }
}
