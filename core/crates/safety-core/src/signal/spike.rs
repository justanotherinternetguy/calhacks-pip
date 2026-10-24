//! Spike metrics (jerk, rotation rate, peak total acceleration) per 1 s block straight from the raw
//! sample stream, independent of the gait window, plus a dashboard peak-hold over the last
//! `spike_hold_s` seconds. Detection (grab / impact) never reads this: it works on the instantaneous
//! per-sample values in `grab.rs` / `impact.rs`; this is the live-metrics layer only.
use super::{gyro, norm, total_mag};
use crate::types::MotionSample;
use std::collections::VecDeque;

/// Peaks over one closed block of samples (nominally one engine tick, ~1 s).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SpikeBlock {
    /// timestamp of the last sample in the block
    pub t_ms: u64,
    /// peak |d|a|/dt| (g/s), same definition as `GaitFeatures::jerk_peak`
    pub jerk_peak: f32,
    /// peak gyro rotation rate (deg/s); 0 without gyro
    pub rot_peak_dps: f32,
    /// peak total acceleration magnitude (g)
    pub peak_g: f32,
    /// RMS of user-acceleration magnitude over the block (g)
    pub energy_rms: f32,
    /// the block carried non-zero gyro data
    pub has_gyro: bool,
    pub samples: u32,
}

pub struct SpikeTracker {
    hold_ms: u64,
    prev: Option<(u64, f32)>,
    cur: SpikeBlock,
    cur_sq: f32,
    blocks: VecDeque<SpikeBlock>,
}

impl SpikeTracker {
    pub fn new(hold_s: f32) -> Self {
        SpikeTracker { hold_ms: (hold_s.max(0.0) * 1000.0) as u64, prev: None, cur: SpikeBlock::default(), cur_sq: 0.0, blocks: VecDeque::new() }
    }

    /// Per sample: accumulate the open block.
    pub fn push(&mut self, s: &MotionSample) {
        let m = norm([s.ax, s.ay, s.az]);
        if let Some((pt, pm)) = self.prev {
            // a backwards jump in time (new session / replay) restarts the stream
            if s.t_ms + 5_000 < pt {
                self.blocks.clear();
                self.cur = SpikeBlock::default();
                self.cur_sq = 0.0;
            } else {
                let dt = s.t_ms.saturating_sub(pt) as f32 / 1000.0;
                if dt > 0.0 {
                    self.cur.jerk_peak = self.cur.jerk_peak.max((m - pm).abs() / dt);
                }
            }
        }
        self.prev = Some((s.t_ms, m));
        let w = norm(gyro(s));
        if w > 1e-6 {
            self.cur.has_gyro = true;
            self.cur.rot_peak_dps = self.cur.rot_peak_dps.max(w.to_degrees());
        }
        self.cur.peak_g = self.cur.peak_g.max(total_mag(s));
        self.cur_sq += m * m;
        self.cur.samples += 1;
        self.cur.t_ms = s.t_ms;
    }

    /// Close the open block (called once per tick). Returns the closed block, if it had any samples.
    pub fn close_block(&mut self, now_ms: u64) -> Option<SpikeBlock> {
        if self.cur.samples == 0 {
            self.prune(now_ms);
            return None;
        }
        let mut b = std::mem::take(&mut self.cur);
        b.energy_rms = (self.cur_sq / b.samples as f32).sqrt();
        self.cur_sq = 0.0;
        self.blocks.push_back(b);
        self.prune(now_ms.max(b.t_ms));
        Some(b)
    }

    fn prune(&mut self, now_ms: u64) {
        while self.blocks.front().map(|b| now_ms.saturating_sub(b.t_ms) > self.hold_ms).unwrap_or(false) {
            self.blocks.pop_front();
        }
    }

    /// The most recent closed block.
    pub fn latest(&self) -> Option<&SpikeBlock> {
        self.blocks.back()
    }

    /// Peak-hold: element-wise max over the blocks closed within the last `spike_hold_s` of `now_ms`.
    /// `has_gyro` is true when any held block carried gyro data.
    pub fn held(&self, now_ms: u64) -> Option<SpikeBlock> {
        let mut out: Option<SpikeBlock> = None;
        for b in self.blocks.iter().filter(|b| now_ms.saturating_sub(b.t_ms) <= self.hold_ms) {
            let o = out.get_or_insert(SpikeBlock { t_ms: b.t_ms, ..Default::default() });
            o.t_ms = o.t_ms.max(b.t_ms);
            o.jerk_peak = o.jerk_peak.max(b.jerk_peak);
            o.rot_peak_dps = o.rot_peak_dps.max(b.rot_peak_dps);
            o.peak_g = o.peak_g.max(b.peak_g);
            o.energy_rms = o.energy_rms.max(b.energy_rms);
            o.has_gyro |= b.has_gyro;
            o.samples += b.samples;
        }
        out
    }

    pub fn reset(&mut self) {
        self.prev = None;
        self.cur = SpikeBlock::default();
        self.cur_sq = 0.0;
        self.blocks.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(t_ms: u64, ax: f32, rx: f32) -> MotionSample {
        MotionSample { t_ms, ax, ay: 0.0, az: 0.0, gx: 0.0, gy: -1.0, gz: 0.0, rx, ry: 0.0, rz: 0.0 }
    }

    #[test]
    fn blocks_and_peak_hold() {
        let mut tr = SpikeTracker::new(3.0);
        // quiet second
        for i in 0..50 {
            tr.push(&s(i * 20, 0.01, 0.0));
        }
        let b = tr.close_block(1000).unwrap();
        assert!(b.jerk_peak < 1.0 && !b.has_gyro && (b.peak_g - 1.0).abs() < 0.05, "{b:?}");
        // a 60 ms spike: 0 -> 1.2 g in one 20 ms sample = 60 g/s, with 10 rad/s of spin
        for i in 50..100 {
            let (a, r) = if (52..55).contains(&i) { (1.2, 10.0) } else { (0.01, 0.0) };
            tr.push(&s(i * 20, a, r));
        }
        let b = tr.close_block(2000).unwrap();
        assert!(b.jerk_peak > 50.0 && b.has_gyro && b.rot_peak_dps > 500.0, "{b:?}");
        // held for 3 s after the spike block's last sample (1980 ms), then gone
        for k in 2..6u64 {
            for i in 0..50 {
                tr.push(&s(k * 1000 + i * 20, 0.01, 0.0));
            }
            tr.close_block((k + 1) * 1000);
            let h = tr.held((k + 1) * 1000).unwrap();
            if (k + 1) * 1000 <= 1980 + 3000 {
                assert!(h.jerk_peak > 50.0 && h.has_gyro, "still held at {} s: {h:?}", k + 1);
            } else {
                assert!(h.jerk_peak < 1.0 && !h.has_gyro, "released at {} s: {h:?}", k + 1);
            }
        }
        // an empty tick closes nothing but keeps the latest block
        assert!(tr.close_block(7000).is_none());
        assert!(tr.latest().is_some());
    }
}
