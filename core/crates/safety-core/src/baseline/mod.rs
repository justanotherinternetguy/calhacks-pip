//! Robust per-placement gait baselines (median/MAD + EWMA), population priors
//! for cold start, opaque serialization (JSON bytes).
use crate::config::BaselineCfg;
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

pub const GAIT_FEATURES: usize = 5; // cadence, step_cv, regularity, harmonic_ratio, sway_rms

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct PlacementStats {
    pub feats: [RobustStat; GAIT_FEATURES],
    pub seconds: f32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct TypingStats {
    pub feats: [RobustStat; 5],
    pub n: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Baseline {
    pub version: u32,
    /// indexed by Placement::index()
    pub gait: [PlacementStats; 4],
    pub typing: TypingStats,
}

/// z-scores per gait feature, positive = toward impairment.
#[derive(Clone, Copy, Debug, Default)]
pub struct GaitZ {
    pub cadence: f32,
    pub step_cv: f32,
    pub regularity: f32,
    pub harmonic_ratio: f32,
    pub sway_rms: f32,
    /// aggregate drift score (≥0)
    pub drift: f32,
}

impl Baseline {
    pub fn new() -> Self {
        Baseline { version: 1, ..Default::default() }
    }
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
    pub fn from_bytes(b: &[u8]) -> Result<Self, EngineError> {
        serde_json::from_slice(b).map_err(|e| EngineError::Baseline { msg: e.to_string() })
    }
    pub fn walking_seconds(&self) -> f32 {
        self.gait.iter().map(|p| p.seconds).sum()
    }
    fn values(f: &GaitFeatures) -> [f32; GAIT_FEATURES] {
        [f.cadence_spm, f.step_cv, f.regularity, f.harmonic_ratio, f.sway_rms]
    }
    pub fn learn(&mut self, cfg: &BaselineCfg, placement: Placement, f: &GaitFeatures, hop_s: f32) {
        let p = &mut self.gait[placement.index()];
        for (i, v) in Self::values(f).iter().enumerate() {
            p.feats[i].push(*v, cfg.max_samples, cfg.ewma_alpha);
        }
        p.seconds += hop_s;
    }
    /// Weight of the personal baseline vs. population priors (0..1).
    pub fn maturity(&self, cfg: &BaselineCfg, placement: Placement) -> f32 {
        let p = &self.gait[placement.index()];
        if p.feats[0].n < cfg.min_samples as u32 {
            return 0.0;
        }
        (self.walking_seconds() / cfg.mature_walking_s).clamp(0.0, 1.0)
    }
    pub fn zscore(&self, cfg: &BaselineCfg, placement: Placement, f: &GaitFeatures) -> GaitZ {
        let pr = &cfg.priors;
        let priors = [pr.cadence, pr.step_cv, pr.regularity, pr.harmonic_ratio, pr.sway_rms];
        let w = self.maturity(cfg, placement);
        let p = &self.gait[placement.index()];
        let vals = Self::values(f);
        let mut z = [0.0f32; GAIT_FEATURES];
        for i in 0..GAIT_FEATURES {
            let (pm, psd) = (priors[i][0], priors[i][1]);
            let (m, sd) = if w > 0.0 {
                (w * p.feats[i].median() + (1.0 - w) * pm, w * p.feats[i].robust_sd() + (1.0 - w) * psd)
            } else {
                (pm, psd)
            };
            z[i] = (vals[i] - m) / sd.max(1e-3);
        }
        // direction: cv up, regularity down, HR down, sway up, cadence either way
        let dir = [z[0].abs() * 0.5, z[1], -z[2], -z[3], z[4]];
        let scale = if w < 1.0 { cfg.cold_start_z_scale + (1.0 - cfg.cold_start_z_scale) * w } else { 1.0 };
        let mut pos: Vec<f32> = dir.iter().map(|d| d.max(0.0)).collect();
        pos.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        let drift = ((pos[0] + pos[1] + pos[2]) / 2.0 * scale).min(4.0);
        GaitZ { cadence: z[0], step_cv: z[1], regularity: z[2], harmonic_ratio: z[3], sway_rms: z[4], drift }
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
    fn baseline_roundtrip() {
        let cfg = crate::config::Config::default_v1().baseline;
        let mut b = Baseline::new();
        let f = GaitFeatures { cadence_spm: 110.0, step_cv: 0.05, regularity: 0.85, harmonic_ratio: 2.8, sway_rms: 0.07, ..Default::default() };
        for _ in 0..20 {
            b.learn(&cfg, Placement::Pocket, &f, 2.0);
        }
        let bytes = b.to_bytes();
        let back = Baseline::from_bytes(&bytes).unwrap();
        assert_eq!(b, back);
        assert!((back.walking_seconds() - 40.0).abs() < 1e-3);
        assert!(Baseline::from_bytes(b"garbage").is_err());
    }
}
