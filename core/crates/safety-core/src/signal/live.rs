//! Live metric bands: each gait-window metric compared to the user's per-placement baseline band
//! (mean ± k·SD; wider k while the baseline is untrusted).
use super::GaitFeatures;
use crate::baseline::{Baseline, GAIT_FEATURES};
use crate::config::{BaselineCfg, SignalCfg};
use crate::types::{MetricBand, Placement};

/// Dashboard metric names, in contract order.
pub const METRIC_NAMES: [&str; 8] = ["cadence", "stride_cv", "regularity", "sway", "wobble", "jerk", "rotation", "peak_g"];
/// Index into `Baseline` feature arrays for each dashboard metric.
pub const METRIC_FEATURE: [usize; 8] = [0, 1, 2, 4, 5, 6, 7, 8];

/// Index of the first spike metric in `METRIC_NAMES` (jerk, rotation, peak_g follow).
pub const SPIKE_FIRST: usize = 5;

/// Which side of the band counts as "unsteady": +1 above (stride variability, sway, wobble), -1 below (regularity),
/// 2 = not an unsteadiness metric (cadence has its own slowed-walk rule; the spike metrics feed impact / grab).
pub const UNSTEADY_SIDE: [i8; 8] = [2, 1, -1, 1, 1, 2, 2, 2];

#[derive(Clone, Debug, Default)]
pub struct Bands {
    pub bands: Vec<MetricBand>,
    pub trusted: bool,
}

impl Bands {
    /// Compute bands for a full-rate gait window. For non-walking windows the gait metrics are reported
    /// but marked in band (they are only meaningful while walking); without gyro, wobble/rotation are in band.
    /// The spike metrics (jerk, rotation, peak_g) are one-sided: only a value above mean + k·SD is out of
    /// band (a quiet phone is not "out of band" for being calmer than the walking baseline).
    pub fn compute(b: &Baseline, bcfg: &BaselineCfg, scfg: &SignalCfg, placement: Placement, f: &GaitFeatures) -> Bands {
        let trusted = b.trusted(bcfg, placement);
        let k = if trusted { scfg.band_sd } else { scfg.band_sd_untrusted };
        let vals = Baseline::values(f);
        debug_assert_eq!(vals.len(), GAIT_FEATURES);
        let mut out = Vec::with_capacity(8);
        for (mi, name) in METRIC_NAMES.iter().enumerate() {
            let fi = METRIC_FEATURE[mi];
            let (mean, sd) = b.band_stats(bcfg, placement, fi);
            let value = vals[fi];
            // Gait metrics only mean something while walking (standing still is not "-11 SD of cadence"), and
            // gyro metrics need a gyro: a metric that is not evaluable reports distance 0 and in band.
            let evaluable = f.full && (f.is_walking || mi >= 5) && (f.has_gyro || (mi != 4 && mi != 6));
            let sd_distance = if evaluable { (value - mean) / sd.max(1e-6) } else { 0.0 };
            let in_band = !evaluable || Self::within(mi, sd_distance, k);
            out.push(MetricBand { name: (*name).to_string(), value, mean, sd, sd_distance, in_band });
        }
        Bands { bands: out, trusted }
    }

    /// Band test for metric `mi`: two-sided for the gait metrics, upper-only for the spike metrics.
    pub fn within(mi: usize, sd_distance: f32, k: f32) -> bool {
        if mi >= SPIKE_FIRST { sd_distance <= k } else { sd_distance.abs() <= k }
    }

    pub fn get(&self, name: &str) -> Option<&MetricBand> {
        self.bands.iter().find(|b| b.name == name)
    }

    /// Upper band edge for a metric (mean + k·sd).
    pub fn upper(&self, name: &str, k: f32) -> f32 {
        self.get(name).map(|b| b.mean + k * b.sd).unwrap_or(f32::MAX)
    }

    /// Unsteadiness metrics currently out of band on the concerning side, with the worst signed sd distance.
    pub fn unsteady_out(&self) -> (Vec<&str>, f32) {
        let mut names = Vec::new();
        let mut worst = 0.0f32;
        for (mi, b) in self.bands.iter().enumerate() {
            if b.in_band {
                continue;
            }
            let concerning = match UNSTEADY_SIDE[mi] {
                1 => b.sd_distance > 0.0,
                -1 => b.sd_distance < 0.0,
                _ => false,
            };
            if concerning {
                names.push(METRIC_NAMES[mi]);
                if b.sd_distance.abs() > worst.abs() {
                    worst = b.sd_distance;
                }
            }
        }
        (names, worst)
    }

    /// Compact JSON of the raw metric values.
    pub fn raw_json(&self) -> String {
        let mut s = String::from("{");
        for (i, b) in self.bands.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!("\"{}\":{:.4}", b.name, b.value));
        }
        s.push('}');
        s
    }
}
