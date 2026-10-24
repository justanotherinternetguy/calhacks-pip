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
