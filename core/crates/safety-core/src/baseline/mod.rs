//! Per-placement gait baselines as a rolling window of per-local-day statistics (v1.1), typing
//! baseline (robust median/MAD + EWMA), population priors until trusted, and the opaque blob
//! (JSON bytes) that also carries the incident log.
use crate::config::BaselineCfg;
use crate::log::LogState;
use crate::signal::GaitFeatures;
use crate::types::{EngineError, Placement};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct RobustStat {
    samples: VecDeque<f32>,
    pub ewma: f32,
    pub ewvar: f32,
    pub n: u32,
}

impl RobustStat {
    pub fn push(&mut self, x: f32, max_samples: usize, alpha: f32) {
        if self.n == 0 {
            self.ewma = x;
            self.ewvar = 0.0;
        } else {
            let d = x - self.ewma;
            self.ewma += alpha * d;
            self.ewvar = (1.0 - alpha) * (self.ewvar + alpha * d * d);
        }
        self.n += 1;
        self.samples.push_back(x);
        while self.samples.len() > max_samples {
            self.samples.pop_front();
        }
    }
    pub fn median(&self) -> f32 {
        let mut v: Vec<f32> = self.samples.iter().copied().collect();
        median_of(&mut v)
    }
    /// MAD scaled to a normal sd (×1.4826); floored to avoid division blow-ups.
    pub fn robust_sd(&self) -> f32 {
        let m = self.median();
        let mut v: Vec<f32> = self.samples.iter().map(|x| (x - m).abs()).collect();
        let mad = median_of(&mut v) * 1.4826;
        mad.max(m.abs() * 0.05).max(1e-3)
    }
}

pub fn median_of(v: &mut Vec<f32>) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// cadence, step_cv, regularity, harmonic_ratio, sway_rms, wobble, jerk, rotation, peak_g
pub const GAIT_FEATURES: usize = 9;

/// Sufficient statistics for one local day of walking windows. Each window is weighted by the hop it
/// covers (`seconds`), so `sum` / `sumsq` are time-weighted and the statistics do not depend on how
/// densely overlapping windows are emitted (1 s hop vs 2 s hop); `n` only counts windows.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct DayStats {
    pub day: i64,
    pub n: u32,
    pub sum: [f32; GAIT_FEATURES],
    pub sumsq: [f32; GAIT_FEATURES],
    /// total weight = seconds of walking covered
    pub seconds: f32,
}

impl DayStats {
    fn add(&mut self, v: &[f32; GAIT_FEATURES], seconds: f32) {
        let w = seconds.max(1e-3);
        for i in 0..GAIT_FEATURES {
            self.sum[i] += w * v[i];
            self.sumsq[i] += w * v[i] * v[i];
        }
        self.n += 1;
        self.seconds += w;
    }
    /// Blob versions < 3 stored unit-weighted sums: rescale them to the per-window seconds.
    fn migrate_unweighted(&mut self) {
        if self.n == 0 || self.seconds <= 0.0 {
            return;
        }
        let w = self.seconds / self.n as f32;
        for i in 0..GAIT_FEATURES {
            self.sum[i] *= w;
            self.sumsq[i] *= w;
        }
    }
    fn merge(&mut self, o: &DayStats) {
        for i in 0..GAIT_FEATURES {
            self.sum[i] += o.sum[i];
            self.sumsq[i] += o.sumsq[i];
        }
        self.n += o.n;
        self.seconds += o.seconds;
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PlacementStats {
    /// sorted by day, at most `window_days` entries
    pub days: Vec<DayStats>,
}

impl PlacementStats {
    fn day_mut(&mut self, day: i64) -> &mut DayStats {
        if let Some(i) = self.days.iter().position(|d| d.day == day) {
            return &mut self.days[i];
        }
        self.days.push(DayStats { day, ..Default::default() });
        self.days.sort_by_key(|d| d.day);
        let i = self.days.iter().position(|d| d.day == day).unwrap();
        &mut self.days[i]
    }
    fn prune(&mut self, today: i64, window_days: u32) {
        let oldest = today - window_days as i64 + 1;
        self.days.retain(|d| d.day >= oldest && d.day <= today + 1);
    }
    pub fn walk_days(&self) -> u32 {
        self.days.iter().filter(|d| d.n > 0).count() as u32
    }
    pub fn seconds(&self) -> f32 {
        self.days.iter().map(|d| d.seconds).sum()
    }
    pub fn n(&self) -> u32 {
        self.days.iter().map(|d| d.n).sum()
    }
    /// Pooled (time-weighted) mean / sd of one feature over the window.
    pub fn mean_sd(&self, i: usize) -> Option<(f32, f32)> {
        let n: u32 = self.days.iter().map(|d| d.n).sum();
        let w: f32 = self.days.iter().map(|d| d.seconds).sum();
        if n < 2 || w <= 0.0 {
            return None;
        }
        let sum: f32 = self.days.iter().map(|d| d.sum[i]).sum();
        let sumsq: f32 = self.days.iter().map(|d| d.sumsq[i]).sum();
        let mean = sum / w;
        let var = (sumsq / w - mean * mean).max(0.0);
        Some((mean, var.sqrt()))
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct TypingStats {
    pub feats: [RobustStat; 5],
    pub n: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Baseline {
    pub version: u32,
    /// committed per-day stats, indexed by Placement::index()
    #[serde(default)]
    pub gait_days: [PlacementStats; 4],
    /// walking seen during the current night session; committed when the session ends without an incident
    #[serde(default)]
    pub pending: [PlacementStats; 4],
    #[serde(default)]
    pub typing: TypingStats,
    /// incident log state (records expire after `log.expiry_h`); a log in an older shape loads empty
    #[serde(default, deserialize_with = "crate::log::lenient_log")]
    pub log: LogState,
}

/// Local day index from a wall-clock timestamp and the local hour the platform reports for it.
pub fn local_day(t_ms: u64, hour_local: u8) -> i64 {
    let utc_hour = ((t_ms / 3_600_000) % 24) as i64;
    let mut offset_h = hour_local as i64 - utc_hour;
    if offset_h > 14 {
        offset_h -= 24;
    } else if offset_h < -12 {
        offset_h += 24;
    }
    (t_ms as i64 + offset_h * 3_600_000).div_euclid(86_400_000)
}

impl Baseline {
    /// Blob format version: 3 = hop-weighted day statistics.
    pub const VERSION: u32 = 3;

    pub fn new() -> Self {
        Baseline { version: Self::VERSION, ..Default::default() }
    }
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
    pub fn from_bytes(b: &[u8]) -> Result<Self, EngineError> {
        let mut bl: Baseline = serde_json::from_slice(b).map_err(|e| EngineError::Baseline { msg: e.to_string() })?;
        if bl.version < Self::VERSION {
            for p in bl.gait_days.iter_mut().chain(bl.pending.iter_mut()) {
                for d in &mut p.days {
                    d.migrate_unweighted();
                }
            }
        }
        bl.version = Self::VERSION;
        Ok(bl)
    }
    pub fn walking_seconds(&self) -> f32 {
        self.gait_days.iter().map(|p| p.seconds()).sum()
    }
    pub fn values(f: &GaitFeatures) -> [f32; GAIT_FEATURES] {
        [
            f.cadence_spm,
            f.step_cv,
            f.regularity,
            f.harmonic_ratio,
            f.sway_rms,
            f.wobble_dps,
            f.jerk_peak,
            f.rot_peak_dps,
            f.peak_g,
        ]
    }
    pub fn priors(cfg: &BaselineCfg) -> [[f32; 2]; GAIT_FEATURES] {
        let p = &cfg.priors;
        [p.cadence, p.step_cv, p.regularity, p.harmonic_ratio, p.sway_rms, p.wobble, p.jerk, p.rotation, p.peak_g]
    }

    /// `priors` with the placement's overrides (`[baseline.placement_priors.<placement>]`) applied.
    pub fn priors_for(cfg: &BaselineCfg, placement: Placement) -> [[f32; 2]; GAIT_FEATURES] {
        let mut out = Self::priors(cfg);
        let pp = &cfg.placement_priors;
        let o = match placement {
            Placement::Unknown => &pp.unknown,
            Placement::Pocket => &pp.pocket,
            Placement::Hand => &pp.hand,
            Placement::Bag => &pp.bag,
        };
        let over = [o.cadence, o.step_cv, o.regularity, o.harmonic_ratio, o.sway_rms, o.wobble, o.jerk, o.rotation, o.peak_g];
        for (i, v) in over.into_iter().enumerate() {
            if let Some(v) = v {
                out[i] = v;
            }
        }
        out
    }

    /// Learn one walking window, weighted by `hop_s` (the seconds of walking it stands for). `session` =
    /// buffer into the pending night session instead of committing.
    pub fn learn(&mut self, cfg: &BaselineCfg, placement: Placement, f: &GaitFeatures, hop_s: f32, day: i64, session: bool) {
        let v = Self::values(f);
        let target = if session { &mut self.pending } else { &mut self.gait_days };
        target[placement.index()].day_mut(day).add(&v, hop_s);
        if !session {
            self.prune(cfg, day);
        }
    }

    /// Drop days outside the rolling window.
    pub fn prune(&mut self, cfg: &BaselineCfg, today: i64) {
        for p in &mut self.gait_days {
            p.prune(today, cfg.window_days);
        }
    }

    /// Night session ended without an incident: fold the pending windows into the committed days.
    pub fn commit_session(&mut self, cfg: &BaselineCfg) {
        let pending = std::mem::take(&mut self.pending);
        let mut today = i64::MIN;
        for (pi, p) in pending.iter().enumerate() {
            for d in &p.days {
                self.gait_days[pi].day_mut(d.day).merge(d);
                today = today.max(d.day);
            }
        }
        if today != i64::MIN {
            self.prune(cfg, today);
        }
    }

    /// Night session produced an incident: its walking is not representative.
    pub fn discard_session(&mut self) {
        self.pending = Default::default();
    }

    pub fn pending_seconds(&self) -> f32 {
        self.pending.iter().map(|p| p.seconds()).sum()
    }

    pub fn walk_days(&self, placement: Placement) -> u32 {
        self.gait_days[placement.index()].walk_days()
    }
    /// Distinct local days with walking data across all placements.
    pub fn walk_days_total(&self) -> u32 {
        let mut days: Vec<i64> = self.gait_days.iter().flat_map(|p| p.days.iter().filter(|d| d.n > 0).map(|d| d.day)).collect();
        days.sort_unstable();
        days.dedup();
        days.len() as u32
    }
    pub fn trusted(&self, cfg: &BaselineCfg, placement: Placement) -> bool {
        self.walk_days(placement) >= cfg.trusted_days
    }
    pub fn any_trusted(&self, cfg: &BaselineCfg) -> bool {
        self.gait_days.iter().any(|p| p.walk_days() >= cfg.trusted_days)
    }

    /// (mean, sd) for one feature: personal pooled stats once trusted (sd floored at a fraction of
    /// the prior sd), population priors otherwise.
    pub fn band_stats(&self, cfg: &BaselineCfg, placement: Placement, i: usize) -> (f32, f32) {
        let pr = Self::priors_for(cfg, placement)[i];
        if self.trusted(cfg, placement) {
            if let Some((m, sd)) = self.gait_days[placement.index()].mean_sd(i) {
                return (m, sd.max(pr[1] * cfg.sd_floor_frac).max(1e-4));
            }
        }
        (pr[0], pr[1].max(1e-4))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn robust_stat_median_mad() {
        let mut r = RobustStat::default();
        for x in [1.0, 2.0, 3.0, 4.0, 100.0] {
            r.push(x, 100, 0.1);
        }
        assert_eq!(r.median(), 3.0);
        assert!(r.robust_sd() < 5.0);
    }
    #[test]
    fn baseline_roundtrip_and_rolling_window() {
        let cfg = crate::config::Config::default_v1().baseline;
        let mut b = Baseline::new();
        let f = GaitFeatures { cadence_spm: 110.0, step_cv: 0.05, regularity: 0.85, harmonic_ratio: 2.8, sway_rms: 0.07, ..Default::default() };
        for _ in 0..20 {
            b.learn(&cfg, Placement::Pocket, &f, 2.0, 100, false);
        }
        let bytes = b.to_bytes();
        let back = Baseline::from_bytes(&bytes).unwrap();
        assert_eq!(b, back);
        assert!((back.walking_seconds() - 40.0).abs() < 1e-3);
        assert!(Baseline::from_bytes(b"garbage").is_err());
        // 7 distinct days => trusted; a day 14 later drops the oldest
        for d in 101..107 {
            b.learn(&cfg, Placement::Pocket, &f, 2.0, d, false);
        }
        assert_eq!(b.walk_days(Placement::Pocket), 7);
        assert!(b.trusted(&cfg, Placement::Pocket));
        assert!(!b.trusted(&cfg, Placement::Hand));
        b.learn(&cfg, Placement::Pocket, &f, 2.0, 114, false);
        assert_eq!(b.walk_days(Placement::Pocket), 7); // day 100 dropped
        assert!(b.gait_days[1].days.iter().all(|d| d.day >= 101));
        // personal band after trust: mean at the learned value, sd floored
        let (m, sd) = b.band_stats(&cfg, Placement::Pocket, 0);
        assert!((m - 110.0).abs() < 1e-3 && sd >= cfg.priors.cadence[1] * cfg.sd_floor_frac);
    }
    /// Learning the same walk with a 1 s hop (twice the windows) must give the same statistics and the same
    /// walking seconds as with a 2 s hop, and an old unit-weighted blob must load to the same mean.
    #[test]
    fn learning_is_hop_invariant_and_old_blobs_migrate() {
        let cfg = crate::config::Config::default_v1().baseline;
        let feats: Vec<GaitFeatures> = (0..40)
            .map(|i| GaitFeatures { cadence_spm: 100.0 + (i % 5) as f32 * 5.0, step_cv: 0.03 + (i % 3) as f32 * 0.01, ..Default::default() })
            .collect();
        let mut b1 = Baseline::new();
        let mut b2 = Baseline::new();
        for (i, f) in feats.iter().enumerate() {
            b1.learn(&cfg, Placement::Pocket, f, 1.0, 100 + (i / 20) as i64, false);
            if i % 2 == 0 {
                b2.learn(&cfg, Placement::Pocket, f, 2.0, 100 + (i / 20) as i64, false);
            }
        }
        assert!((b1.walking_seconds() - 40.0).abs() < 1e-3 && (b2.walking_seconds() - 40.0).abs() < 1e-3);
        for i in 0..2 {
            let (m1, s1) = b1.gait_days[1].mean_sd(i).unwrap();
            let (m2, s2) = b2.gait_days[1].mean_sd(i).unwrap();
            // b2 sees every other window, so means agree up to the sampling of the pattern
            assert!((m1 - m2).abs() < 0.05 * m1.abs().max(0.01) && (s1 - s2).abs() < 0.5 * s1.max(0.005), "feature {i}: {m1}/{s1} vs {m2}/{s2}");
        }
        // version-2 blob: unit-weighted sums, seconds = 2 per window
        let v2 = r#"{"version":2,"gait_days":[{"days":[]},{"days":[{"day":100,"n":2,"sum":[220,0,0,0,0,0,0,0,0],"sumsq":[24200,0,0,0,0,0,0,0,0],"seconds":4}]},{"days":[]},{"days":[]}],"pending":[{"days":[]},{"days":[]},{"days":[]},{"days":[]}]}"#;
        let b = Baseline::from_bytes(v2.as_bytes()).unwrap();
        assert_eq!(b.version, Baseline::VERSION);
        let (m, sd) = b.gait_days[1].mean_sd(0).unwrap();
        assert!((m - 110.0).abs() < 1e-3 && sd < 1e-2, "{m} {sd}");
        assert!((b.walking_seconds() - 4.0).abs() < 1e-3);
    }

    #[test]
    fn session_commit_and_discard() {
        let cfg = crate::config::Config::default_v1().baseline;
        let mut b = Baseline::new();
        let f = GaitFeatures { cadence_spm: 110.0, ..Default::default() };
        b.learn(&cfg, Placement::Pocket, &f, 2.0, 5, true);
        assert_eq!(b.walking_seconds(), 0.0);
        b.discard_session();
        assert_eq!(b.pending_seconds(), 0.0);
        b.learn(&cfg, Placement::Pocket, &f, 2.0, 5, true);
        b.commit_session(&cfg);
        assert_eq!(b.walking_seconds(), 2.0);
        assert_eq!(b.walk_days(Placement::Pocket), 1);
    }
    #[test]
    fn local_day_uses_platform_hour() {
        // t = 23:30 UTC on day 0, platform says local hour 1 => already the next local day
        let t = 23 * 3_600_000 + 30 * 60_000;
        assert_eq!(local_day(t, 1), 1);
        assert_eq!(local_day(t, 23), 0);
        assert_eq!(local_day(0, 14), 0);
    }
}
