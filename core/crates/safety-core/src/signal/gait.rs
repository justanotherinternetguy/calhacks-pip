//! Gait features from a sliding window of orientation-independent acceleration.
use super::{project, rms};
use crate::config::GaitCfg;
use crate::types::MotionSample;
use std::collections::VecDeque;
use std::f32::consts::PI;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GaitFeatures {
    pub t_ms: u64,
    pub steps: usize,
    pub cadence_spm: f32,
    pub step_cv: f32,
    pub regularity: f32,
    pub harmonic_ratio: f32,
    pub sway_rms: f32,
    /// RMS of total user-acceleration magnitude (g)
    pub energy_rms: f32,
    pub is_walking: bool,
    pub is_running: bool,
    /// high energy, no periodic gait (0..1)
    pub agitation: f32,
    /// median gravity vector over the window
    pub gravity: [f32; 3],
    pub gravity_var: f32,
}

/// RBJ biquad (direct form 1), applied statelessly per window.
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
}
impl Biquad {
    fn lowpass(f: f32, fs: f32) -> Self {
        let w0 = 2.0 * PI * f / fs;
        let (sn, cs) = (w0.sin(), w0.cos());
        let alpha = sn / (2.0 * 0.7071);
        let a0 = 1.0 + alpha;
        Biquad {
            b: [(1.0 - cs) / 2.0 / a0, (1.0 - cs) / a0, (1.0 - cs) / 2.0 / a0],
            a: [-2.0 * cs / a0, (1.0 - alpha) / a0],
        }
    }
    fn highpass(f: f32, fs: f32) -> Self {
        let w0 = 2.0 * PI * f / fs;
        let (sn, cs) = (w0.sin(), w0.cos());
        let alpha = sn / (2.0 * 0.7071);
        let a0 = 1.0 + alpha;
        Biquad {
            b: [(1.0 + cs) / 2.0 / a0, -(1.0 + cs) / a0, (1.0 + cs) / 2.0 / a0],
            a: [-2.0 * cs / a0, (1.0 - alpha) / a0],
        }
    }
    fn apply(&self, x: &[f32]) -> Vec<f32> {
        let mut y = vec![0.0f32; x.len()];
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for i in 0..x.len() {
            let v = self.b[0] * x[i] + self.b[1] * x1 + self.b[2] * x2 - self.a[0] * y1 - self.a[1] * y2;
            x2 = x1;
            x1 = x[i];
            y2 = y1;
            y1 = v;
            y[i] = v;
        }
        y
    }
}

pub fn bandpass(x: &[f32], lo: f32, hi: f32, fs: f32) -> Vec<f32> {
    let hp = Biquad::highpass(lo, fs).apply(x);
    Biquad::lowpass(hi, fs).apply(&hp)
}

/// Simple peak picker with minimum spacing; returns sample indices.
pub fn find_peaks(x: &[f32], min_height: f32, min_dist: usize) -> Vec<usize> {
    let mut peaks = Vec::new();
    for i in 1..x.len().saturating_sub(1) {
        if x[i] > min_height && x[i] >= x[i - 1] && x[i] > x[i + 1] {
            if let Some(&last) = peaks.last() {
                if i - last < min_dist {
                    if x[i] > x[last] {
                        *peaks.last_mut().unwrap() = i;
                    }
                    continue;
                }
            }
            peaks.push(i);
        }
    }
    peaks
}

/// Max normalized autocorrelation over lags in [min_lag, max_lag].
pub fn autocorr_peak(x: &[f32], min_lag: usize, max_lag: usize) -> f32 {
    let n = x.len();
    if n < max_lag + 10 {
        return 0.0;
    }
    let mean = x.iter().sum::<f32>() / n as f32;
    let xc: Vec<f32> = x.iter().map(|v| v - mean).collect();
    let mut best = 0.0f32;
    for lag in min_lag..=max_lag {
        let (mut num, mut d1, mut d2) = (0.0f32, 0.0f32, 0.0f32);
        for i in 0..n - lag {
            num += xc[i] * xc[i + lag];
            d1 += xc[i] * xc[i];
            d2 += xc[i + lag] * xc[i + lag];
        }
        let d = (d1 * d2).sqrt();
        if d > 1e-9 {
            best = best.max(num / d);
        }
    }
    best
}

/// Amplitude of x at frequency f (Hz) via direct DFT.
fn dft_amp(x: &[f32], f: f32, fs: f32) -> f32 {
    let (mut re, mut im) = (0.0f32, 0.0f32);
    for (i, v) in x.iter().enumerate() {
        let ph = 2.0 * PI * f * i as f32 / fs;
        re += v * ph.cos();
        im -= v * ph.sin();
    }
    (re * re + im * im).sqrt() / x.len() as f32
}

/// Harmonic ratio of vertical accel relative to stride frequency (even/odd harmonics).
fn harmonic_ratio(x: &[f32], stride_hz: f32, fs: f32) -> f32 {
    if stride_hz <= 0.0 {
        return 0.0;
    }
    let mut even = 0.0;
    let mut odd = 0.0;
    for k in 1..=6 {
        let a = dft_amp(x, stride_hz * k as f32, fs);
        if k % 2 == 0 {
            even += a
        } else {
            odd += a
        }
    }
    even / odd.max(1e-4)
}

fn median(v: &mut Vec<f32>) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[v.len() / 2]
}

pub fn compute_features(cfg: &GaitCfg, win: &[MotionSample]) -> GaitFeatures {
    let fs = cfg.sample_hz;
    let n = win.len();
    let mut vert = Vec::with_capacity(n);
    let mut horiz = Vec::with_capacity(n);
    let mut mags = Vec::with_capacity(n);
    let (mut gx, mut gy, mut gz) = (Vec::new(), Vec::new(), Vec::new());
    for s in win {
        let (v, h) = project(s);
        vert.push(v);
        horiz.push(h);
        mags.push((s.ax * s.ax + s.ay * s.ay + s.az * s.az).sqrt());
        gx.push(s.gx);
        gy.push(s.gy);
        gz.push(s.gz);
    }
    let gm = [median(&mut gx.clone()), median(&mut gy.clone()), median(&mut gz.clone())];
    let gvar = {
        let mut acc = 0.0f32;
        for i in 0..n {
            acc += (gx[i] - gm[0]).powi(2) + (gy[i] - gm[1]).powi(2) + (gz[i] - gm[2]).powi(2);
        }
        acc / n.max(1) as f32
    };

    let vb = bandpass(&vert, cfg.band_low_hz, cfg.band_high_hz, fs);
    let hb = bandpass(&horiz, cfg.band_low_hz, cfg.band_high_hz, fs);
    // skip filter warm-up
    let skip = (fs * 0.5) as usize;
    let vb = &vb[skip.min(vb.len())..];
    let hb = &hb[skip.min(hb.len())..];

    let min_dist = (cfg.min_step_interval_s * fs) as usize;
    let peaks = find_peaks(vb, cfg.peak_min_g, min_dist.max(1));
    let steps = peaks.len();
    let dur_s = vb.len() as f32 / fs;
    let mut cadence = 0.0;
    let mut step_cv = 0.0;
    if steps >= 2 {
        let intervals: Vec<f32> = peaks.windows(2).map(|w| (w[1] - w[0]) as f32 / fs).collect();
        let mean = intervals.iter().sum::<f32>() / intervals.len() as f32;
        let var = intervals.iter().map(|i| (i - mean).powi(2)).sum::<f32>() / intervals.len() as f32;
        step_cv = var.sqrt() / mean.max(1e-3);
        cadence = 60.0 / mean.max(1e-3);
    } else if steps == 1 {
        cadence = 60.0 / dur_s;
    }
    let regularity = autocorr_peak(vb, (0.25 * fs) as usize, (1.5 * fs) as usize);
    let hr = if cadence > 0.0 { harmonic_ratio(vb, cadence / 60.0 / 2.0, fs) } else { 0.0 };
    let sway = rms(hb);
    let energy = rms(&mags);
    let periodic = regularity >= cfg.min_regularity_walk && steps >= (dur_s * 0.8) as usize;
    let is_walking = periodic && cadence >= cfg.walk_cadence_min && cadence < cfg.walk_cadence_max;
    let is_running = periodic && cadence >= cfg.run_cadence_min;
    let agitation = if !is_walking && !is_running && energy > cfg.agitation_rms_g && regularity < 0.6 {
        ((energy - cfg.agitation_rms_g) / 0.4).clamp(0.0, 1.0)
    } else {
        0.0
    };
    GaitFeatures {
        t_ms: win.last().map(|s| s.t_ms).unwrap_or(0),
        steps,
        cadence_spm: cadence,
        step_cv,
        regularity,
        harmonic_ratio: hr,
        sway_rms: sway,
        energy_rms: energy,
        is_walking,
        is_running,
        agitation,
        gravity: gm,
        gravity_var: gvar,
    }
}

/// Keeps a ring buffer of samples and emits features every `hop_s`.
pub struct GaitAnalyzer {
    cfg: GaitCfg,
    buf: VecDeque<MotionSample>,
    last_emit_ms: u64,
}

impl GaitAnalyzer {
    pub fn new(cfg: &GaitCfg) -> Self {
        GaitAnalyzer { cfg: cfg.clone(), buf: VecDeque::new(), last_emit_ms: 0 }
    }
    pub fn window_len(&self) -> usize {
        (self.cfg.window_s * self.cfg.sample_hz) as usize
    }
    /// Push a sample; returns features when a new hop completes.
    pub fn push(&mut self, s: MotionSample) -> Option<GaitFeatures> {
        self.buf.push_back(s);
        let wl = self.window_len();
        while self.buf.len() > wl {
            self.buf.pop_front();
        }
        if self.buf.len() < wl {
            return None;
        }
        if s.t_ms.saturating_sub(self.last_emit_ms) < (self.cfg.hop_s * 1000.0) as u64 {
            return None;
        }
        self.last_emit_ms = s.t_ms;
        let win: Vec<MotionSample> = self.buf.iter().copied().collect();
        Some(compute_features(&self.cfg, &win))
    }
}
