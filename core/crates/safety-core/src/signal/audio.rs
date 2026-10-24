//! Audio labels from the listening window (~1 s YAMNet frames: scream / shout / snore scores + level in dB SPL).
//! Labels only; the engine never sees audio. Frames older than `KEEP_MS` are dropped.
use crate::types::AudioScores;
use std::collections::VecDeque;

const KEEP_MS: u64 = 120_000;

#[derive(Default)]
pub struct AudioWindow {
    frames: VecDeque<AudioScores>,
}

impl AudioWindow {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, f: AudioScores) {
        if self.frames.back().map(|b| f.t_ms + 5_000 < b.t_ms).unwrap_or(false) {
            self.frames.clear(); // clock went backwards (new session / replay)
        }
        self.frames.push_back(f);
        while self.frames.front().map(|x| f.t_ms.saturating_sub(x.t_ms) > KEEP_MS).unwrap_or(false) {
            self.frames.pop_front();
        }
    }

    pub fn clear(&mut self) {
        self.frames.clear();
    }

    pub fn newest_ms(&self) -> Option<u64> {
        self.frames.back().map(|f| f.t_ms)
    }

    /// Frames at or after `since_ms` matching `pred`.
    pub fn count(&self, since_ms: u64, pred: impl Fn(&AudioScores) -> bool) -> usize {
        self.frames.iter().filter(|f| f.t_ms >= since_ms && pred(f)).count()
    }

    /// Highest value of `get` over frames at or after `since_ms`.
    pub fn peak(&self, since_ms: u64, get: impl Fn(&AudioScores) -> f32) -> f32 {
        self.frames.iter().filter(|f| f.t_ms >= since_ms).map(get).fold(0.0, f32::max)
    }

    /// Median level of the newest `n` frames (at least min(n, 3) frames needed), dB SPL.
    pub fn median_level(&self, n: usize) -> Option<f32> {
        let take = n.min(self.frames.len());
        if take < n.min(3) || take == 0 {
            return None;
        }
        let mut v: Vec<f32> = self.frames.iter().rev().take(take).map(|f| f.level_db).collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Some(v[v.len() / 2])
    }

    /// Loud venue: the median level of the newest `n` frames is at or above `db`.
    pub fn loud(&self, n: usize, db: f32) -> bool {
        self.median_level(n).map(|m| m >= db).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(t_ms: u64, scream: f32, level_db: f32) -> AudioScores {
        AudioScores { t_ms, scream, shout: 0.0, snore: 0.0, level_db }
    }

    #[test]
    fn loud_needs_a_few_frames_and_counts_window() {
        let mut w = AudioWindow::new();
        w.push(f(0, 0.9, 90.0));
        w.push(f(1000, 0.0, 90.0));
        assert!(!w.loud(15, 80.0), "two frames are not enough to call a venue loud");
        w.push(f(2000, 0.8, 60.0));
        w.push(f(3000, 0.0, 92.0));
        assert!(w.loud(15, 80.0));
        assert_eq!(w.count(1000, |x| x.scream >= 0.5), 1);
        assert!((w.peak(0, |x| x.scream) - 0.9).abs() < 1e-6);
        w.push(f(200_000, 0.0, 50.0));
        assert_eq!(w.count(0, |_| true), 1, "old frames dropped");
    }
}
