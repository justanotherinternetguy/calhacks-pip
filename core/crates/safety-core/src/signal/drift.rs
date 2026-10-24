//! Gait-drift persistence: out-of-band gait metrics must persist `drift_persist_s` of walking before
//! a `GaitDrift` incident fires; a short non-walking gap pauses the clock, an in-band walking window or a
//! gap longer than `drift_gap_s` resets it.
use crate::config::SignalCfg;

#[derive(Clone, Debug, Default)]
pub struct DriftTracker {
    first_oob_ms: Option<u64>,
    last_oob_ms: Option<u64>,
    last_fire_ms: Option<u64>,
    /// names of the metrics currently out of band (for summaries)
    pub metrics: Vec<String>,
    pub worst_sd: f32,
}

impl DriftTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seconds of walking covered by the current out-of-band run (0 if none).
    pub fn persist_s(&self, hop_s: f32) -> f32 {
        match (self.first_oob_ms, self.last_oob_ms) {
            (Some(f), Some(l)) => l.saturating_sub(f) as f32 / 1000.0 + hop_s,
            _ => 0.0,
        }
    }

    /// A drift run that is building (or persisting) right now: the out-of-band metric names and the
    /// seconds of walking covered so far. `None` once the run has been reset or the last out-of-band
    /// walking window is older than the gap tolerance (the person stopped walking).
    pub fn building(&self, cfg: &SignalCfg, hop_s: f32, now_ms: u64) -> Option<(&[String], f32)> {
        let l = self.last_oob_ms?;
        if now_ms.saturating_sub(l) as f32 / 1000.0 > cfg.drift_gap_s + hop_s {
            return None;
        }
        Some((&self.metrics, self.persist_s(hop_s)))
    }

    /// Feed one walking gait window. `oob` = names of metrics out of band (empty = in band).
    /// Returns true when a `GaitDrift` incident should fire now.
    pub fn push_walking(&mut self, cfg: &SignalCfg, hop_s: f32, t_ms: u64, oob: &[&str], worst_sd: f32) -> bool {
        // a long gap since the last out-of-band walking window (stopped walking) restarts the clock
        if let Some(l) = self.last_oob_ms {
            if t_ms.saturating_sub(l) as f32 / 1000.0 > cfg.drift_gap_s + hop_s {
                self.first_oob_ms = None;
                self.last_oob_ms = None;
                self.metrics.clear();
                self.worst_sd = 0.0;
            }
        }
        if oob.is_empty() {
            self.first_oob_ms = None;
            self.last_oob_ms = None;
            self.metrics.clear();
            self.worst_sd = 0.0;
            return false;
        }
        if self.first_oob_ms.is_none() {
            self.first_oob_ms = Some(t_ms);
            self.worst_sd = 0.0;
        }
        self.last_oob_ms = Some(t_ms);
        if worst_sd.abs() > self.worst_sd.abs() {
            self.worst_sd = worst_sd;
        }
        for m in oob {
            if !self.metrics.iter().any(|x| x == m) {
                self.metrics.push((*m).to_string());
            }
        }
        if self.persist_s(hop_s) + 1e-3 < cfg.drift_persist_s {
            return false;
        }
        let refire_ok = self.last_fire_ms.map(|t| t_ms.saturating_sub(t) as f32 / 1000.0 >= cfg.drift_refire_s).unwrap_or(true);
        if refire_ok {
            self.last_fire_ms = Some(t_ms);
            return true;
        }
        false
    }

    pub fn reset(&mut self) {
        self.first_oob_ms = None;
        self.last_oob_ms = None;
        self.metrics.clear();
        self.worst_sd = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    /// `drift_persist_s` means seconds of walking regardless of the hop: 30 s of out-of-band walking
    /// fires at the same wall-clock time with 1 s and 2 s hops, and `persist_s` reads the same.
    #[test]
    fn persistence_is_hop_invariant() {
        let cfg = Config::default_v1().signals;
        let mut fired = Vec::new();
        for hop in [1.0f32, 2.0, 0.5] {
            let mut tr = DriftTracker::new();
            let hop_ms = (hop * 1000.0) as u64;
            let mut t = hop_ms;
            loop {
                if tr.push_walking(&cfg, hop, t, &["cadence"], -3.0) {
                    fired.push(t);
                    break;
                }
                assert!(t < 60_000, "never fired with hop {hop}");
                t += hop_ms;
            }
            // persist_s is exactly the walking time covered at the moment of firing
            assert!((tr.persist_s(hop) - cfg.drift_persist_s).abs() < 1e-3, "hop {hop}: {}", tr.persist_s(hop));
            let (names, p) = tr.building(&cfg, hop, t).expect("building right after the fire");
            assert_eq!(names, &["cadence".to_string()]);
            assert!((p - cfg.drift_persist_s).abs() < 1e-3);
            // building() expires once the walker has stopped for longer than the gap tolerance
            assert!(tr.building(&cfg, hop, t + ((cfg.drift_gap_s + hop) * 1000.0) as u64 + 1).is_none());
        }
        assert!(fired.iter().all(|t| *t == 30_000), "{fired:?}");
    }
}
