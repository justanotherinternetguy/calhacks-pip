//! `Engine`: the single entry point mirrored by the FFI (docs/CONTRACTS.md §1).
use crate::baseline::Baseline;
use crate::config::Config;
use crate::escalation::Escalation;
use crate::hmm::{ContextFlags, Hmm, Observation};
use crate::signal::placement::PlacementVoter;
use crate::signal::{infer_placement, GaitAnalyzer, GaitFeatures, ImpactDetector, ImpactEvent, ImpactKind, SnatchDetector};
use crate::types::*;
use crate::typing;

pub struct Engine {
    cfg: Config,
    gait: GaitAnalyzer,
    impact: ImpactDetector,
    snatch: SnatchDetector,
    voter: PlacementVoter,
    baseline: Baseline,
    hmm: Hmm,
    esc: Escalation,
    ctx: Context,
    night_mode: bool,
    learning: bool,
    pending: Vec<MotionSample>,
    audio_bg: [f32; 3],
    last_step_ms: u64,
    obs: Observation,
    drift_samples: Vec<f32>,
    last_motion_ms: u64,
    placement: Placement,
    last_features: Option<GaitFeatures>,
    last_impact: Option<ImpactEvent>,
    events: Vec<EngineEvent>,
}

impl Engine {
    pub fn new(config_toml: &str, baseline_blob: Option<&[u8]>, now_ms: u64) -> Result<Engine, EngineError> {
        let cfg = Config::from_toml(config_toml)?;
        let baseline = match baseline_blob {
            Some(b) if !b.is_empty() => Baseline::from_bytes(b)?,
            _ => Baseline::new(),
        };
        Ok(Engine {
            gait: GaitAnalyzer::new(&cfg.gait),
            impact: ImpactDetector::new(&cfg.impact),
            snatch: SnatchDetector::new(&cfg.snatch),
            voter: PlacementVoter::new(),
            baseline,
            hmm: Hmm::new(&cfg.hmm, &cfg.emissions),
            esc: Escalation::new(&cfg.thresholds, now_ms ^ 0x5afe),
            cfg,
            ctx: Context::default(),
            night_mode: false,
            learning: true,
            pending: Vec::new(),
            audio_bg: [0.0; 3],
            last_step_ms: now_ms,
            obs: Observation::default(),
            drift_samples: Vec::new(),
            last_motion_ms: now_ms,
            placement: Placement::Unknown,
            last_features: None,
            last_impact: None,
            events: Vec::new(),
        })
    }

    pub fn with_default_config(now_ms: u64) -> Engine {
        Engine::new(crate::config::DEFAULT_TOML, None, now_ms).expect("bundled config valid")
    }

    // ---- pushes only buffer / update latest state ----

    pub fn push_motion(&mut self, samples: Vec<MotionSample>) {
        self.pending.extend(samples);
    }

    pub fn push_context(&mut self, ctx: Context) {
        if ctx.screen_on && !self.ctx.screen_on {
            self.obs.phone_touched = true;
            self.last_motion_ms = ctx.t_ms.max(self.last_motion_ms);
        }
        if ctx.screen_on {
            self.obs.phone_touched = true;
        }
        self.ctx = ctx;
    }

    pub fn push_audio(&mut self, s: AudioScores) {
        let raw = [s.scream, s.shout, s.glass];
        let mut jump = 0.0f32;
        for i in 0..3 {
            jump = jump.max(raw[i] - self.audio_bg[i]);
            self.audio_bg[i] += 0.05 * (raw[i] - self.audio_bg[i]);
        }
        self.obs.audio_jump = self.obs.audio_jump.max(jump.clamp(0.0, 1.0));
    }

    pub fn push_typing(&mut self, s: TypingSample, now_ms: u64) -> TypingVerdict {
        let (verdict, feats) = typing::verdict(&self.baseline.typing, &self.cfg.baseline, &self.cfg.thresholds, &s);
        let in_check = matches!(self.esc.level(), EscalationLevel::Check | EscalationLevel::HeadsUp);
        if in_check && self.night_mode {
            if verdict.accepted {
                self.push_action(UserAction::DismissOk, now_ms);
            } else if verdict.reason.starts_with("wrong phrase") {
                self.push_action(UserAction::DismissWrongPhrase, now_ms);
            } else {
                self.obs.typing_impaired = true;
                self.hmm_step_partial(now_ms);
                let ev = self.esc.typing_impaired(now_ms, self.hmm.p_danger(), &self.hmm.evidence());
                self.events.extend(ev);
            }
        } else if self.learning && feats.edit_ratio <= self.cfg.thresholds.typing_max_edit_ratio {
            // practice check-in: learn the typing baseline
            typing::learn(&mut self.baseline.typing, &self.cfg.baseline, &feats);
        }
        verdict
    }

    pub fn push_action(&mut self, a: UserAction, now_ms: u64) {
        let (ev, fx) = self.esc.apply_action(a, now_ms);
        self.events.extend(ev);
        if fx.reset_posterior {
            self.hmm.set_posterior(self.cfg.thresholds.dismiss_posterior);
            self.last_motion_ms = now_ms;
            self.obs = Observation::default();
            self.obs.phone_touched = true;
        }
        if fx.wrong_phrase {
            self.obs.wrong_phrase = true;
            self.hmm_step_partial(now_ms);
        }
        if fx.snatch_cleared {
            self.snatch.reset();
        }
    }

    pub fn set_night_mode(&mut self, active: bool, now_ms: u64) {
        if active == self.night_mode {
            return;
        }
        self.night_mode = active;
        self.hmm.reset();
        self.esc.reset();
        self.obs = Observation::default();
        self.drift_samples.clear();
        self.last_step_ms = now_ms;
        self.last_motion_ms = now_ms;
        if active {
            self.events.push(EngineEvent::LocationIntervalChanged { seconds: self.esc.location_interval_s() });
        }
    }

    pub fn set_learning(&mut self, enabled: bool) {
        self.learning = enabled;
    }

    // ---- tick drives everything ----

    pub fn tick(&mut self, now_ms: u64) -> Vec<EngineEvent> {
        let pending = std::mem::take(&mut self.pending);
        for s in pending {
            if let Some(ev) = self.impact.push(&s) {
                self.on_impact(ev);
            }
            self.snatch.push_sample(&s, self.ctx.screen_on);
            if let Some(f) = self.gait.push(s) {
                self.on_features(f);
            }
        }
        if self.night_mode {
            if now_ms.saturating_sub(self.last_step_ms) >= self.cfg.hmm.step_seconds as u64 * 1000 {
                self.hmm_step(now_ms);
            }
            let p = self.hmm.p_danger();
            let ev = self.esc.update(now_ms, p, &self.hmm.evidence());
            self.events.extend(ev);
            let ev = self.esc.battery(self.ctx.battery_pct);
            self.events.extend(ev);
        }
        std::mem::take(&mut self.events)
    }

    fn on_impact(&mut self, ev: ImpactEvent) {
        self.last_impact = Some(ev);
        if ev.kind == ImpactKind::Drop {
            return; // phone fell alone; stillness afterwards is not body stillness
        }
        self.last_motion_ms = ev.t_ms; // impact itself is motion; stillness is counted from here
        if ev.fall_likelihood > self.obs.impact {
            self.obs.impact = ev.fall_likelihood;
            self.obs.impact_peak_g = ev.peak_g;
        }
        if self.night_mode && ev.fall_likelihood >= 0.5 {
            // immediate HMM update on impact; the walking/agitation seen *before* the fall belongs
            // to the previous minute and must not argue against Incident here
            self.obs.walking_seen = false;
            self.obs.agitation = 0.0;
            self.drift_samples.clear();
            let t = ev.t_ms + self.cfg.impact.impact_window_ms + self.cfg.impact.post_window_ms;
            self.hmm_step(t);
        }
    }

    fn on_features(&mut self, f: GaitFeatures) {
        self.last_features = Some(f);
        self.placement = self.voter.push(infer_placement(&f, self.ctx.screen_on));
        let g = &self.cfg.gait;
        if f.energy_rms > g.still_rms_g || f.steps > 2 {
            self.last_motion_ms = f.t_ms;
        }
        if f.is_walking {
            let z = self.baseline.zscore(&self.cfg.baseline, self.placement, &f);
            self.drift_samples.push(z.drift);
            self.obs.walking_seen = true;
            if self.learning && !self.night_mode && self.ctx.activity == Activity::Walking && self.placement != Placement::Unknown {
                self.baseline.learn(&self.cfg.baseline, self.placement, &f, g.hop_s);
            }
        }
        self.obs.agitation = self.obs.agitation.max(f.agitation);
        if let Some(sn) = self.snatch.update(f.t_ms, f.is_running, self.ctx.speed_mps, self.ctx.separated) {
            if self.night_mode {
                let summary = format!("phone snatched: jerk {:.0} g/s then running (speed {:.1} m/s)", sn.jerk_g_per_s, sn.summary_speed.max(0.0));
                let ev = self.esc.snatch(summary);
                self.events.extend(ev);
            }
        }
    }

    fn stillness_s(&self, now_ms: u64) -> f32 {
        if self.impact.drop_active {
            return 0.0;
        }
        now_ms.saturating_sub(self.last_motion_ms) as f32 / 1000.0
    }

    fn context_flags(&self) -> ContextFlags {
        let c = &self.cfg.hmm.context;
        let h = self.ctx.hour_local;
        let late = if c.late_hour_start <= c.late_hour_end {
            h >= c.late_hour_start && h <= c.late_hour_end
        } else {
            h >= c.late_hour_start || h <= c.late_hour_end
        };
        ContextFlags { away_from_home: self.ctx.away_from_home, separated: self.ctx.separated, late, rapid_drift: false }
    }

    /// Full step: scheduled once per `step_seconds`, and immediately on a fall-like impact.
    fn hmm_step(&mut self, now_ms: u64) {
        self.hmm_step_with(now_ms, 1.0);
    }

    /// Out-of-schedule evidence (wrong phrase, impaired typing): only the elapsed fraction of a step.
    fn hmm_step_partial(&mut self, now_ms: u64) {
        let frac = now_ms.saturating_sub(self.last_step_ms) as f32 / (self.cfg.hmm.step_seconds as f32 * 1000.0);
        self.hmm_step_with(now_ms, frac.clamp(0.05, 1.0));
    }

    fn hmm_step_with(&mut self, now_ms: u64, frac: f32) {
        let mut obs = std::mem::take(&mut self.obs);
        obs.stillness_s = self.stillness_s(now_ms);
        if !self.drift_samples.is_empty() {
            obs.gait_drift_z = self.drift_samples.iter().sum::<f32>() / self.drift_samples.len() as f32;
        }
        self.drift_samples.clear();
        let flags = self.context_flags();
        self.hmm.step_frac(&obs, flags, frac);
        self.obs.phone_touched = self.ctx.screen_on;
        self.last_step_ms = now_ms;
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            p_danger: self.hmm.p_danger(),
            hmm_state: self.hmm.state(),
            escalation: self.esc.level(),
            risk_band: self.esc.risk_band(),
            evidence: self.hmm.evidence(),
            baseline_seconds: self.baseline.walking_seconds() as u32,
            placement: self.placement,
            night_mode: self.night_mode,
        }
    }

    pub fn export_baseline(&self) -> Vec<u8> {
        self.baseline.to_bytes()
    }

    // ---- introspection for tests / sim ----
    pub fn posterior(&self) -> [f32; 4] {
        self.hmm.posterior()
    }
    pub fn last_features(&self) -> Option<GaitFeatures> {
        self.last_features
    }
    pub fn last_impact(&self) -> Option<ImpactEvent> {
        self.last_impact
    }
    pub fn drop_active(&self) -> bool {
        self.impact.drop_active
    }
    pub fn check_phrase(&self) -> &str {
        self.esc.phrase()
    }
}
