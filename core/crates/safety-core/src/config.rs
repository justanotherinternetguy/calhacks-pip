//! Model parameters, loaded from `core/config/model-v1.toml`.
use crate::types::EngineError;
use serde::{Deserialize, Serialize};

pub const DEFAULT_TOML: &str = include_str!("../../../config/model-v1.toml");

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    pub hmm: HmmCfg,
    pub emissions: EmissionCfg,
    pub thresholds: ThresholdCfg,
    pub gait: GaitCfg,
    pub impact: ImpactCfg,
    pub snatch: SnatchCfg,
    pub baseline: BaselineCfg,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HmmCfg {
    pub initial: [f32; 4],
    pub step_seconds: u32,
    pub base_logits: [[f32; 4]; 4],
    pub context: ContextCfg,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContextCfg {
    pub away_from_home: [f32; 4],
    pub separated: [f32; 4],
    pub late: [f32; 4],
    pub rapid_drift: [f32; 4],
    pub late_hour_start: u8,
    pub late_hour_end: u8,
    pub rapid_drift_z_per_min: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EmissionCfg {
    pub p_walking: [f32; 4],
    pub gait_z_mean: [f32; 4],
    pub gait_z_sd: [f32; 4],
    pub p_impact: [f32; 4],
    pub stillness_buckets_s: [f32; 4],
    pub p_stillness: [[f32; 4]; 4],
    pub p_agitation: [f32; 4],
    pub p_audio: [f32; 4],
    pub p_touched: [f32; 4],
    pub p_wrong_phrase: [f32; 4],
    pub p_typing_impaired: [f32; 4],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ThresholdCfg {
    pub t_check: f32,
    pub t_heads_up: f32,
    pub t_unlock: f32,
    pub check_deadline_s: u32,
    pub dismiss_cooldown_s: u32,
    pub cooldown_threshold_boost: f32,
    pub dismiss_posterior: [f32; 4],
    pub check_repeat_cooldown_s: u32,
    pub risk_band_edges: [f32; 3],
    pub risk_band_hysteresis: f32,
    pub location_interval_s: [u32; 4],
    pub battery_dying_pct: u8,
    pub typing_z_reject: f32,
    pub typing_max_edit_ratio: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GaitCfg {
    pub sample_hz: f32,
    pub window_s: f32,
    pub hop_s: f32,
    pub band_low_hz: f32,
    pub band_high_hz: f32,
    pub peak_min_g: f32,
    pub min_step_interval_s: f32,
    pub walk_cadence_min: f32,
    pub walk_cadence_max: f32,
    pub run_cadence_min: f32,
    pub min_regularity_walk: f32,
    pub still_rms_g: f32,
    pub agitation_rms_g: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImpactCfg {
    pub free_fall_g: f32,
    pub min_free_fall_ms: u64,
    pub peak_g: f32,
    pub impact_window_ms: u64,
    pub post_window_ms: u64,
    pub orientation_change_deg: f32,
    pub post_still_rms_g: f32,
    pub drop_min_free_fall_ms: u64,
    pub drop_flat_gz: f32,
    pub drop_post_rms_g: f32,
    pub pickup_rms_g: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnatchCfg {
    pub jerk_g_per_s: f32,
    pub rotation_deg_per_s: f32,
    pub arm_window_s: u32,
    pub speed_mps: f32,
    pub confirm_s: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaselineCfg {
    pub mature_walking_s: f32,
    pub cold_start_z_scale: f32,
    pub min_samples: usize,
    pub max_samples: usize,
    pub ewma_alpha: f32,
    pub priors: GaitPriors,
    pub typing_priors: TypingPriors,
}

/// [median, sd] per feature
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GaitPriors {
    pub cadence: [f32; 2],
    pub step_cv: [f32; 2],
    pub regularity: [f32; 2],
    pub harmonic_ratio: [f32; 2],
    pub sway_rms: [f32; 2],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TypingPriors {
    pub ik_median_ms: [f32; 2],
    pub ik_cv: [f32; 2],
    pub backspace_rate: [f32; 2],
    pub edit_ratio: [f32; 2],
    pub ms_per_char: [f32; 2],
}

impl Config {
    pub fn from_toml(s: &str) -> Result<Config, EngineError> {
        let cfg: Config = toml::from_str(s).map_err(|e| EngineError::Config { msg: e.to_string() })?;
        cfg.validate()?;
        Ok(cfg)
    }

    pub fn default_v1() -> Config {
        Config::from_toml(DEFAULT_TOML).expect("bundled model-v1.toml is valid")
    }

    fn validate(&self) -> Result<(), EngineError> {
        let t = &self.thresholds;
        if !(t.t_heads_up <= t.t_check && t.t_check < t.t_unlock && t.t_unlock <= 1.0) {
            return Err(EngineError::Config {
                msg: "thresholds must satisfy t_heads_up <= t_check < t_unlock <= 1".into(),
            });
        }
        let s: f32 = self.hmm.initial.iter().sum();
        if (s - 1.0).abs() > 0.01 {
            return Err(EngineError::Config { msg: "hmm.initial must sum to 1".into() });
        }
        if self.gait.window_s <= 0.0 || self.gait.sample_hz <= 0.0 {
            return Err(EngineError::Config { msg: "gait window/sample rate must be positive".into() });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundled_config_parses() {
        let c = Config::default_v1();
        assert_eq!(c.hmm.step_seconds, 60);
        assert!((c.thresholds.t_check - 0.6).abs() < 1e-6);
    }
    #[test]
    fn bad_config_is_error() {
        assert!(matches!(Config::from_toml("nonsense = 1"), Err(EngineError::Config { .. })));
    }
}
