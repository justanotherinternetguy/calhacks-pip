//! Grab (phone-snatch) detector, v1.1: in-hand (touched within 2 s or screen on in a held
//! orientation) + jerk spike above the user's jerk band + sharp rotation (gyro) above the rotation
//! band → followed by fast movement away (running cadence or speed > 3 m/s) ⇒ grab.
use super::{accel, angle_deg, gravity, gyro, norm};
use crate::config::GrabCfg;
use crate::types::MotionSample;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GrabEvent {
    pub t_ms: u64,
    pub jerk_g_per_s: f32,
    pub rotation_dps: f32,
    pub speed_mps: f32,
    pub running: bool,
}

pub struct GrabDetector {
    cfg: GrabCfg,
    prev: Option<MotionSample>,
    /// band upper edges (mean + k·sd) for jerk (g/s) and rotation (deg/s); the config floors always apply
    jerk_hi: f32,
    rot_hi: f32,
    armed: Option<(u64, f32, f32)>,
    fleeing_since: Option<u64>,
    pub fired: bool,
}

impl GrabDetector {
    pub fn new(cfg: &GrabCfg) -> Self {
        GrabDetector {
            cfg: cfg.clone(),
            prev: None,
            jerk_hi: cfg.jerk_g_per_s,
            rot_hi: cfg.rotation_deg_per_s,
            armed: None,
            fleeing_since: None,
            fired: false,
        }
    }

    /// Update the personal band edges (upper) for jerk and rotation.
    pub fn set_bands(&mut self, jerk_hi: f32, rot_hi: f32) {
        self.jerk_hi = jerk_hi;
        self.rot_hi = rot_hi;
    }

    pub fn is_armed(&self, now_ms: u64) -> bool {
        self.armed.map(|(t, _, _)| now_ms.saturating_sub(t) <= self.cfg.arm_window_s as u64 * 1000).unwrap_or(false)
    }

    /// Per-sample (full-rate only): detects the jerk/rotation trigger while the phone is in hand.
    pub fn push_sample(&mut self, s: &MotionSample, in_hand: bool) {
        if let Some(p) = self.prev {
            let dt = (s.t_ms.saturating_sub(p.t_ms)) as f32 / 1000.0;
            if dt > 0.0 && in_hand && !self.fired {
                let a = accel(s);
                let b = accel(&p);
                let jerk = norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]) / dt;
                let w = gyro(s);
                let rot = if norm(w) > 1e-6 { norm(w).to_degrees() } else { angle_deg(gravity(s), gravity(&p)) / dt };
                let jerk_thr = self.jerk_hi.max(self.cfg.jerk_g_per_s);
                let rot_thr = self.rot_hi.max(self.cfg.rotation_deg_per_s);
                if jerk > jerk_thr && rot > rot_thr {
                    self.armed = Some((s.t_ms, jerk, rot));
                    self.fleeing_since = None;
                }
            }
        }
        self.prev = Some(*s);
    }

    /// Per-window: confirm with running cadence / GPS speed; `separated` halves the confirm time.
    pub fn update(&mut self, now_ms: u64, is_running: bool, speed_mps: f32, separated: bool) -> Option<GrabEvent> {
        if self.fired {
            return None;
        }
        let (armed_ms, jerk, rot) = self.armed?;
        if now_ms.saturating_sub(armed_ms) > self.cfg.arm_window_s as u64 * 1000 {
            self.armed = None;
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
            return Some(GrabEvent { t_ms: now_ms, jerk_g_per_s: jerk, rotation_dps: rot, speed_mps, running: is_running });
        }
        None
    }

    pub fn reset(&mut self) {
        self.fired = false;
        self.armed = None;
        self.fleeing_since = None;
    }
}
