//! Model parameters, loaded from `core/config/model-v1.toml`.
use crate::types::{EngineError, IncidentKind};
use serde::{Deserialize, Serialize};

pub const DEFAULT_TOML: &str = include_str!("../../../config/model-v1.toml");

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    pub thresholds: ThresholdCfg,
    pub gait: GaitCfg,
    pub impact: ImpactCfg,
    pub grab: GrabCfg,
    pub signals: SignalCfg,
    pub incidents: IncidentCfg,
    pub sampling: SamplingCfg,
    pub sequence: SequenceCfg,
    pub log: LogCfg,
    pub baseline: BaselineCfg,
}

/// Escalation timings. A check-in ("You okay?") is asked when a Danger incident is active or Watch incidents from
/// at least `check_min_families` independent families are active at once.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ThresholdCfg {
    /// false = log incidents only; no automatic check-in / heads-up / unlock / grab alert (manual SOS still works)
    pub auto_escalate: bool,
    /// Demo: an unanswered Danger incident (down after a fall, snoring, missed check-in) unlocks the location at once
    /// instead of waiting for the check-in deadline. Off in model-v1; model-demo.toml turns it on.
    #[serde(default)]
    pub unlock_on_danger: bool,
    /// the user gets this long to answer before CheckInMissed + HeadsUp
    pub check_deadline_s: u32,
    /// no response for this long (since the check) while the trigger still holds => UnlockLocation
    pub unlock_no_response_s: u32,
    /// no response for this long => CallOptionAvailable (once per episode)
    pub call_option_s: u32,
    /// grab: UnlockLocation this long after the immediate HeadsUp unless PhoneUnlocked/BiometricDismiss
    pub grab_unlock_s: u32,
    /// minimum gap between two Check prompts
    pub check_repeat_cooldown_s: u32,
    pub check_min_families: u32,
    /// encrypted location upload interval (seconds): normally, and once friends were alerted
    pub location_upload_s: u32,
    pub location_upload_alert_s: u32,
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
    /// dashboard peak-hold for the spike metrics (jerk, rotation, peak_g), seconds
    pub spike_hold_s: f32,
}

/// Opening and clearing rules for every incident kind (see model-v1.toml [incidents]).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IncidentCfg {
    pub drop_pickup_s: f32,
    pub down_after_fall_s: f32,
    pub unsteady_persist_s: f32,
    pub unsteady_clear_s: f32,
    pub drift_gap_s: f32,
    pub slowed_cadence_frac: f32,
    pub slowed_persist_s: f32,
    pub slowed_clear_s: f32,
    pub stumble_interval_dev: f32,
    pub stumble_lateral_g: f32,
    pub stumble_prune_min: f32,
    pub repeated_stumbles_n: u32,
    pub repeated_stumbles_window_min: f32,
    pub repeated_stumbles_clear_min: f32,
    pub set_down_rms_g: f32,
    pub set_down_s: f32,
    pub left_behind_min: f32,
    pub separated_min: f32,
    pub separated_home_margin_m: f32,
    pub stopped_min: f32,
    pub heading_home_window_min: f32,
    pub heading_home_margin_m: f32,
    pub moving_speed_mps: f32,
    pub battery_critical_pct: u8,
    pub battery_clear_pct: u8,
    pub scream_min: f32,
    pub scream_frames: u32,
    pub scream_window_s: f32,
    pub scream_after_s: f32,
    pub scream_clear_min: f32,
    pub loud_venue_db: f32,
    pub loud_venue_frames: u32,
    pub snore_min: f32,
    pub snore_frames: u32,
    pub snore_window_s: f32,
    pub listen_hold_min: f32,
    /// Kinds that ask "You okay?" on their own (snake_case names), once active for `check_alone_after_s`.
    #[serde(default)]
    pub check_alone: Vec<String>,
    #[serde(default)]
    pub check_alone_after_s: f32,
}

impl IncidentCfg {
    /// `check_alone` resolved to kinds (validated in `Config::validate`, so unknown names never reach here).
    pub fn check_alone_kinds(&self) -> Vec<IncidentKind> {
        self.check_alone.iter().filter_map(|n| IncidentKind::ALL.iter().copied().find(|k| k.name() == n)).collect()
    }
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

/// Escalation episodes: when a check-in, grab or SOS starts, every incident within `window_min` before it joins
/// the episode (sequence) and the friends' one-line summary is built from them.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SequenceCfg {
    pub window_min: f32,
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
        let err = |m: &str| Err(EngineError::Config { msg: m.into() });
        let t = &self.thresholds;
        if t.check_min_families < 1 {
            return err("thresholds.check_min_families must be >= 1");
        }
        if t.check_deadline_s == 0 || t.unlock_no_response_s < t.check_deadline_s {
            return err("thresholds: unlock_no_response_s must be >= check_deadline_s > 0");
        }
        if self.gait.window_s <= 0.0 || self.gait.sample_hz <= 0.0 || self.gait.hop_s <= 0.0 {
            return err("gait window/hop/sample rate must be positive");
        }
        let i = &self.incidents;
        if i.repeated_stumbles_n < 2 || i.scream_frames == 0 || i.snore_frames == 0 || i.loud_venue_frames == 0 {
            return err("incidents: repeated_stumbles_n >= 2 and frame counts >= 1");
        }
        if let Some(bad) = i.check_alone.iter().find(|n| !IncidentKind::ALL.iter().any(|k| k.name() == n.as_str())) {
            return Err(EngineError::Config { msg: format!("incidents.check_alone: unknown incident kind \"{bad}\"") });
        }
        if i.check_alone_after_s < 0.0 {
            return err("incidents.check_alone_after_s must be >= 0");
        }
        if !(0.0..1.0).contains(&i.slowed_cadence_frac) {
            return err("incidents.slowed_cadence_frac must be within [0, 1)");
        }
        if self.baseline.trusted_days == 0 || self.baseline.window_days < self.baseline.trusted_days {
            return err("baseline.window_days must be >= trusted_days >= 1");
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
        assert_eq!(c.thresholds.check_deadline_s, 120);
        assert_eq!(c.thresholds.unlock_no_response_s, 240);
        assert_eq!(c.thresholds.call_option_s, 600);
        assert_eq!(c.thresholds.check_min_families, 2);
        assert_eq!(c.baseline.trusted_days, 7);
        assert!((c.gait.hop_s - 1.0).abs() < 1e-6, "live metrics hop every second");
        assert!((c.signals.spike_hold_s - 8.0).abs() < 1e-6);
        assert!((c.incidents.down_after_fall_s - 15.0).abs() < 1e-6);
    }
    #[test]
    fn bad_config_is_error() {
        // Unknown keys are ignored (defaults fill the rest); wrong types and invalid values are errors.
        assert!(Config::from_toml("nonsense = 1").is_ok());
        assert!(matches!(Config::from_toml("[gait]\nhop_s = \"x\""), Err(EngineError::Config { .. })));
        assert!(matches!(Config::from_toml("[thresholds]\ncheck_min_families = 0"), Err(EngineError::Config { .. })));
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

    /// A v1.1 server config (HMM tables, P thresholds) still loads: its unknown keys are ignored, the keys that
    /// still exist apply, everything else comes from the bundled file.
    #[test]
    fn old_hmm_schema_still_parses() {
        let old = "[hmm]\nstep_seconds = 60\n[emissions]\np_impact = [0.1, 0.1, 0.6, 0.1]\n\
                   [thresholds]\nt_check = 0.7\nt_unlock = 0.9\ncheck_deadline_s = 90\n[sequence]\nmax_boost = 2.5\n";
        let cfg = Config::from_toml(old).expect("old keys are ignored");
        assert_eq!(cfg.thresholds.check_deadline_s, 90);
        assert_eq!(cfg.thresholds.unlock_no_response_s, Config::default_v1().thresholds.unlock_no_response_s);
    }

    #[test]
    fn demo_override_parses() {
        let cfg = Config::from_toml(include_str!("../../../config/model-demo.toml")).expect("demo override is valid");
        assert_eq!(cfg.thresholds.check_deadline_s, 30);
        assert_eq!(cfg.incidents.down_after_fall_s, 15.0);
    }

    #[test]
    fn empty_and_partial_overrides_use_defaults() {
        let cfg = Config::from_toml("").unwrap();
        assert_eq!(cfg.thresholds.check_deadline_s, Config::default_v1().thresholds.check_deadline_s);
        let cfg = Config::from_toml("[incidents]\ndown_after_fall_s = 30\n").unwrap();
        assert_eq!(cfg.incidents.down_after_fall_s, 30.0);
        assert_eq!(cfg.thresholds.call_option_s, Config::default_v1().thresholds.call_option_s);
        assert!(Config::from_toml("[incidents]\ndown_after_fall_s = \"nope\"\n").is_err());
    }
}
