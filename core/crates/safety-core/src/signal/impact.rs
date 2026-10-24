//! Impact / fall detector and "phone dropped alone" discrimination.
//! Fall pattern: free fall (<0.5 g) → peak (>3 g) → orientation change → low motion.
//! Coarse path (any rate, no free fall needed): peak > `incident_peak_g` → orientation change.
//! Timestamp-driven, so it works on 50 Hz and ~10 Hz input alike.
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

impl ImpactEvent {
    /// Spec v1.1: an Impact incident is a peak above `incident_peak_g` with an orientation change
    /// (or a fall-like impact), never a drop.
    pub fn is_incident(&self, cfg: &ImpactCfg) -> bool {
        self.kind != ImpactKind::Drop
            && self.peak_g > cfg.incident_peak_g
            && (self.orientation_change_deg >= cfg.orientation_change_deg || self.fall_likelihood >= 0.5)
    }
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
    /// recent gravity history (~0.6 s) for "orientation before"
    hist: VecDeque<(u64, [f32; 3])>,
    /// a drop is active until the phone is picked up
    pub drop_active: bool,
    drop_window: Vec<f32>,
    drop_window_start: u64,
}

impl ImpactDetector {
    pub fn new(cfg: &ImpactCfg) -> Self {
        ImpactDetector {
            cfg: cfg.clone(),
            st: St::Idle,
            hist: VecDeque::new(),
            drop_active: false,
            drop_window: Vec::new(),
            drop_window_start: 0,
        }
    }

    pub fn push(&mut self, s: &MotionSample) -> Option<ImpactEvent> {
        let mag = total_mag(s);
        let g = gravity(s);
        self.hist.push_back((s.t_ms, g));
        while self.hist.front().map(|(t, _)| s.t_ms.saturating_sub(*t) > 600).unwrap_or(false) {
            self.hist.pop_front();
        }
        if self.drop_active {
            if self.drop_window.is_empty() {
                self.drop_window_start = s.t_ms;
            }
            self.drop_window.push(mag - 1.0);
            if s.t_ms.saturating_sub(self.drop_window_start) >= 1000 {
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
                } else if mag > self.cfg.incident_peak_g {
                    // coarse path: hard peak without a preceding free fall
                    let g_before = self.hist.front().map(|(_, g)| *g).unwrap_or(g);
                    St::Impact { ff_ms: 0, start_ms: s.t_ms, peak: mag, g_before }
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
                    } else if mag > self.cfg.incident_peak_g {
                        St::Impact { ff_ms: 0, start_ms: s.t_ms, peak: mag, g_before }
                    } else {
                        St::Idle
                    }
                }
            }
            St::Impact { ff_ms, start_ms, peak, g_before } => {
                let peak = peak.max(mag);
                if s.t_ms - start_ms >= self.cfg.impact_window_ms {
                    let needed = if ff_ms > 0 { self.cfg.peak_g.min(self.cfg.incident_peak_g) } else { self.cfg.incident_peak_g };
                    if peak >= needed {
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
                    let hard = peak >= self.cfg.peak_g;
                    let (kind, like) = if ff_ms >= self.cfg.drop_min_free_fall_ms && flat && post_rms < self.cfg.drop_post_rms_g {
                        (ImpactKind::Drop, 0.1)
                    } else if orient >= self.cfg.orientation_change_deg && post_rms < self.cfg.post_still_rms_g {
                        let base = if ff_ms > 0 && hard { 0.6 } else { 0.5 };
                        (ImpactKind::Fall, (base + (peak - self.cfg.peak_g) * 0.1).clamp(base, 0.95))
                    } else if post_rms < self.cfg.post_still_rms_g && ff_ms > 0 && hard {
                        (ImpactKind::Fall, 0.5)
                    } else if orient >= self.cfg.orientation_change_deg {
                        (ImpactKind::Bump, 0.35)
                    } else {
                        (ImpactKind::Bump, if ff_ms > 0 { 0.3 } else { 0.15 })
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
