//! 4-state HMM (Normal / Impaired / Incident / Unresponsive), log-space forward filter.
//! Context shifts ONLY forward transitions; emissions are conditioned on state.
use crate::config::{EmissionCfg, HmmCfg};
use crate::types::HmmState;

/// Observations accumulated over one filter step (~1 min, or an impact burst).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Observation {
    pub walking_seen: bool,
    /// gait drift z (only meaningful when walking_seen)
    pub gait_drift_z: f32,
    /// fall likelihood from the impact detector (0 = none)
    pub impact: f32,
    pub impact_peak_g: f32,
    /// seconds without body motion (0 if phone dropped alone)
    pub stillness_s: f32,
    pub agitation: f32,
    pub audio_jump: f32,
    pub phone_touched: bool,
    pub wrong_phrase: bool,
    pub typing_impaired: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ContextFlags {
    pub away_from_home: bool,
    pub separated: bool,
    pub late: bool,
    pub rapid_drift: bool,
}

pub struct Hmm {
    cfg: HmmCfg,
    em: EmissionCfg,
    /// log posterior
    log_p: [f32; 4],
    last_drift_z: f32,
    /// highest stillness bucket already emitted (bounded evidence)
    still_bucket: usize,
    evidence: Vec<String>,
}

fn softmax(l: &[f32; 4]) -> [f32; 4] {
    let m = l.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let e: Vec<f32> = l.iter().map(|x| (x - m).exp()).collect();
    let s: f32 = e.iter().sum();
    [e[0] / s, e[1] / s, e[2] / s, e[3] / s]
}

/// Mixture: soft observation x∈[0,1] of a Bernoulli with success prob p.
fn log_soft(p: f32, x: f32) -> f32 {
    let p = p.clamp(1e-4, 1.0 - 1e-4);
    let x = x.clamp(0.0, 1.0);
    (x * p + (1.0 - x) * (1.0 - p)).ln()
}

impl Hmm {
    pub fn new(cfg: &HmmCfg, em: &EmissionCfg) -> Self {
        let mut h = Hmm { cfg: cfg.clone(), em: em.clone(), log_p: [0.0; 4], last_drift_z: 0.0, still_bucket: 0, evidence: Vec::new() };
        h.reset();
        h
    }
    pub fn reset(&mut self) {
        self.set_posterior(self.cfg.initial);
        self.last_drift_z = 0.0;
        self.still_bucket = 0;
        self.evidence.clear();
    }
    pub fn set_posterior(&mut self, p: [f32; 4]) {
        for i in 0..4 {
            self.log_p[i] = p[i].max(1e-6).ln();
        }
        self.normalize();
    }
    fn normalize(&mut self) {
        let m = self.log_p.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let s: f32 = self.log_p.iter().map(|x| (x - m).exp()).sum();
        let ls = m + s.ln();
        for x in &mut self.log_p {
            *x -= ls;
        }
    }
    pub fn posterior(&self) -> [f32; 4] {
        [self.log_p[0].exp(), self.log_p[1].exp(), self.log_p[2].exp(), self.log_p[3].exp()]
    }
    pub fn p_danger(&self) -> f32 {
        let p = self.posterior();
        (p[2] + p[3]).clamp(0.0, 1.0)
    }
    pub fn state(&self) -> HmmState {
        let p = self.posterior();
        let i = (0..4).max_by(|a, b| p[*a].partial_cmp(&p[*b]).unwrap()).unwrap();
        HmmState::from_index(i)
    }
    pub fn evidence(&self) -> String {
        self.evidence.join(", ")
    }

    /// Transition matrix under context: softmax(base_logits + Σ ctx_i·w_i) on forward entries only.
    pub fn transition(&self, ctx: &ContextFlags) -> [[f32; 4]; 4] {
        let c = &self.cfg.context;
        let mut t = [[0.0f32; 4]; 4];
        for from in 0..4 {
            let mut logits = self.cfg.base_logits[from];
            let mut bump = 0.0;
            if ctx.away_from_home {
                bump += c.away_from_home[from];
            }
            if ctx.separated {
                bump += c.separated[from];
            }
            if ctx.late {
                bump += c.late[from];
            }
            if ctx.rapid_drift {
                bump += c.rapid_drift[from];
            }
            for to in (from + 1)..4 {
                logits[to] += bump;
            }
            t[from] = softmax(&logits);
        }
        t
    }

    /// Stillness buckets newly reached this step (bounded: each bucket is emitted once per still period).
    fn new_still_buckets(&self, o: &Observation) -> std::ops::Range<usize> {
        let edges = self.em.stillness_buckets_s;
        let reached = edges.iter().filter(|e| o.stillness_s >= **e).count();
        self.still_bucket.min(reached)..reached
    }

    /// Emission model. Design rule: a quiet minute (nothing seen) must be ~equally likely under
    /// Normal and Unresponsive, so sitting at a table for an hour never compounds into danger;
    /// only the Incident gateway (impact) separates them. Positive events (walking, touched)
    /// and bucket crossings carry the information.
    fn log_emission(&self, s: usize, o: &Observation, frac: f32) -> f32 {
        let e = &self.em;
        let mut l = 0.0;
        if o.walking_seen {
            l += e.p_walking[s].max(1e-4).ln();
            let sd = e.gait_z_sd[s].max(0.1);
            let d = (o.gait_drift_z - e.gait_z_mean[s]) / sd;
            l += -0.5 * d * d - sd.ln();
        }
        if o.impact >= 0.5 {
            l += e.p_impact[s].max(1e-4).ln();
        } else if o.impact > 0.0 {
            l += 0.5 * o.impact * e.p_impact[s].max(1e-4).ln();
        } else {
            l += frac * (1.0 - e.p_impact[s]).max(1e-4).ln();
        }
        for b in self.new_still_buckets(o) {
            l += e.p_stillness[s][b].max(1e-4).ln();
        }
        l += frac * log_soft(e.p_agitation[s], o.agitation);
        l += frac * log_soft(e.p_audio[s], o.audio_jump);
        if o.phone_touched {
            l += e.p_touched[s].max(1e-4).ln();
        }
        if o.wrong_phrase {
            l += e.p_wrong_phrase[s].max(1e-4).ln();
        }
        if o.typing_impaired {
            l += e.p_typing_impaired[s].max(1e-4).ln();
        }
        l
    }

    /// One full forward-filter step (one `step_seconds` period, or an impact). Returns P(danger).
    pub fn step(&mut self, o: &Observation, ctx: ContextFlags) -> f32 {
        self.step_frac(o, ctx, 1.0)
    }

    /// Forward step covering `frac` (0..1] of a step period: transitions are interpolated toward
    /// identity and rate-type "nothing happened" terms are scaled, while event evidence
    /// (impact, walking, bucket crossings, touched, wrong phrase) applies in full. Used for
    /// out-of-schedule evidence such as a wrong check-in phrase.
    pub fn step_frac(&mut self, o: &Observation, mut ctx: ContextFlags, frac: f32) -> f32 {
        let frac = frac.clamp(0.02, 1.0);
        if o.walking_seen {
            if o.gait_drift_z - self.last_drift_z >= self.cfg.context.rapid_drift_z_per_min && o.gait_drift_z > 1.5 {
                ctx.rapid_drift = true;
            }
            self.last_drift_z = o.gait_drift_z;
        }
        let mut t = self.transition(&ctx);
        if frac < 1.0 {
            for from in 0..4 {
                for to in 0..4 {
                    let id = if from == to { 1.0 } else { 0.0 };
                    t[from][to] = (1.0 - frac) * id + frac * t[from][to];
                }
            }
        }
        let mut next = [0.0f32; 4];
        for to in 0..4 {
            let mut acc = f32::NEG_INFINITY;
            for from in 0..4 {
                let v = self.log_p[from] + t[from][to].max(1e-9).ln();
                acc = log_add(acc, v);
            }
            next[to] = acc + self.log_emission(to, o, frac);
        }
        self.log_p = next;
        self.normalize();
        self.still_bucket = if o.stillness_s < self.em.stillness_buckets_s[0] { 0 } else { self.new_still_buckets(o).end };
        self.update_evidence(o);
        self.p_danger()
    }

    fn update_evidence(&mut self, o: &Observation) {
        let mut ev = Vec::new();
        if o.impact > 0.4 {
            ev.push(if o.impact_peak_g >= 4.0 { format!("hard fall ({:.1} g)", o.impact_peak_g) } else { "fall-like impact".to_string() });
        }
        if o.stillness_s >= 60.0 {
            ev.push(format!("no movement {} min", (o.stillness_s / 60.0).floor() as u32));
        }
        if o.walking_seen && o.gait_drift_z > 1.5 {
            ev.push(format!("unsteady gait (z {:.1})", o.gait_drift_z));
        }
        if o.agitation > 0.5 {
            ev.push("agitation".into());
        }
        if o.audio_jump > 0.4 {
            ev.push("commotion audio".into());
        }
        if o.wrong_phrase {
            ev.push("wrong check-in phrase".into());
        }
        if o.typing_impaired {
            ev.push("impaired typing".into());
        }
        // keep a fall in the summary while still
        if ev.iter().all(|e| !e.contains("fall")) && o.stillness_s >= 60.0 {
            if let Some(prev) = self.evidence.iter().find(|e| e.contains("fall")) {
                ev.insert(0, prev.clone());
            }
        }
        if !ev.is_empty() {
            self.evidence = ev;
        } else if self.p_danger() < 0.2 {
            self.evidence.clear();
        }
    }
}

fn log_add(a: f32, b: f32) -> f32 {
    if a == f32::NEG_INFINITY {
        return b;
    }
    if b == f32::NEG_INFINITY {
        return a;
    }
    let m = a.max(b);
    m + ((a - m).exp() + (b - m).exp()).ln()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn hmm() -> Hmm {
        let c = Config::default_v1();
        Hmm::new(&c.hmm, &c.emissions)
    }

    #[test]
    fn context_only_changes_forward_transitions() {
        let h = hmm();
        let base = h.transition(&ContextFlags::default());
        let ctx = h.transition(&ContextFlags { away_from_home: true, separated: true, late: true, rapid_drift: true });
        for from in 0..4 {
            // forward mass never decreases
            let fwd_base: f32 = (from + 1..4).map(|to| base[from][to]).sum();
            let fwd_ctx: f32 = (from + 1..4).map(|to| ctx[from][to]).sum();
            assert!(fwd_ctx >= fwd_base - 1e-6, "from {from}");
            // ratios among self/backward entries are unchanged (they only renormalize)
            for a in 0..=from {
                for b in 0..=from {
                    let r0 = base[from][a] / base[from][b];
                    let r1 = ctx[from][a] / ctx[from][b];
                    assert!((r0 - r1).abs() < 1e-4, "from {from} {a} {b}");
                }
            }
            let row: f32 = ctx[from].iter().sum();
            assert!((row - 1.0).abs() < 1e-4);
        }
        // Unresponsive has no forward moves; its row is untouched
        assert_eq!(base[3], ctx[3]);
    }

    #[test]
    fn stillness_after_impact_drives_unresponsive_and_recovery_works() {
        let mut h = hmm();
        let ctx = ContextFlags { away_from_home: true, ..Default::default() };
        for _ in 0..3 {
            h.step(&Observation { walking_seen: true, gait_drift_z: 3.0, ..Default::default() }, ctx);
        }
        assert!(h.posterior()[1] > 0.5, "impaired after drift: {:?}", h.posterior());
        h.step(&Observation { impact: 0.9, impact_peak_g: 4.5, ..Default::default() }, ctx);
        let mut still = 30.0;
        for _ in 0..6 {
            h.step(&Observation { stillness_s: still, ..Default::default() }, ctx);
            still += 60.0;
        }
        assert!(h.p_danger() > 0.95, "p_danger {}", h.p_danger());
        assert_eq!(h.state(), HmmState::Unresponsive);
        assert!(h.evidence().contains("fall") && h.evidence().contains("no movement"));
        // recovery: walking resumes normally
        for _ in 0..8 {
            h.step(&Observation { walking_seen: true, gait_drift_z: 0.2, phone_touched: true, ..Default::default() }, ctx);
        }
        assert!(h.p_danger() < 0.2, "recovered {}", h.p_danger());
    }

    #[test]
    fn sitting_still_alone_stays_normal() {
        let mut h = hmm();
        let ctx = ContextFlags { away_from_home: true, late: true, ..Default::default() };
        let mut still = 30.0;
        for _ in 0..40 {
            h.step(&Observation { stillness_s: still, ..Default::default() }, ctx);
            still += 60.0;
        }
        assert!(h.p_danger() < 0.3, "sitting still p_danger {}", h.p_danger());
    }
}
