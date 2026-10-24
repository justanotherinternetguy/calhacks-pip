//! Server-blind proximity: `HMAC-SHA256(group_epoch_key, geohash7)[..16]` for the device's cell
//! and its 8 neighbours (precision-7 cells are ~153 m x ~153 m). Two devices are "together" when
//! their token sets intersect; the server only ever sees the tokens.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

pub const PRECISION: usize = 7;
pub const TOKEN_LEN: usize = 16;
const BASE32: &[u8; 32] = b"0123456789bcdefghjkmnpqrstuvwxyz";

/// Standard geohash encoding (lng/lat bit interleave, base32) at `PRECISION` characters.
/// Returns the hash and the cell's (lat, lng) centre and (lat, lng) extent.
fn geohash_cell(lat: f64, lng: f64) -> (String, [f64; 2], [f64; 2]) {
    let lat = lat.clamp(-90.0, 90.0);
    let lng = ((lng + 180.0).rem_euclid(360.0)) - 180.0;
    let (mut lat_r, mut lng_r) = ([-90.0f64, 90.0f64], [-180.0f64, 180.0f64]);
    let mut hash = String::with_capacity(PRECISION);
    let mut bits = 0u8;
    let mut ch = 0usize;
    let mut even = true;
    while hash.len() < PRECISION {
        let (r, v) = if even { (&mut lng_r, lng) } else { (&mut lat_r, lat) };
        let mid = (r[0] + r[1]) / 2.0;
        ch <<= 1;
        if v >= mid {
            ch |= 1;
            r[0] = mid;
        } else {
            r[1] = mid;
        }
        even = !even;
        bits += 1;
        if bits == 5 {
            hash.push(BASE32[ch] as char);
            bits = 0;
            ch = 0;
        }
    }
    let centre = [(lat_r[0] + lat_r[1]) / 2.0, (lng_r[0] + lng_r[1]) / 2.0];
    let extent = [lat_r[1] - lat_r[0], lng_r[1] - lng_r[0]];
    (hash, centre, extent)
}

/// Precision-7 geohash of a coordinate.
pub fn geohash7(lat: f64, lng: f64) -> String {
    geohash_cell(lat, lng).0
}

/// The cell containing (lat, lng) followed by its 8 neighbours (row-major, NW to SE).
/// At the poles a neighbour may collapse onto the centre cell; duplicates are kept so the
/// output is always 9 entries.
pub fn geohash7_with_neighbors(lat: f64, lng: f64) -> Vec<String> {
    let (own, c, e) = geohash_cell(lat, lng);
    let mut out = vec![own];
    for di in [1i8, 0, -1] {
        for dj in [-1i8, 0, 1] {
            if di == 0 && dj == 0 {
                continue;
            }
            let nlat = (c[0] + di as f64 * e[0]).clamp(-90.0, 90.0);
            out.push(geohash7(nlat, c[1] + dj as f64 * e[1]));
        }
    }
    out
}

/// 9 tokens (own cell + 8 neighbours): `HMAC-SHA256(key, geohash7)[..16]`.
pub fn proximity_tokens(group_epoch_key: &[u8], lat: f64, lng: f64) -> Vec<Vec<u8>> {
    geohash7_with_neighbors(lat, lng)
        .iter()
        .map(|gh| {
            let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(group_epoch_key).expect("HMAC takes any key length");
            mac.update(gh.as_bytes());
            mac.finalize().into_bytes()[..TOKEN_LEN].to_vec()
        })
        .collect()
}

/// True when any token appears in both sets (compared with constant-time equality per pair).
pub fn proximity_match(a: &[Vec<u8>], b: &[Vec<u8>]) -> bool {
    use subtle::ConstantTimeEq;
    a.iter().any(|x| b.iter().any(|y| x.len() == y.len() && bool::from(x.ct_eq(y))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geohash_known_vectors() {
        assert_eq!(geohash7(57.64911, 10.40744), "u4pruyd"); // Wikipedia example truncated
        assert_eq!(geohash7(42.6, -5.6), "ezs42e4");
        assert_eq!(geohash7(0.0, 0.0), "s000000");
        assert_eq!(geohash7(-25.382708, -49.265506), "6gkzwgj");
    }

    #[test]
    fn neighbours_are_distinct_and_adjacent() {
        let cells = geohash7_with_neighbors(51.5007, -0.1246);
        assert_eq!(cells.len(), 9);
        let mut uniq = cells.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), 9, "{cells:?}");
        assert!(cells.iter().all(|c| c.len() == 7));
    }

    #[test]
    fn tokens_match_near_not_far() {
        let key = b"group-epoch-key";
        let (lat, lng) = (51.5007, -0.1246);
        let here = proximity_tokens(key, lat, lng);
        assert_eq!(here.len(), 9);
        assert!(here.iter().all(|t| t.len() == TOKEN_LEN));
        // ~50 m north-east.
        let near = proximity_tokens(key, lat + 0.00032, lng + 0.0005);
        assert!(proximity_match(&here, &near));
        // ~2 km away.
        let far = proximity_tokens(key, lat + 0.018, lng);
        assert!(!proximity_match(&here, &far));
        // Same place, different group key: no match.
        assert!(!proximity_match(&here, &proximity_tokens(b"other-key", lat, lng)));
    }

    #[test]
    fn match_across_cell_boundary_via_neighbor() {
        // Find the centre cell's extent, then stand just either side of its eastern edge.
        let (_, c, e) = geohash_cell(51.5007, -0.1246);
        let east_edge = c[1] + e[1] / 2.0;
        let a = (c[0], east_edge - 1e-6);
        let b = (c[0], east_edge + 1e-6);
        assert_ne!(geohash7(a.0, a.1), geohash7(b.0, b.1), "points must be in different cells");
        let key = b"k";
        assert!(proximity_match(&proximity_tokens(key, a.0, a.1), &proximity_tokens(key, b.0, b.1)));
        // Diagonal corner neighbour too.
        let north_edge = c[0] + e[0] / 2.0;
        let d = (north_edge + 1e-6, east_edge + 1e-6);
        assert!(proximity_match(&proximity_tokens(key, a.0, a.1), &proximity_tokens(key, d.0, d.1)));
    }
}
