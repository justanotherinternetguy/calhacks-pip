//! Gait features from a sliding window of orientation-independent acceleration (+ gyro).
//! Rate-aware: every filter and lag is designed from the sample rate observed in the window, and a
//! window below `min_sample_hz` (low-rate mode) yields only energy / peak / gravity.
use super::{cross, dot, norm, project, rms, total_mag};
use crate::config::GaitCfg;
use crate::types::MotionSample;
use std::collections::VecDeque;
use std::f32::consts::PI;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GaitFeatures {
    pub t_ms: u64,
    /// observed sample rate of the window (Hz)
    pub fs: f32,
    /// gait / gyro metrics were computed (full-rate window)
    pub full: bool,
    /// the window carried non-zero gyro data
    pub has_gyro: bool,
    pub steps: usize,
    pub cadence_spm: f32,
    pub step_cv: f32,
    pub regularity: f32,
    pub harmonic_ratio: f32,
    pub sway_rms: f32,
    /// RMS rotation rate orthogonal to gravity (deg/s), 0 without gyro
    pub wobble_dps: f32,
    /// peak |d|a|/dt| in the window (g/s)
    pub jerk_peak: f32,
    /// peak rotation rate in the window (deg/s), 0 without gyro
    pub rot_peak_dps: f32,
    /// peak total acceleration magnitude (g)
    pub peak_g: f32,
    /// RMS of total user-acceleration magnitude (g)
    pub energy_rms: f32,
    pub is_walking: bool,
    pub is_running: bool,
    /// high energy, no periodic gait (0..1)
    pub agitation: f32,
    /// median gravity vector over the window
    pub gravity: [f32; 3],
    pub gravity_var: f32,
    /// newest stumble in the window (see `StumbleInfo`); only set by `GaitAnalyzer` with stumble thresholds
    pub stumble: Option<StumbleInfo>,
}

/// One step interval far off the window's median interval with a sideways spike inside it, followed by at least one
/// more step (walking continued).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StumbleInfo {
    /// time of the step that ended the odd interval
    pub t_ms: u64,
    /// |interval / median − 1|
    pub interval_dev: f32,
    /// peak horizontal acceleration inside the interval (g)
    pub lateral_g: f32,
}

/// Stumble thresholds: interval deviation (fraction) and sideways spike (g).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StumbleRule {
    pub interval_dev: f32,
    pub lateral_g: f32,
}

/// RBJ biquad (direct form 1), applied statelessly per window.
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
}
impl Biquad {
    fn lowpass(f: f32, fs: f32) -> Self {
        let f = f.min(fs * 0.45);
        let w0 = 2.0 * PI * f / fs;
        let (sn, cs) = (w0.sin(), w0.cos());
        let alpha = sn / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0 = 1.0 + alpha;
        Biquad {
            b: [(1.0 - cs) / 2.0 / a0, (1.0 - cs) / a0, (1.0 - cs) / 2.0 / a0],
            a: [-2.0 * cs / a0, (1.0 - alpha) / a0],
        }
    }
    fn highpass(f: f32, fs: f32) -> Self {
        let f = f.min(fs * 0.45);
        let w0 = 2.0 * PI * f / fs;
        let (sn, cs) = (w0.sin(), w0.cos());
        let alpha = sn / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
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

/// Band-pass designed for the given sample rate.
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
    if n < max_lag + 10 || min_lag == 0 {
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

/// Sample rate observed in a window from its timestamps (falls back to the nominal rate).
pub fn observed_fs(win: &[MotionSample], nominal: f32) -> f32 {
    if win.len() < 2 {
        return nominal;
    }
    let span = win.last().unwrap().t_ms.saturating_sub(win[0].t_ms) as f32 / 1000.0;
    if span <= 0.0 {
        return nominal;
    }
    (win.len() - 1) as f32 / span
}

/// Compute features for a window. `allow_full` = native says it delivers full-rate data; gait and
/// gyro metrics are also skipped whenever the observed rate is below `min_sample_hz`.
pub fn compute_features(cfg: &GaitCfg, win: &[MotionSample], allow_full: bool) -> GaitFeatures {
    compute_features_with(cfg, win, allow_full, None)
}

/// `compute_features` plus stumble detection on walking windows.
pub fn compute_features_with(cfg: &GaitCfg, win: &[MotionSample], allow_full: bool, stumble: Option<StumbleRule>) -> GaitFeatures {
    let n = win.len();
    let fs = observed_fs(win, cfg.sample_hz);
    let full = allow_full && fs >= cfg.min_sample_hz && n >= 8;
    let mut vert = Vec::with_capacity(n);
    let mut horiz = Vec::with_capacity(n);
    let mut mags = Vec::with_capacity(n);
    let (mut gx, mut gy, mut gz) = (Vec::new(), Vec::new(), Vec::new());
    let mut peak_g = 0.0f32;
    let mut jerk_peak = 0.0f32;
    let mut rot_peak = 0.0f32;
    let mut wob_sq = 0.0f32;
    let mut has_gyro = false;
    let mut prev: Option<(u64, f32)> = None;
    for s in win {
        let (v, h) = project(s);
        vert.push(v);
        horiz.push(h);
        let m = (s.ax * s.ax + s.ay * s.ay + s.az * s.az).sqrt();
        mags.push(m);
        gx.push(s.gx);
        gy.push(s.gy);
        gz.push(s.gz);
        peak_g = peak_g.max(total_mag(s));
        if let Some((pt, pm)) = prev {
            let dt = s.t_ms.saturating_sub(pt) as f32 / 1000.0;
            if dt > 0.0 {
                jerk_peak = jerk_peak.max((m - pm).abs() / dt);
            }
        }
        prev = Some((s.t_ms, m));
        let w = [s.rx, s.ry, s.rz];
        let wn = norm(w);
        if wn > 1e-6 {
            has_gyro = true;
            rot_peak = rot_peak.max(wn);
            let g = [s.gx, s.gy, s.gz];
            let gn = norm(g).max(1e-6);
            let gu = [g[0] / gn, g[1] / gn, g[2] / gn];
            let along = dot(w, gu);
            let perp = [w[0] - along * gu[0], w[1] - along * gu[1], w[2] - along * gu[2]];
            wob_sq += dot(perp, perp);
        }
    }
    let gm = [median(&mut gx.clone()), median(&mut gy.clone()), median(&mut gz.clone())];
    let gvar = {
        let mut acc = 0.0f32;
        for i in 0..n {
            acc += (gx[i] - gm[0]).powi(2) + (gy[i] - gm[1]).powi(2) + (gz[i] - gm[2]).powi(2);
        }
        acc / n.max(1) as f32
    };
    let energy = rms(&mags);
    let wobble = if has_gyro { (wob_sq / n.max(1) as f32).sqrt().to_degrees() } else { 0.0 };
    let t_ms = win.last().map(|s| s.t_ms).unwrap_or(0);

    let mut f = GaitFeatures {
        t_ms,
        fs,
        full,
        has_gyro,
        peak_g,
        energy_rms: energy,
        gravity: gm,
        gravity_var: gvar,
        ..Default::default()
    };
    if !full {
        return f;
    }

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
        cadence = 60.0 / dur_s.max(1e-3);
    }
    let regularity = autocorr_peak(vb, (0.25 * fs) as usize, (1.5 * fs) as usize);
    let hr = if cadence > 0.0 { harmonic_ratio(vb, cadence / 60.0 / 2.0, fs) } else { 0.0 };
    let sway = rms(hb);
    let periodic = regularity >= cfg.min_regularity_walk && steps >= (dur_s * 0.8) as usize;
    let is_walking = periodic && cadence >= cfg.walk_cadence_min && cadence < cfg.walk_cadence_max;
    let is_running = periodic && cadence >= cfg.run_cadence_min;
    let agitation = if !is_walking && !is_running && energy > cfg.agitation_rms_g && regularity < 0.6 {
        ((energy - cfg.agitation_rms_g) / 0.4).clamp(0.0, 1.0)
    } else {
        0.0
    };
    f.steps = steps;
    f.cadence_spm = cadence;
    f.step_cv = step_cv;
    f.regularity = regularity;
    f.harmonic_ratio = hr;
    f.sway_rms = sway;
    f.wobble_dps = wobble;
    f.jerk_peak = jerk_peak;
    f.rot_peak_dps = rot_peak.to_degrees();
    f.is_walking = is_walking;
    f.is_running = is_running;
    f.agitation = agitation;
    if let (Some(rule), true) = (stumble, is_walking) {
        f.stumble = find_stumble(&rule, &peaks, &horiz[skip.min(horiz.len())..], &win[skip.min(n)..], fs);
    }
    f
}

/// Newest step interval that deviates from the window median by more than `rule.interval_dev` with a horizontal
/// spike above `rule.lateral_g` between its two steps, after two steady steps (not a walk starting up) and with
/// another step after it (walking continued).
fn find_stumble(rule: &StumbleRule, peaks: &[usize], horiz: &[f32], win: &[MotionSample], fs: f32) -> Option<StumbleInfo> {
    if peaks.len() < 5 {
        return None;
    }
    let iv: Vec<f32> = peaks.windows(2).map(|w| (w[1] - w[0]) as f32 / fs).collect();
    let med = median(&mut iv.clone()).max(1e-3);
    let dev_of = |i: usize| (iv[i] / med - 1.0).abs();
    // the last interval has no step after it yet: it is judged in a later window
    for k in (2..iv.len() - 1).rev() {
        let dev = dev_of(k);
        if dev <= rule.interval_dev || dev_of(k - 1) > rule.interval_dev / 2.0 || dev_of(k - 2) > rule.interval_dev / 2.0 {
            continue;
        }
        let (a, b) = (peaks[k], peaks[k + 1].min(horiz.len().saturating_sub(1)));
        let lateral = horiz.get(a..=b).map(|h| h.iter().cloned().fold(0.0f32, f32::max)).unwrap_or(0.0);
        if lateral > rule.lateral_g {
            let t_ms = win.get(peaks[k + 1]).map(|s| s.t_ms).unwrap_or(0);
            return Some(StumbleInfo { t_ms, interval_dev: dev, lateral_g: lateral });
        }
    }
    None
}

/// Keeps a time-based ring buffer of samples and emits features every `hop_s`. Each stumble is reported once
/// (overlapping windows see the same step several times).
pub struct GaitAnalyzer {
    cfg: GaitCfg,
    buf: VecDeque<MotionSample>,
    last_emit_ms: u64,
    stumble: Option<StumbleRule>,
    last_stumble_ms: u64,
}

impl GaitAnalyzer {
    pub fn new(cfg: &GaitCfg) -> Self {
        GaitAnalyzer { cfg: cfg.clone(), buf: VecDeque::new(), last_emit_ms: 0, stumble: None, last_stumble_ms: 0 }
    }
    pub fn with_stumbles(cfg: &GaitCfg, rule: StumbleRule) -> Self {
        GaitAnalyzer { stumble: Some(rule), ..Self::new(cfg) }
    }
    pub fn window_len(&self) -> usize {
        (self.cfg.window_s * self.cfg.sample_hz) as usize
    }
    /// Push a sample; returns features when a new hop completes. `allow_full` gates gait/gyro metrics.
    pub fn push(&mut self, s: MotionSample, allow_full: bool) -> Option<GaitFeatures> {
        // a backwards jump in time (new session / replay) resets the buffer
        if let Some(last) = self.buf.back() {
            if s.t_ms + 5_000 < last.t_ms {
                self.buf.clear();
                self.last_emit_ms = 0;
            }
        }
        self.buf.push_back(s);
        let span_ms = (self.cfg.window_s * 1000.0) as u64;
        while self.buf.front().map(|f| s.t_ms.saturating_sub(f.t_ms) > span_ms).unwrap_or(false) {
            self.buf.pop_front();
        }
        let first = self.buf.front().map(|f| f.t_ms).unwrap_or(s.t_ms);
        if s.t_ms.saturating_sub(first) + 50 < span_ms || self.buf.len() < 4 {
            return None;
        }
        if s.t_ms.saturating_sub(self.last_emit_ms) < (self.cfg.hop_s * 1000.0) as u64 {
            return None;
        }
        self.last_emit_ms = s.t_ms;
        let win: Vec<MotionSample> = self.buf.iter().copied().collect();
        let mut f = compute_features_with(&self.cfg, &win, allow_full, self.stumble);
        if let Some(st) = f.stumble {
            // the same step reappears in the next windows (± one sample of peak jitter)
            if st.t_ms <= self.last_stumble_ms + 200 {
                f.stumble = None;
            } else {
                self.last_stumble_ms = st.t_ms;
            }
        }
        Some(f)
    }
}

/// Rotation rate (rad/s) implied by two consecutive gravity vectors: ω ≈ (g0 × g1) / dt.
pub fn gravity_rotation_rate(g0: [f32; 3], g1: [f32; 3], dt_s: f32) -> [f32; 3] {
    if dt_s <= 0.0 {
        return [0.0; 3];
    }
    let c = cross(g0, g1);
    [c[0] / dt_s, c[1] / dt_s, c[2] / dt_s]
}
