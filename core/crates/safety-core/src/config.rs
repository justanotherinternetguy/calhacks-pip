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
    pub grab: GrabCfg,
    pub signals: SignalCfg,
    pub sampling: SamplingCfg,
    pub sequence: SequenceCfg,
    pub log: LogCfg,
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
    /// per-from-state multiplier applied to the sequence agent's log-odds boost
    pub sequence: [f32; 4],
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
    /// no response for this long (since the check) and P >= t_unlock => UnlockLocation
    pub unlock_no_response_s: u32,
    /// no response for this long => CallOptionAvailable (once per episode)
    pub call_option_s: u32,
    /// grab: UnlockLocation this long after the immediate HeadsUp unless PhoneUnlocked/BiometricDismiss
    pub grab_unlock_s: u32,
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
    /// below this observed rate the window yields activity/energy only (no gait or gyro metrics)
    pub min_sample_hz: f32,
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
    /// a peak above this (any rate, no free fall needed) with an orientation change is an Impact incident
    pub incident_peak_g: f32,
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
pub struct GrabCfg {
    pub jerk_g_per_s: f32,
    pub rotation_deg_per_s: f32,
    pub in_hand_touch_s: f32,
    pub arm_window_s: u32,
    pub speed_mps: f32,
    pub confirm_s: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignalCfg {
    pub band_sd: f32,
    pub band_sd_untrusted: f32,
    pub drift_persist_s: f32,
    pub drift_refire_s: f32,
    pub drift_gap_s: f32,
    pub stillness_s: f32,
    pub stillness_after_impact_min: f32,
    pub separated_min: f32,
    pub separated_home_margin_m: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SamplingCfg {
    pub full_hz: u32,
    pub low_hz: u32,
    pub full_hour_start: u8,
    pub full_hour_end: u8,
    pub after_incident_min: f32,
    pub learn_walks_full_rate: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SequenceCfg {
    pub window_min: f32,
    pub prune_isolated_gait_drift_min: f32,
    pub max_boost: f32,
    pub w_gait_drift: f32,
    pub w_separated: f32,
    pub w_impact: f32,
    pub w_stillness: f32,
    pub w_grab: f32,
    pub w_typing_off: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LogCfg {
    pub expiry_h: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaselineCfg {
    pub trusted_days: u32,
    pub window_days: u32,
    pub sd_floor_frac: f32,
    pub cold_start_z_scale: f32,
    pub min_samples: usize,
    pub max_samples: usize,
    pub ewma_alpha: f32,
    pub priors: GaitPriors,
    pub typing_priors: TypingPriors,
}

/// [mean, sd] per feature
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GaitPriors {
    pub cadence: [f32; 2],
    pub step_cv: [f32; 2],
    pub regularity: [f32; 2],
    pub harmonic_ratio: [f32; 2],
    pub sway_rms: [f32; 2],
    pub wobble: [f32; 2],
    pub jerk: [f32; 2],
    pub rotation: [f32; 2],
    pub peak_g: [f32; 2],
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
    /// Parses a model config. Keys missing from `s` (e.g. a TOML written for an older schema, or a
    /// partial override served by the backend) fall back to the bundled `model-v1.toml`, so a
    /// config update never bricks the engine. Unknown keys are ignored.
    pub fn from_toml(s: &str) -> Result<Config, EngineError> {
        let user: toml::Value = toml::from_str(s).map_err(|e| EngineError::Config { msg: e.to_string() })?;
        let mut base: toml::Value =
            toml::from_str(DEFAULT_TOML).map_err(|e| EngineError::Config { msg: format!("bundled config: {e}") })?;
        merge_into(&mut base, user);
        let cfg: Config = base.try_into().map_err(|e: toml::de::Error| EngineError::Config { msg: e.to_string() })?;
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
        if self.gait.window_s <= 0.0 || self.gait.sample_hz <= 0.0 || self.gait.hop_s <= 0.0 {
            return Err(EngineError::Config { msg: "gait window/hop/sample rate must be positive".into() });
        }
        if self.sequence.max_boost < 0.0 || self.sequence.max_boost > 5.0 {
            return Err(EngineError::Config { msg: "sequence.max_boost must be within [0, 5]".into() });
        }
        if self.baseline.trusted_days == 0 || self.baseline.window_days < self.baseline.trusted_days {
            return Err(EngineError::Config { msg: "baseline.window_days must be >= trusted_days >= 1".into() });
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
        assert!((c.thresholds.t_check - 0.7).abs() < 1e-6);
        assert_eq!(c.thresholds.unlock_no_response_s, 120);
        assert_eq!(c.thresholds.call_option_s, 600);
        assert_eq!(c.baseline.trusted_days, 7);
    }
    #[test]
    fn bad_config_is_error() {
        // Unknown keys are ignored (defaults fill the rest); wrong types and invalid thresholds are errors.
        assert!(Config::from_toml("nonsense = 1").is_ok());
        assert!(matches!(Config::from_toml("[hmm]\nstep_seconds = \"x\""), Err(EngineError::Config { .. })));
        assert!(matches!(Config::from_toml("[thresholds]\nt_check = 1.5"), Err(EngineError::Config { .. })));
        assert!(matches!(Config::from_toml("not toml ="), Err(EngineError::Config { .. })));
    }
}

/// Deep-merge `over` into `base`: tables merge recursively, everything else is replaced.
fn merge_into(base: &mut toml::Value, over: toml::Value) {
    match (base, over) {
        (toml::Value::Table(b), toml::Value::Table(o)) => {
            for (k, v) in o {
                match b.get_mut(&k) {
                    Some(bv) if bv.is_table() && v.is_table() => merge_into(bv, v),
                    _ => {
                        b.insert(k, v);
                    }
                }
            }
        }
        (b, o) => *b = o,
    }
}

#[cfg(test)]
mod compat_tests {
    use super::*;

    #[test]
    fn older_schema_without_v11_sections_still_parses() {
        // Strip the v1.1 additions the way a pre-addendum config would look.
        let old: String = DEFAULT_TOML
            .lines()
            .filter(|l| !l.trim_start().starts_with("sequence = "))
            .collect::<Vec<_>>()
            .join("\n");
        let cut = old.find("[sequence]").expect("fixture has a [sequence] table");
        let next = old[cut + 1..].find("\n[").map(|i| cut + 1 + i).unwrap_or(old.len());
        let old = format!("{}{}", &old[..cut], &old[next..]);
        assert!(!old.contains("[sequence]"));
        let cfg = Config::from_toml(&old).expect("missing keys fall back to defaults");
        let fresh = Config::default_v1();
        assert_eq!(cfg.hmm.context.sequence, fresh.hmm.context.sequence);
    }

    #[test]
    fn empty_and_partial_overrides_use_defaults() {
        let cfg = Config::from_toml("").unwrap();
        assert_eq!(cfg.thresholds.t_check, Config::default_v1().thresholds.t_check);
        let cfg = Config::from_toml("[thresholds]\nt_check = 0.75\n").unwrap();
        assert_eq!(cfg.thresholds.t_check, 0.75);
        assert_eq!(cfg.thresholds.call_option_s, Config::default_v1().thresholds.call_option_s);
        assert!(Config::from_toml("[thresholds]\nt_check = \"nope\"\n").is_err());
    }
}
