//! Signal processing on 50 Hz motion windows. No I/O, no platform deps.
pub mod gait;
pub mod impact;
pub mod placement;
pub mod snatch;

pub use gait::{GaitAnalyzer, GaitFeatures};
pub use impact::{ImpactDetector, ImpactEvent, ImpactKind};
pub use placement::infer_placement;
pub use snatch::SnatchDetector;

use crate::types::MotionSample;

/// Vector helpers on [f32; 3].
pub(crate) fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub(crate) fn norm(a: [f32; 3]) -> f32 {
    dot(a, a).sqrt()
}
pub(crate) fn angle_deg(a: [f32; 3], b: [f32; 3]) -> f32 {
    let d = norm(a) * norm(b);
    if d < 1e-6 {
        return 0.0;
    }
    (dot(a, b) / d).clamp(-1.0, 1.0).acos().to_degrees()
}
pub(crate) fn accel(s: &MotionSample) -> [f32; 3] {
    [s.ax, s.ay, s.az]
}
pub(crate) fn gravity(s: &MotionSample) -> [f32; 3] {
    [s.gx, s.gy, s.gz]
}
/// Total acceleration magnitude in g (user accel + gravity). ≈1 at rest, ≈0 in free fall.
pub(crate) fn total_mag(s: &MotionSample) -> f32 {
    norm([s.ax + s.gx, s.ay + s.gy, s.az + s.gz])
}

/// Project user acceleration onto the gravity axis (vertical, positive = up)
/// and the horizontal plane magnitude so phone orientation doesn't matter.
pub(crate) fn project(s: &MotionSample) -> (f32, f32) {
    let g = gravity(s);
    let a = accel(s);
    let gn = norm(g).max(1e-6);
    let v = dot(a, g) / gn; // along gravity (down positive)
    let h = [a[0] - v * g[0] / gn, a[1] - v * g[1] / gn, a[2] - v * g[2] / gn];
    (-v, norm(h))
}

pub(crate) fn rms(xs: &[f32]) -> f32 {
    if xs.is_empty() {
        return 0.0;
    }
    (xs.iter().map(|x| x * x).sum::<f32>() / xs.len() as f32).sqrt()
}
