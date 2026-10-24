//! Incident log: every incident the engine opens, with its tier and clearing time, persisted in the baseline blob
//! (8 h expiry). Also owns escalation *episodes*: when a check-in / grab / SOS starts, the recent incidents join the
//! episode (`sequence_id`, `watched`) and the friends' one-line summary is built from them.
use crate::config::{IncidentCfg, LogCfg, SequenceCfg};
use crate::types::{IncidentFamily, IncidentKind, IncidentRecord, IncidentTier};
use serde::{Deserialize, Deserializer, Serialize};

/// Persisted part of the log.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct LogState {
    pub records: Vec<IncidentRecord>,
    pub next_id: u32,
    pub next_seq: u32,
    /// the open escalation episode; 0 = none
    #[serde(default)]
    pub episode: u32,
}

/// A blob written by an older engine (different record shape) loads as an empty log instead of failing the whole
/// baseline: the log is 8 h of context, the gait baseline is weeks of learning.
pub fn lenient_log<'de, D: Deserializer<'de>>(d: D) -> Result<LogState, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

pub struct IncidentLog {
    cfg: SequenceCfg,
    log_cfg: LogCfg,
    inc: IncidentCfg,
    state: LogState,
}

fn raw_f32(rec: &IncidentRecord, key: &str) -> Option<f32> {
    let v: serde_json::Value = serde_json::from_str(&rec.raw_json).ok()?;
    v.get(key)?.as_f64().map(|x| x as f32)
}

/// "5 s", "2 min".
pub fn duration(s: f32) -> String {
    if s < 60.0 { format!("{:.0} s", s.max(0.0)) } else { format!("{} min", (s / 60.0).floor() as u32) }
}

/// Human phrase for one record inside a summary (lowercase, mid-sentence form).
pub fn phrase(rec: &IncidentRecord) -> String {
    use IncidentKind::*;
    let mins = |key: &str| (raw_f32(rec, key).unwrap_or(0.0) / 60.0).floor().max(1.0) as u32;
    match rec.kind {
        PhoneDrop => "the phone dropped and left lying".into(),
        PossibleFall => {
            if raw_f32(rec, "peak_g").unwrap_or(0.0) >= 4.0 { "a hard fall".into() } else { "a fall".into() }
        }
        FallRecovered => "got up again".into(),
        DownAfterFall => format!("down for {}", duration(raw_f32(rec, "down_s").unwrap_or(0.0))),
        HardImpact => "a hard impact".into(),
        UnsteadyGait => "unsteady walking".into(),
        Stumble => "a stumble".into(), // never in a summary (see join_phrases)
        RepeatedStumbles => "repeated stumbling".into(),
        SlowedWalk => "walking unusually slowly".into(),
        PhoneLeftBehind => format!("the phone left behind for {} min", mins("set_down_s")),
        Grab => "phone grabbed".into(),
        Separated => "separated from the group".into(),
        StoppedOnWayHome => format!("stopped on the way home for {} min", mins("stopped_s")),
        InVehicle => "got into a vehicle".into(),
        BatteryCritical => "battery critical".into(),
        CheckInMissed => "no answer to a check-in".into(),
        TypingOff => "impaired typing at a check-in".into(),
        ScreamShout => "screaming or shouting".into(),
        SnoringWhileDown => "snoring sounds while down".into(),
    }
}

fn capitalize_first(s: &str) -> String {
    let s = s.strip_prefix("a ").or_else(|| s.strip_prefix("the ")).unwrap_or(s);
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// "A, then b, then c" from the records' phrases: repeats collapse to their first mention. Single stumbles are left
/// out (weak on their own, and a yank looks like one); repeated stumbling tells that story.
fn join_phrases(recs: &[&IncidentRecord]) -> Option<String> {
    // the high-g warning that a fall / drop / grab replaced a moment later is not a separate event
    let superseded = |r: &IncidentRecord| {
        r.kind == IncidentKind::HardImpact
            && recs.iter().any(|o| {
                matches!(o.kind, IncidentKind::PossibleFall | IncidentKind::PhoneDrop | IncidentKind::Grab) && o.t_ms.abs_diff(r.t_ms) <= 15_000
            })
    };
    let mut phrases: Vec<String> = Vec::new();
    for r in recs.iter().filter(|r| r.kind != IncidentKind::Stumble && !superseded(r)) {
        let p = phrase(r);
        if !phrases.contains(&p) {
            phrases.push(p);
        }
    }
    let first = phrases.first()?;
    let mut out = capitalize_first(first);
    for p in &phrases[1..] {
        out.push_str(", then ");
        out.push_str(p);
    }
    Some(out)
}

impl IncidentLog {
    pub fn new(cfg: &SequenceCfg, log_cfg: &LogCfg, inc: &IncidentCfg, state: LogState, now_ms: u64) -> Self {
        let mut l = IncidentLog { cfg: cfg.clone(), log_cfg: log_cfg.clone(), inc: inc.clone(), state };
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
    pub fn get(&self, id: u32) -> Option<&IncidentRecord> {
        self.state.records.iter().find(|r| r.id == id)
    }
    pub fn is_active(&self, id: u32) -> bool {
        self.get(id).map(|r| r.cleared_ms == 0).unwrap_or(false)
    }
    pub fn active(&self) -> impl Iterator<Item = &IncidentRecord> {
        self.state.records.iter().filter(|r| r.cleared_ms == 0)
    }
    /// Newest active record of a kind.
    pub fn active_of(&self, kind: IncidentKind) -> Option<&IncidentRecord> {
        self.active().filter(|r| r.kind == kind).last()
    }
    pub fn episode_open(&self) -> bool {
        self.state.episode != 0
    }

    /// Append a record (assigns id and tier; joins the open episode) and return it.
    pub fn push(&mut self, mut rec: IncidentRecord) -> IncidentRecord {
        self.state.next_id += 1;
        rec.id = self.state.next_id;
        rec.tier = rec.kind.tier();
        rec.cleared_ms = if rec.kind.is_point() { rec.t_ms.max(1) } else { 0 };
        rec.acknowledged = false;
        rec.sequence_id = self.state.episode;
        rec.watched = self.state.episode != 0;
        self.state.records.push(rec.clone());
        rec
    }

    /// Mark an active record cleared; returns the updated record (None if unknown or already cleared).
    pub fn clear(&mut self, id: u32, t_ms: u64) -> Option<IncidentRecord> {
        let r = self.state.records.iter_mut().find(|r| r.id == id && r.cleared_ms == 0)?;
        r.cleared_ms = t_ms.max(r.t_ms).max(1);
        Some(r.clone())
    }

    /// Clear every active record; returns the updated records.
    pub fn clear_all(&mut self, t_ms: u64) -> Vec<IncidentRecord> {
        let ids: Vec<u32> = self.active().map(|r| r.id).collect();
        ids.into_iter().filter_map(|id| self.clear(id, t_ms)).collect()
    }

    /// The user answered a check-in: whatever is active now no longer asks for another one.
    pub fn acknowledge_active(&mut self) {
        for r in self.state.records.iter_mut().filter(|r| r.cleared_ms == 0) {
            r.acknowledged = true;
        }
    }

    /// Mark one record acknowledged (it replaced one the user had already answered for).
    pub fn acknowledge(&mut self, id: u32) {
        if let Some(r) = self.state.records.iter_mut().find(|r| r.id == id) {
            r.acknowledged = true;
        }
    }

    /// Drop records older than `log.expiry_h`. Called on load and every tick.
    pub fn expire(&mut self, now_ms: u64) {
        let ttl = (self.log_cfg.expiry_h * 3_600_000.0) as u64;
        self.state.records.retain(|r| now_ms.saturating_sub(r.t_ms) <= ttl);
    }

    /// Expiry plus pruning: a single stumble with nothing after it for `stumble_prune_min` is removed.
    pub fn maintain(&mut self, now_ms: u64) {
        self.expire(now_ms);
        let prune = (self.inc.stumble_prune_min * 60_000.0) as u64;
        let recs = &self.state.records;
        let keep: Vec<bool> = recs
            .iter()
            .map(|r| {
                if r.kind != IncidentKind::Stumble || r.watched || now_ms.saturating_sub(r.t_ms) < prune {
                    return true;
                }
                recs.iter().any(|o| o.id != r.id && o.t_ms >= r.t_ms && o.t_ms - r.t_ms <= prune)
            })
            .collect();
        let mut k = keep.into_iter();
        self.state.records.retain(|_| k.next().unwrap_or(true));
    }

    /// Ask "You okay?" now? True when an unacknowledged Danger incident is active, or unacknowledged Watch
    /// incidents from at least `min_families` families are. A missed check-in never re-triggers one, and a grab has
    /// its own path.
    pub fn check_trigger(&self, min_families: u32) -> bool {
        let mut fams: Vec<IncidentFamily> = Vec::new();
        for r in self.active().filter(|r| !r.acknowledged && !matches!(r.kind, IncidentKind::CheckInMissed | IncidentKind::Grab)) {
            match r.tier {
                IncidentTier::Danger => return true,
                IncidentTier::Watch => {
                    if !fams.contains(&r.kind.family()) {
                        fams.push(r.kind.family());
                    }
                }
                IncidentTier::Context => {}
            }
        }
        fams.len() as u32 >= min_families
    }

    /// An unacknowledged active Danger incident (a grab has its own path).
    pub fn unacked_danger(&self) -> bool {
        self.active().any(|r| !r.acknowledged && r.tier == IncidentTier::Danger && r.kind != IncidentKind::Grab)
    }

    /// Ask "You okay?" because of one serious incident on its own: an unacknowledged active incident of a
    /// `check_alone` kind that has been open for at least `after_ms` (so an impact can be reclassified first).
    pub fn check_trigger_alone(&self, alone: &[IncidentKind], after_ms: u64, now_ms: u64) -> bool {
        self.active()
            .any(|r| !r.acknowledged && alone.contains(&r.kind) && now_ms.saturating_sub(r.t_ms) >= after_ms)
    }

    /// Any active Watch / Danger incident (acknowledged ones included): full sensing stays on.
    pub fn watching(&self) -> bool {
        self.active().any(|r| r.tier >= IncidentTier::Watch)
    }

    /// Start an escalation episode: every record from the last `window_min` joins it. Returns the episode id.
    pub fn start_episode(&mut self, now_ms: u64) -> u32 {
        if self.state.episode != 0 {
            return self.state.episode;
        }
        self.state.next_seq += 1;
        let seq = self.state.next_seq;
        self.state.episode = seq;
        let window = (self.cfg.window_min * 60_000.0) as u64;
        for r in self.state.records.iter_mut().filter(|r| r.sequence_id == 0 && now_ms.saturating_sub(r.t_ms) <= window) {
            r.sequence_id = seq;
            r.watched = true;
        }
        seq
    }

    /// The episode was resolved (answered, marked safe, stood down): later incidents start fresh.
    /// Forget every record (user reset). Ids keep counting up so an old id never names a new record.
    pub fn reset(&mut self) {
        self.state.records.clear();
        self.state.episode = 0;
    }

    pub fn end_episode(&mut self) {
        self.state.episode = 0;
    }

    /// One line for the open (or most recent) episode, e.g. "Unsteady walking, then a hard fall, then down for 2 min".
    pub fn sequence_summary(&self) -> Option<String> {
        let seq = if self.state.episode != 0 {
            self.state.episode
        } else {
            self.state.records.iter().map(|r| r.sequence_id).filter(|s| *s > 0).max()?
        };
        let recs: Vec<&IncidentRecord> = self.state.records.iter().filter(|r| r.sequence_id == seq).collect();
        join_phrases(&recs)
    }

    /// Active incidents, most serious first ("Possible fall (3.4 g); separated from the group").
    pub fn active_summary(&self) -> String {
        let mut act: Vec<&IncidentRecord> = self.active().filter(|r| r.tier > IncidentTier::Context).collect();
        act.sort_by(|a, b| b.tier.cmp(&a.tier).then(b.t_ms.cmp(&a.t_ms)));
        act.iter().map(|r| r.summary.as_str()).collect::<Vec<_>>().join("; ")
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
            tier: kind.tier(),
            summary: kind.name().into(),
            sd_distance: 0.0,
            placement: Placement::Pocket,
            raw_json: raw.into(),
            cleared_ms: 0,
            acknowledged: false,
            sequence_id: 0,
            watched: false,
        }
    }

    fn log() -> IncidentLog {
        let c = Config::default_v1();
        IncidentLog::new(&c.sequence, &c.log, &c.incidents, LogState::default(), 0)
    }

    #[test]
    fn danger_alone_or_two_families_trigger_a_check() {
        let mut l = log();
        l.push(rec(0, IncidentKind::UnsteadyGait, "{}"));
        l.push(rec(1000, IncidentKind::SlowedWalk, "{}"));
        assert!(!l.check_trigger(2), "two gait incidents are one family");
        l.push(rec(2000, IncidentKind::Stumble, "{}"));
        assert!(!l.check_trigger(2), "context never counts");
        let sep = l.push(rec(3000, IncidentKind::Separated, "{}"));
        assert!(l.check_trigger(2), "gait + location");
        l.clear(sep.id, 4000);
        assert!(!l.check_trigger(2));
        l.push(rec(5000, IncidentKind::DownAfterFall, r#"{"down_s":130}"#));
        assert!(l.check_trigger(2), "danger alone");
        l.acknowledge_active();
        assert!(!l.check_trigger(2), "answered check-in acknowledges");
        assert!(l.watching(), "acknowledged incidents keep full sensing on");
        l.push(rec(6000, IncidentKind::CheckInMissed, "{}"));
        assert!(!l.check_trigger(2), "a missed check-in never re-triggers");
    }

    #[test]
    fn episode_summary_and_join() {
        let mut l = log();
        l.push(rec(0, IncidentKind::UnsteadyGait, "{}"));
        l.push(rec(60_000, IncidentKind::PossibleFall, r#"{"peak_g":4.6}"#));
        l.push(rec(180_000, IncidentKind::DownAfterFall, r#"{"down_s":120}"#));
        let seq = l.start_episode(181_000);
        assert!(l.records().iter().all(|r| r.watched && r.sequence_id == seq));
        assert_eq!(l.sequence_summary().unwrap(), "Unsteady walking, then a hard fall, then down for 2 min");
        let later = l.push(rec(300_000, IncidentKind::CheckInMissed, "{}"));
        assert_eq!(later.sequence_id, seq, "incidents during an episode join it");
        l.end_episode();
        let after = l.push(rec(400_000, IncidentKind::Separated, "{}"));
        assert_eq!(after.sequence_id, 0);
        assert!(l.sequence_summary().unwrap().ends_with("no answer to a check-in"));
    }

    #[test]
    fn isolated_stumble_pruned_and_expiry() {
        let mut l = log();
        l.push(rec(0, IncidentKind::Stumble, "{}"));
        l.maintain(29 * 60_000);
        assert_eq!(l.records().len(), 1);
        l.maintain(31 * 60_000);
        assert!(l.is_empty(), "isolated stumble pruned");
        let mut l = log();
        l.push(rec(0, IncidentKind::Stumble, "{}"));
        l.push(rec(60_000, IncidentKind::Stumble, "{}"));
        l.maintain(40 * 60_000);
        assert_eq!(l.records().len(), 1, "the first stumble had a follower; the second is now isolated");
        let mut l = log();
        l.push(rec(0, IncidentKind::HardImpact, "{}"));
        l.expire(7 * 3_600_000);
        assert_eq!(l.records().len(), 1);
        l.expire(8 * 3_600_000 + 1);
        assert!(l.is_empty());
    }

    #[test]
    fn old_blob_log_loads_empty() {
        #[derive(Deserialize)]
        struct W {
            #[serde(deserialize_with = "lenient_log")]
            log: LogState,
        }
        let old = r#"{"log":{"records":[{"id":1,"t_ms":5,"kind":"GaitDrift","p_normal":1.0}],"next_id":1,"next_seq":0}}"#;
        let w: W = serde_json::from_str(old).unwrap();
        assert!(w.log.records.is_empty());
    }
}
