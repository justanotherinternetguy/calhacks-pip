//! Impact / fall detector and "phone dropped alone" discrimination.
//! Pattern: free fall (<0.5 g) → peak (>3 g) → orientation change → low motion.
use super::{angle_deg, gravity, rms, total_mag};
use crate::config::ImpactCfg;
use crate::types::MotionSample;
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImpactKind {
    /// body fall: short free fall, hard peak, orientation change, little motion after
    Fall,
    /// phone dropped alone: long free fall, lands flat, no body motion after
    Drop,
    /// hard impact but the person kept moving
    Bump,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImpactEvent {
    pub t_ms: u64,
    pub kind: ImpactKind,
    pub peak_g: f32,
    pub free_fall_ms: u64,
    pub orientation_change_deg: f32,
    pub post_motion_rms: f32,
    /// likelihood that this is a fall of the person (0..1)
    pub fall_likelihood: f32,
}

enum St {
    Idle,
    FreeFall { start_ms: u64, g_before: [f32; 3] },
    Impact { ff_ms: u64, start_ms: u64, peak: f32, g_before: [f32; 3] },
    Post { ff_ms: u64, impact_ms: u64, peak: f32, g_before: [f32; 3], mags: Vec<f32>, gs: Vec<[f32; 3]> },
}

pub struct ImpactDetector {
    cfg: ImpactCfg,
    st: St,
    /// recent gravity history (~0.5 s) for "orientation before"
    hist: VecDeque<(u64, [f32; 3])>,
    /// a drop is active until the phone is picked up
    pub drop_active: bool,
    drop_window: Vec<f32>,
}

impl ImpactDetector {
    pub fn new(cfg: &ImpactCfg) -> Self {
        ImpactDetector { cfg: cfg.clone(), st: St::Idle, hist: VecDeque::new(), drop_active: false, drop_window: Vec::new() }
    }

    pub fn push(&mut self, s: &MotionSample) -> Option<ImpactEvent> {
        let mag = total_mag(s);
        let g = gravity(s);
        self.hist.push_back((s.t_ms, g));
        while self.hist.front().map(|(t, _)| s.t_ms.saturating_sub(*t) > 600).unwrap_or(false) {
            self.hist.pop_front();
        }
        if self.drop_active {
            self.drop_window.push(mag - 1.0);
            if self.drop_window.len() >= 50 {
                if rms(&self.drop_window) > self.cfg.pickup_rms_g {
                    self.drop_active = false;
                }
                self.drop_window.clear();
            }
        }
        let st = std::mem::replace(&mut self.st, St::Idle);
        let mut out = None;
        self.st = match st {
            St::Idle => {
                if mag < self.cfg.free_fall_g {
                    let g_before = self.hist.front().map(|(_, g)| *g).unwrap_or(g);
                    St::FreeFall { start_ms: s.t_ms, g_before }
                } else {
                    St::Idle
                }
            }
            St::FreeFall { start_ms, g_before } => {
                if mag < self.cfg.free_fall_g {
                    St::FreeFall { start_ms, g_before }
                } else {
                    let ff = s.t_ms - start_ms;
                    if ff >= self.cfg.min_free_fall_ms {
                        St::Impact { ff_ms: ff, start_ms: s.t_ms, peak: mag, g_before }
                    } else {
                        St::Idle
                    }
                }
            }
            St::Impact { ff_ms, start_ms, peak, g_before } => {
                let peak = peak.max(mag);
                if s.t_ms - start_ms >= self.cfg.impact_window_ms {
                    if peak >= self.cfg.peak_g {
                        St::Post { ff_ms, impact_ms: start_ms, peak, g_before, mags: Vec::new(), gs: Vec::new() }
                    } else {
                        St::Idle
                    }
                } else {
                    St::Impact { ff_ms, start_ms, peak, g_before }
                }
            }
            St::Post { ff_ms, impact_ms, peak, g_before, mut mags, mut gs } => {
                mags.push(mag - 1.0);
                gs.push(g);
                if s.t_ms - impact_ms >= self.cfg.impact_window_ms + self.cfg.post_window_ms {
                    let n = gs.len().max(1) as f32;
                    let g_after = gs.iter().fold([0.0f32; 3], |a, g| [a[0] + g[0] / n, a[1] + g[1] / n, a[2] + g[2] / n]);
                    let post_rms = rms(&mags);
                    let orient = angle_deg(g_before, g_after);
                    let flat = g_after[2].abs() > self.cfg.drop_flat_gz;
                    let (kind, like) = if ff_ms >= self.cfg.drop_min_free_fall_ms && flat && post_rms < self.cfg.drop_post_rms_g {
                        (ImpactKind::Drop, 0.1)
                    } else if orient >= self.cfg.orientation_change_deg && post_rms < self.cfg.post_still_rms_g {
                        (ImpactKind::Fall, (0.6 + (peak - self.cfg.peak_g) * 0.1).clamp(0.6, 0.95))
                    } else if post_rms < self.cfg.post_still_rms_g {
                        (ImpactKind::Fall, 0.5)
                    } else {
                        (ImpactKind::Bump, 0.3)
                    };
                    if kind == ImpactKind::Drop {
                        self.drop_active = true;
                        self.drop_window.clear();
                    }
                    out = Some(ImpactEvent {
                        t_ms: impact_ms,
                        kind,
                        peak_g: peak,
                        free_fall_ms: ff_ms,
                        orientation_change_deg: orient,
                        post_motion_rms: post_rms,
                        fall_likelihood: like,
                    });
                    St::Idle
                } else {
                    St::Post { ff_ms, impact_ms, peak, g_before, mags, gs }
                }
            }
        };
        out
    }
}
