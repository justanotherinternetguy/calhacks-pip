//! Phone-snatch detector: sudden jerk + rotation while the screen is on →
//! running cadence or speed > 3 m/s → (separated from group) ⇒ snatch.
use super::{accel, angle_deg, gravity, norm};
use crate::config::SnatchCfg;
use crate::types::MotionSample;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnatchEvent {
    pub t_ms: u64,
    pub jerk_g_per_s: f32,
    pub summary_speed: f32,
}

pub struct SnatchDetector {
    cfg: SnatchCfg,
    prev: Option<MotionSample>,
    /// last jerk trigger time, if armed
    armed_at: Option<(u64, f32)>,
    fleeing_since: Option<u64>,
    pub fired: bool,
}

impl SnatchDetector {
    pub fn new(cfg: &SnatchCfg) -> Self {
        SnatchDetector { cfg: cfg.clone(), prev: None, armed_at: None, fleeing_since: None, fired: false }
    }

    /// Per-sample: detects the jerk/rotation trigger when the screen is on.
    pub fn push_sample(&mut self, s: &MotionSample, screen_on: bool) {
        if let Some(p) = self.prev {
            let dt = (s.t_ms.saturating_sub(p.t_ms)) as f32 / 1000.0;
            if dt > 0.0 && screen_on && !self.fired {
                let a = accel(s);
                let b = accel(&p);
                let jerk = norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) / dt;
                let rot = angle_deg(gravity(s), gravity(&p)) / dt;
                if jerk > self.cfg.jerk_g_per_s && rot > self.cfg.rotation_deg_per_s {
                    self.armed_at = Some((s.t_ms, jerk));
                    self.fleeing_since = None;
                }
            }
        }
        self.prev = Some(*s);
    }

    /// Per-window: confirm with running cadence / GPS speed; `separated` halves the confirm time.
    pub fn update(&mut self, now_ms: u64, is_running: bool, speed_mps: f32, separated: bool) -> Option<SnatchEvent> {
        if self.fired {
            return None;
        }
        let (armed_ms, jerk) = self.armed_at?;
        if now_ms.saturating_sub(armed_ms) > self.cfg.arm_window_s as u64 * 1000 {
            self.armed_at = None;
            self.fleeing_since = None;
            return None;
        }
        let fleeing = is_running || speed_mps > self.cfg.speed_mps;
        if !fleeing {
            self.fleeing_since = None;
            return None;
        }
        let since = *self.fleeing_since.get_or_insert(now_ms);
        let need = if separated { self.cfg.confirm_s as u64 * 500 } else { self.cfg.confirm_s as u64 * 1000 };
        if now_ms.saturating_sub(since) >= need {
            self.fired = true;
            return Some(SnatchEvent { t_ms: now_ms, jerk_g_per_s: jerk, summary_speed: speed_mps });
        }
        None
    }

    pub fn reset(&mut self) {
        self.fired = false;
        self.armed_at = None;
        self.fleeing_since = None;
    }
}
