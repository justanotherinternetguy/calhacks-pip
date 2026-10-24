//! Gait-drift persistence for one incident (unsteady gait or slowed walk): out-of-band walking must persist
//! `persist_s` seconds before the incident opens; a non-walking gap longer than `gap_s` or an in-band window restarts
//! that clock. Once open, it clears after `clear_s` seconds of in-band walking (pauses do not count either way).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DriftStep {
    None,
    Open,
    Clear,
}

#[derive(Clone, Copy, Debug)]
pub struct DriftRule {
    pub persist_s: f32,
    pub clear_s: f32,
    pub gap_s: f32,
}

#[derive(Clone, Debug, Default)]
pub struct DriftTracker {
    first_oob_ms: Option<u64>,
    last_oob_ms: Option<u64>,
    /// seconds of in-band walking since the incident opened (or since the last out-of-band window)
    inband_s: f32,
    pub active: bool,
    /// names of the metrics out of band in the current run (for summaries)
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

    /// An out-of-band run that is building (or persisting) right now: metric names and walking seconds so far.
    /// `None` once the run was reset or its last out-of-band window is older than the gap tolerance.
    pub fn building(&self, rule: &DriftRule, hop_s: f32, now_ms: u64) -> Option<(&[String], f32)> {
        let l = self.last_oob_ms?;
        if now_ms.saturating_sub(l) as f32 / 1000.0 > rule.gap_s + hop_s {
            return None;
        }
        Some((&self.metrics, self.persist_s(hop_s)))
    }

    fn reset_run(&mut self) {
        self.first_oob_ms = None;
        self.last_oob_ms = None;
        if !self.active {
            self.metrics.clear();
            self.worst_sd = 0.0;
        }
    }

    /// Feed one walking gait window. `oob` = names of the metrics out of band on the concerning side.
    pub fn push_walking(&mut self, rule: &DriftRule, hop_s: f32, t_ms: u64, oob: &[&str], worst_sd: f32) -> DriftStep {
        if let Some(l) = self.last_oob_ms {
            if t_ms.saturating_sub(l) as f32 / 1000.0 > rule.gap_s + hop_s {
                self.reset_run();
            }
        }
        if oob.is_empty() {
            self.reset_run();
            if self.active {
                self.inband_s += hop_s;
                if self.inband_s + 1e-3 >= rule.clear_s {
                    self.active = false;
                    self.inband_s = 0.0;
                    self.metrics.clear();
                    self.worst_sd = 0.0;
                    return DriftStep::Clear;
                }
            }
            return DriftStep::None;
        }
        self.inband_s = 0.0;
        if self.first_oob_ms.is_none() {
            self.first_oob_ms = Some(t_ms);
            if !self.active {
                self.worst_sd = 0.0;
            }
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
        if !self.active && self.persist_s(hop_s) + 1e-3 >= rule.persist_s {
            self.active = true;
            return DriftStep::Open;
        }
        DriftStep::None
    }

    /// Forget everything (night mode toggled, incident cleared elsewhere).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULE: DriftRule = DriftRule { persist_s: 30.0, clear_s: 120.0, gap_s: 6.0 };

    /// `persist_s` means seconds of walking regardless of the hop: 30 s of out-of-band walking opens at the same
    /// wall-clock time with 1 s, 2 s and 0.5 s hops.
    #[test]
    fn persistence_is_hop_invariant() {
        let mut opened = Vec::new();
        for hop in [1.0f32, 2.0, 0.5] {
            let mut tr = DriftTracker::new();
            let hop_ms = (hop * 1000.0) as u64;
            let mut t = hop_ms;
            loop {
                if tr.push_walking(&RULE, hop, t, &["sway"], 3.0) == DriftStep::Open {
                    opened.push(t);
                    break;
                }
                assert!(t < 60_000, "never opened with hop {hop}");
                t += hop_ms;
            }
            assert!((tr.persist_s(hop) - RULE.persist_s).abs() < 1e-3, "hop {hop}: {}", tr.persist_s(hop));
            let (names, p) = tr.building(&RULE, hop, t).expect("building right after opening");
            assert_eq!(names, &["sway".to_string()]);
            assert!((p - RULE.persist_s).abs() < 1e-3);
            assert!(tr.building(&RULE, hop, t + ((RULE.gap_s + hop) * 1000.0) as u64 + 1).is_none());
        }
        assert!(opened.iter().all(|t| *t == 30_000), "{opened:?}");
    }

    #[test]
    fn opens_once_and_clears_after_in_band_walking() {
        let mut tr = DriftTracker::new();
        let mut t = 0;
        let mut steps = Vec::new();
        for _ in 0..60 {
            t += 1000;
            steps.push(tr.push_walking(&RULE, 1.0, t, &["sway"], 3.0));
        }
        assert_eq!(steps.iter().filter(|s| **s == DriftStep::Open).count(), 1, "opens once while it persists");
        // 119 s in band (with a pause in the middle that does not count) => still active; the 120th clears
        for i in 0..119 {
            t += if i == 50 { 600_000 } else { 1000 };
            assert_eq!(tr.push_walking(&RULE, 1.0, t, &[], 0.0), DriftStep::None);
        }
        assert!(tr.active);
        t += 1000;
        assert_eq!(tr.push_walking(&RULE, 1.0, t, &[], 0.0), DriftStep::Clear);
        assert!(!tr.active);
    }
}
