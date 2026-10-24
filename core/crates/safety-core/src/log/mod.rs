//! Incident log (v1.1): records with 8 h expiry, persisted in the baseline blob, plus the rule-based
//! sequence "agent" that groups concerning runs into sequences, prunes isolated minor incidents and
//! turns a sequence into a bounded HMM log-odds boost and a one-line unlock summary.
use crate::config::{LogCfg, SequenceCfg};
use crate::types::{IncidentKind, IncidentRecord};
use serde::{Deserialize, Serialize};

/// Persisted part of the log.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct LogState {
    pub records: Vec<IncidentRecord>,
    pub next_id: u32,
    pub next_seq: u32,
    /// sequences with an id at or below this were resolved by the user / a friend and no longer boost
    #[serde(default)]
    pub resolved_seq: u32,
}

pub struct IncidentLog {
    cfg: SequenceCfg,
    log_cfg: LogCfg,
    state: LogState,
}

fn kind_weight(cfg: &SequenceCfg, k: IncidentKind) -> f32 {
    match k {
        IncidentKind::GaitDrift => cfg.w_gait_drift,
        IncidentKind::Separated => cfg.w_separated,
        IncidentKind::Impact => cfg.w_impact,
        IncidentKind::Stillness => cfg.w_stillness,
        IncidentKind::Grab => cfg.w_grab,
        IncidentKind::TypingOff => cfg.w_typing_off,
    }
}

fn raw_f32(rec: &IncidentRecord, key: &str) -> Option<f32> {
    let v: serde_json::Value = serde_json::from_str(&rec.raw_json).ok()?;
    v.get(key)?.as_f64().map(|x| x as f32)
}

/// Human phrase for one record inside a sequence summary (lowercase, mid-sentence form).
fn phrase(rec: &IncidentRecord) -> String {
    match rec.kind {
        IncidentKind::GaitDrift => "unsteady walking".into(),
        IncidentKind::Separated => "separated from the group".into(),
        IncidentKind::Impact => {
            let peak = raw_f32(rec, "peak_g").unwrap_or(0.0);
            let fall = raw_f32(rec, "fall_likelihood").unwrap_or(0.0) >= 0.5;
            match (fall, peak >= 4.0) {
                (true, true) => "a hard fall".into(),
                (true, false) => "a fall".into(),
                (false, _) => "a hard impact".into(),
            }
        }
        IncidentKind::Stillness => {
            let s = raw_f32(rec, "stillness_s").unwrap_or(0.0);
            format!("no movement for {} min", (s / 60.0).floor().max(1.0) as u32)
        }
        IncidentKind::Grab => "phone grabbed".into(),
        IncidentKind::TypingOff => "impaired typing".into(),
    }
}

fn capitalize_first(s: &str) -> String {
    let s = s.strip_prefix("a ").unwrap_or(s);
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

impl IncidentLog {
    pub fn new(cfg: &SequenceCfg, log_cfg: &LogCfg, state: LogState, now_ms: u64) -> Self {
        let mut l = IncidentLog { cfg: cfg.clone(), log_cfg: log_cfg.clone(), state };
        l.expire(now_ms);
        l
    }

    pub fn state(&self) -> &LogState {
        &self.state
    }
    pub fn records(&self) -> &[IncidentRecord] {
        &self.state.records
    }
    pub fn is_empty(&self) -> bool {
        self.state.records.is_empty()
    }

    /// Append a record (assigns the id) and return it.
    pub fn push(&mut self, mut rec: IncidentRecord) -> IncidentRecord {
        self.state.next_id += 1;
        rec.id = self.state.next_id;
        rec.sequence_id = 0;
        rec.watched = false;
        self.state.records.push(rec.clone());
        rec
    }

    /// Drop records older than `log.expiry_h`. Called on load and every tick.
    pub fn expire(&mut self, now_ms: u64) {
        let ttl = (self.log_cfg.expiry_h * 3_600_000.0) as u64;
        self.state.records.retain(|r| now_ms.saturating_sub(r.t_ms) <= ttl);
    }

    fn window_ms(&self) -> u64 {
        (self.cfg.window_min * 60_000.0) as u64
    }

    fn is_fall(rec: &IncidentRecord) -> bool {
        raw_f32(rec, "fall_likelihood").unwrap_or(0.0) >= 0.5
    }

    /// Sequence agent pass: form/extend sequences from concerning runs inside the window, prune isolated
    /// gait drifts. Returns the current boost.
    pub fn analyze(&mut self, now_ms: u64) -> f32 {
        self.expire(now_ms);
        let window = self.window_ms();
        let n = self.state.records.len();
        for i in 0..n {
            let r = &self.state.records[i];
            if r.sequence_id != 0 {
                continue;
            }
            let (t, kind) = (r.t_ms, r.kind);
            let earlier = |k: &[IncidentKind]| -> bool {
                self.state.records[..i].iter().any(|p| k.contains(&p.kind) && t.saturating_sub(p.t_ms) <= window)
            };
            let trigger = match kind {
                IncidentKind::Grab | IncidentKind::Stillness => true,
                IncidentKind::Impact => {
                    Self::is_fall(r) || earlier(&[IncidentKind::GaitDrift, IncidentKind::Separated, IncidentKind::TypingOff])
                }
                IncidentKind::Separated => earlier(&[IncidentKind::GaitDrift]),
                IncidentKind::GaitDrift | IncidentKind::TypingOff => false,
            };
            if !trigger {
                continue;
            }
            // members: every record inside the window up to and including the trigger
            let members: Vec<usize> =
                (0..=i).filter(|j| t.saturating_sub(self.state.records[*j].t_ms) <= window).collect();
            let existing = members.iter().map(|j| self.state.records[*j].sequence_id).filter(|s| *s != 0).max();
            let seq = match existing {
                Some(s) => s,
                None => {
                    self.state.next_seq += 1;
                    self.state.next_seq
                }
            };
            for j in members {
                let m = &mut self.state.records[j];
                if m.sequence_id == 0 {
                    m.sequence_id = seq;
                }
                m.watched = true;
            }
        }
        // prune: isolated GaitDrift with nothing after it for prune_min
        let prune = (self.cfg.prune_isolated_gait_drift_min * 60_000.0) as u64;
        let recs = &self.state.records;
        let keep: Vec<bool> = recs
            .iter()
            .map(|r| {
                if r.kind != IncidentKind::GaitDrift || r.watched || r.sequence_id != 0 {
                    return true;
                }
                if now_ms.saturating_sub(r.t_ms) < prune {
                    return true; // too early to judge
                }
                recs.iter().any(|o| o.id != r.id && o.t_ms >= r.t_ms && o.t_ms - r.t_ms <= prune)
            })
            .collect();
        let mut k = keep.into_iter();
        self.state.records.retain(|_| k.next().unwrap_or(true));
        self.boost(now_ms)
    }

    /// Id of the newest unresolved sequence with a member inside the window.
    fn active_seq(&self, now_ms: u64) -> Option<u32> {
        let window = self.window_ms();
        self.state
            .records
            .iter()
            .filter(|r| r.sequence_id > self.state.resolved_seq && now_ms.saturating_sub(r.t_ms) <= window)
            .map(|r| r.sequence_id)
            .max()
    }

    /// Bounded log-odds boost for the HMM forward transitions: Σ member weights of the active sequence.
    pub fn boost(&self, now_ms: u64) -> f32 {
        match self.active_seq(now_ms) {
            None => 0.0,
            Some(seq) => self
                .state
                .records
                .iter()
                .filter(|r| r.sequence_id == seq)
                .map(|r| kind_weight(&self.cfg, r.kind))
                .sum::<f32>()
                .min(self.cfg.max_boost),
        }
    }

    /// One line describing the active (or most recent) sequence, e.g. "Fall, then no movement for 4 min".
    pub fn sequence_summary(&self, now_ms: u64) -> Option<String> {
        let seq = self.active_seq(now_ms).or_else(|| self.state.records.iter().map(|r| r.sequence_id).filter(|s| *s > 0).max())?;
        let mut phrases: Vec<String> = Vec::new();
        for r in self.state.records.iter().filter(|r| r.sequence_id == seq) {
            let p = phrase(r);
            if phrases.last().map(|l| l == &p).unwrap_or(false) {
                continue;
            }
            phrases.push(p);
        }
        if phrases.is_empty() {
            return None;
        }
        let mut out = capitalize_first(&phrases[0]);
        for p in &phrases[1..] {
            out.push_str(", then ");
            out.push_str(p);
        }
        Some(out)
    }

    /// The user / a friend resolved the episode: sequences so far stop boosting (they stay in the log).
    pub fn resolve(&mut self) {
        self.state.resolved_seq = self.state.next_seq;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::types::Placement;

    fn rec(t_ms: u64, kind: IncidentKind, raw: &str) -> IncidentRecord {
        IncidentRecord {
            id: 0,
            t_ms,
            kind,
            summary: String::new(),
            sd_distance: 0.0,
            placement: Placement::Pocket,
            raw_json: raw.into(),
            p_normal: 1.0,
            p_impaired: 0.0,
            p_incident: 0.0,
            p_unresponsive: 0.0,
            sequence_id: 0,
            watched: false,
        }
    }

    fn log() -> IncidentLog {
        let c = Config::default_v1();
        IncidentLog::new(&c.sequence, &c.log, LogState::default(), 0)
    }

    #[test]
    fn impact_then_stillness_forms_sequence_with_summary() {
        let mut l = log();
        l.push(rec(60_000, IncidentKind::Impact, r#"{"peak_g":4.6,"fall_likelihood":0.8}"#));
        assert!(l.analyze(61_000) > 0.0, "a fall alone is watched");
        l.push(rec(300_000, IncidentKind::Stillness, r#"{"stillness_s":240}"#));
        let b = l.analyze(301_000);
        assert!((b - 2.0).abs() < 1e-5, "boost {b}");
        assert!(l.records().iter().all(|r| r.watched && r.sequence_id == 1));
        assert_eq!(l.sequence_summary(301_000).unwrap(), "Hard fall, then no movement for 4 min");
        l.resolve();
        assert_eq!(l.boost(302_000), 0.0);
    }

    #[test]
    fn long_chain_summary_and_isolated_gait_drift_pruned() {
        let mut l = log();
        l.push(rec(0, IncidentKind::GaitDrift, "{}"));
        l.push(rec(600_000, IncidentKind::Separated, "{}"));
        l.push(rec(900_000, IncidentKind::Impact, r#"{"peak_g":5.0,"fall_likelihood":0.7}"#));
        l.analyze(901_000);
        assert_eq!(l.sequence_summary(901_000).unwrap(), "Unsteady walking, then separated from the group, then a hard fall");
        let mut l = log();
        l.push(rec(0, IncidentKind::GaitDrift, "{}"));
        assert_eq!(l.analyze(19 * 60_000), 0.0);
        assert_eq!(l.records().len(), 1);
        l.analyze(21 * 60_000);
        assert!(l.is_empty(), "isolated gait drift pruned");
        // grab alone
        let mut l = log();
        l.push(rec(0, IncidentKind::Grab, "{}"));
        assert!(l.analyze(1000) >= 1.5);
        assert_eq!(l.sequence_summary(1000).unwrap(), "Phone grabbed");
    }

    #[test]
    fn expiry() {
        let mut l = log();
        l.push(rec(0, IncidentKind::Impact, "{}"));
        l.expire(7 * 3_600_000);
        assert_eq!(l.records().len(), 1);
        l.expire(8 * 3_600_000 + 1);
        assert!(l.is_empty());
    }
}
