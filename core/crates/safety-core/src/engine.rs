//! `Engine`: the single entry point mirrored by the FFI (docs/CONTRACTS.md §1 + §6).
use crate::baseline::{local_day, Baseline};
use crate::config::Config;
use crate::escalation::Escalation;
use crate::hmm::{ContextFlags, Hmm, Observation};
use crate::log::IncidentLog;
use crate::signal::placement::PlacementVoter;
use crate::signal::live::SPIKE_FIRST;
use crate::signal::{infer_placement, Bands, DriftTracker, GaitAnalyzer, GaitFeatures, GrabDetector, ImpactDetector, ImpactEvent, ImpactKind, SpikeTracker};
use crate::types::*;
use crate::typing;
use std::collections::VecDeque;

pub struct Engine {
    cfg: Config,
    gait: GaitAnalyzer,
    impact: ImpactDetector,
    grab: GrabDetector,
    drift: DriftTracker,
    /// per-tick spike blocks (jerk / rotation / peak_g) for the live-metrics peak-hold
    spikes: SpikeTracker,
    voter: PlacementVoter,
    baseline: Baseline,
    hmm: Hmm,
    esc: Escalation,
    log: IncidentLog,
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
    // ---- v1.1 ----
    bands: Bands,
    now_ms: u64,
    sampling_full_desired: Option<bool>,
    last_incident_ms: Option<u64>,
    last_impact_incident_ms: Option<u64>,
    stillness_fired_for: Option<u64>,
    separated_since: Option<u64>,
    separated_fired: bool,
    home_hist: VecDeque<(u64, f32)>,
    session_incident: bool,
    sequence_boost: f32,
}

impl Engine {
    pub fn new(config_toml: &str, baseline_blob: Option<&[u8]>, now_ms: u64) -> Result<Engine, EngineError> {
        let cfg = Config::from_toml(config_toml)?;
        let mut baseline = match baseline_blob {
            Some(b) if !b.is_empty() => Baseline::from_bytes(b)?,
            _ => Baseline::new(),
        };
        let log_state = std::mem::take(&mut baseline.log);
        Ok(Engine {
            gait: GaitAnalyzer::new(&cfg.gait),
            impact: ImpactDetector::new(&cfg.impact),
            grab: GrabDetector::new(&cfg.grab),
            drift: DriftTracker::new(),
            spikes: SpikeTracker::new(cfg.signals.spike_hold_s),
            voter: PlacementVoter::new(),
            baseline,
            hmm: Hmm::new(&cfg.hmm, &cfg.emissions),
            esc: Escalation::new(&cfg.thresholds, now_ms ^ 0x5afe),
            log: IncidentLog::new(&cfg.sequence, &cfg.log, log_state, now_ms),
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
            bands: Bands::default(),
            now_ms,
            sampling_full_desired: None,
            last_incident_ms: None,
            last_impact_incident_ms: None,
            stillness_fired_for: None,
            separated_since: None,
            separated_fired: false,
            home_hist: VecDeque::new(),
            session_incident: false,
            sequence_boost: 0.0,
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
        if ctx.screen_on || (ctx.last_touch_ms > self.ctx.last_touch_ms && ctx.last_touch_ms > 0) {
            // screen on, or a new touch / interactive unlock: the phone is being handled
            self.obs.phone_touched = true;
        }
        if ctx.t_ms > 0 {
            self.baseline.prune(&self.cfg.baseline, local_day(ctx.t_ms, ctx.hour_local));
        }
        // separation / heading-home history
        if ctx.separated {
            if self.separated_since.is_none() {
                self.separated_since = Some(ctx.t_ms);
                self.separated_fired = false;
                self.home_hist.clear();
            }
            if ctx.distance_home_m >= 0.0 {
                self.home_hist.push_back((ctx.t_ms, ctx.distance_home_m));
                let keep = (self.cfg.signals.separated_min * 60_000.0) as u64 * 2;
                while self.home_hist.front().map(|(t, _)| ctx.t_ms.saturating_sub(*t) > keep).unwrap_or(false) {
                    self.home_hist.pop_front();
                }
            }
        } else {
            self.separated_since = None;
            self.separated_fired = false;
            self.home_hist.clear();
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
                let raw = format!(
                    "{{\"z\":{:.3},\"ik_median_ms\":{:.1},\"ik_cv\":{:.3},\"backspace_rate\":{:.3},\"edit_ratio\":{:.3},\"ms_per_char\":{:.1}}}",
                    verdict.z_score, feats.ik_median_ms, feats.ik_cv, feats.backspace_rate, feats.edit_ratio, feats.ms_per_char
                );
                self.record_incident(
                    IncidentKind::TypingOff,
                    now_ms,
                    format!("Check-in typing far off baseline (z {:.1})", verdict.z_score),
                    verdict.z_score,
                    raw,
                );
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
            self.log.resolve();
            self.sequence_boost = 0.0;
            self.stillness_fired_for = self.last_impact_incident_ms;
        }
        if fx.wrong_phrase {
            self.obs.wrong_phrase = true;
            self.hmm_step_partial(now_ms);
        }
        if fx.snatch_cleared {
            self.grab.reset();
        }
    }

    pub fn set_night_mode(&mut self, active: bool, now_ms: u64) {
        if active == self.night_mode {
            return;
        }
        if !active {
            // a night that produced an incident is not representative: drop its walking
            if self.session_incident {
                self.baseline.discard_session();
            } else {
                self.baseline.commit_session(&self.cfg.baseline);
            }
        }
        self.session_incident = false;
        self.night_mode = active;
        self.hmm.reset();
        self.esc.reset();
        self.grab.reset();
        self.drift.reset();
        self.spikes.reset();
        self.obs = Observation::default();
        self.drift_samples.clear();
        self.last_step_ms = now_ms;
        self.last_motion_ms = now_ms;
        self.stillness_fired_for = None;
        self.separated_fired = false;
        self.sequence_boost = 0.0;
        if active {
            self.events.push(EngineEvent::LocationIntervalChanged { seconds: self.esc.location_interval_s() });
        }
    }

    pub fn set_learning(&mut self, enabled: bool) {
        self.learning = enabled;
    }

    // ---- tick drives everything ----

    pub fn tick(&mut self, now_ms: u64) -> Vec<EngineEvent> {
        self.now_ms = now_ms;
        let pending = std::mem::take(&mut self.pending);
        let full = self.ctx.sampling_full;
        for s in pending {
            self.spikes.push(&s);
            if let Some(ev) = self.impact.push(&s) {
                self.on_impact(ev);
            }
            if full {
                let in_hand = self.in_hand(s.t_ms);
                self.grab.push_sample(&s, in_hand);
            }
            if let Some(f) = self.gait.push(s, full) {
                self.on_features(f);
            }
        }
        // the live-metrics spike block closes every tick, whether or not a gait window completed
        self.spikes.close_block(now_ms);
        if self.night_mode {
            self.check_stillness(now_ms);
            self.check_separated(now_ms);
        }
        self.sequence_boost = self.log.analyze(now_ms);
        self.update_sampling(now_ms);
        if self.night_mode {
            if now_ms.saturating_sub(self.last_step_ms) >= self.cfg.hmm.step_seconds as u64 * 1000 {
                self.hmm_step(now_ms);
            }
            let p = self.hmm.p_danger();
            let summary = self.log.sequence_summary(now_ms).unwrap_or_default();
            let ev = self.esc.update(now_ms, p, &self.hmm.evidence(), &summary);
            self.events.extend(ev);
            let ev = self.esc.battery(self.ctx.battery_pct);
            self.events.extend(ev);
        }
        std::mem::take(&mut self.events)
    }

    /// Phone in hand: touched within `in_hand_touch_s`, or screen on in a held orientation.
    fn in_hand(&self, t_ms: u64) -> bool {
        let touched = self.ctx.last_touch_ms > 0
            && t_ms.saturating_sub(self.ctx.last_touch_ms) <= (self.cfg.grab.in_hand_touch_s * 1000.0) as u64;
        touched || (self.ctx.screen_on && self.placement == Placement::Hand)
    }

    fn record_incident(&mut self, kind: IncidentKind, t_ms: u64, summary: String, sd_distance: f32, raw_json: String) {
        let p = self.hmm.posterior();
        let rec = IncidentRecord {
            id: 0,
            t_ms,
            kind,
            summary,
            sd_distance,
            placement: self.placement,
            raw_json,
            p_normal: p[0],
            p_impaired: p[1],
            p_incident: p[2],
            p_unresponsive: p[3],
            sequence_id: 0,
            watched: false,
        };
        let rec = self.log.push(rec);
        self.last_incident_ms = Some(self.last_incident_ms.map_or(t_ms, |l| l.max(t_ms)));
        if kind == IncidentKind::Impact {
            self.last_impact_incident_ms = Some(t_ms);
        }
        self.session_incident = true;
        // run the sequence agent now so the emitted record already carries sequence_id / watched
        self.sequence_boost = self.log.analyze(t_ms.max(self.now_ms));
        let rec = self.log.records().iter().find(|r| r.id == rec.id).cloned().unwrap_or(rec);
        self.events.push(EngineEvent::SignalIncident { record: rec });
        // the state probabilities react within the tick: an immediate (elapsed-fraction) HMM step with the
        // evidence gathered so far and the sequence boost just computed. Impacts run their own step in
        // `on_impact` (a fall-like impact takes a full step after its post window).
        if kind != IncidentKind::Impact {
            self.hmm_step_partial(t_ms.max(self.now_ms));
        }
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
        if self.night_mode && ev.is_incident(&self.cfg.impact) && !self.grab.is_armed(ev.t_ms) {
            let summary = if ev.fall_likelihood >= 0.5 {
                if ev.peak_g >= 4.0 { format!("Hard fall ({:.1} g)", ev.peak_g) } else { format!("Fall ({:.1} g)", ev.peak_g) }
            } else {
                format!("Hard impact ({:.1} g) with orientation change", ev.peak_g)
            };
            let raw = format!(
                "{{\"peak_g\":{:.3},\"free_fall_ms\":{},\"orientation_change_deg\":{:.1},\"post_motion_rms\":{:.4},\"fall_likelihood\":{:.2}}}",
                ev.peak_g, ev.free_fall_ms, ev.orientation_change_deg, ev.post_motion_rms, ev.fall_likelihood
            );
            let sd = self.bands.get("peak_g").map(|b| (ev.peak_g - b.mean) / b.sd.max(1e-6)).unwrap_or(0.0);
            self.record_incident(IncidentKind::Impact, ev.t_ms, summary, sd, raw);
            if ev.fall_likelihood < 0.5 {
                // hard impact without a fall pattern: no full step below, so react now
                self.hmm_step_partial(ev.t_ms.max(self.now_ms));
            }
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
        let g = self.cfg.gait.clone();
        if f.energy_rms > g.still_rms_g || f.steps > 2 {
            self.last_motion_ms = f.t_ms;
        }
        self.bands = Bands::compute(&self.baseline, &self.cfg.baseline, &self.cfg.signals, self.placement, &f);
        let k = if self.bands.trusted { self.cfg.signals.band_sd } else { self.cfg.signals.band_sd_untrusted };
        self.grab.set_bands(self.bands.upper("jerk", k), self.bands.upper("rotation", k));
        if f.full && f.is_walking {
            let z = self.baseline.zscore(&self.cfg.baseline, self.placement, &f);
            self.drift_samples.push(z.drift);
            self.obs.walking_seen = true;
            if self.learning && self.ctx.activity == Activity::Walking && self.placement != Placement::Unknown {
                let day = local_day(f.t_ms, self.ctx.hour_local);
                self.baseline.learn(&self.cfg.baseline, self.placement, &f, g.hop_s, day, self.night_mode);
            }
            // the OS activity gates drift: sporadic periodic windows while dancing / riding are not walking
            let os_walking = !matches!(self.ctx.activity, Activity::Stationary | Activity::Vehicle);
            let (oob, worst) = self.bands.drift_out();
            let fire = os_walking && self.drift.push_walking(&self.cfg.signals, g.hop_s, f.t_ms, &oob, worst);
            if fire && self.night_mode {
                let names = self.drift.metrics.join(", ");
                let persist = self.drift.persist_s(g.hop_s);
                let summary = format!("Unsteady walking: {names} out of band ({:+.1} SD) for {:.0} s", self.drift.worst_sd, persist);
                let raw = self.bands.raw_json();
                self.record_incident(IncidentKind::GaitDrift, f.t_ms, summary, self.drift.worst_sd, raw);
            }
        }
        self.obs.agitation = self.obs.agitation.max(f.agitation);
        if f.full {
            if let Some(gr) = self.grab.update(f.t_ms, f.is_running, self.ctx.speed_mps, self.ctx.separated) {
                if self.night_mode {
                    let summary = format!(
                        "phone grabbed: jerk {:.0} g/s, rotation {:.0} deg/s, then {}",
                        gr.jerk_g_per_s,
                        gr.rotation_dps,
                        if gr.running { "running".to_string() } else { format!("moving at {:.1} m/s", gr.speed_mps.max(0.0)) }
                    );
                    let raw = format!(
                        "{{\"jerk_g_per_s\":{:.1},\"rotation_dps\":{:.1},\"speed_mps\":{:.2},\"running\":{}}}",
                        gr.jerk_g_per_s, gr.rotation_dps, gr.speed_mps, gr.running
                    );
                    let sd = self.bands.get("jerk").map(|b| (gr.jerk_g_per_s - b.mean) / b.sd.max(1e-6)).unwrap_or(0.0);
                    self.record_incident(IncidentKind::Grab, gr.t_ms, summary.clone(), sd, raw);
                    let seq = self.log.sequence_summary(gr.t_ms).unwrap_or_else(|| summary.clone());
                    let ev = self.esc.grab(gr.t_ms, seq);
                    self.events.extend(ev);
                }
            }
        }
    }

    /// Stillness incident: still ≥ stillness_s and no touch ≥ stillness_s after an impact incident.
    fn check_stillness(&mut self, now_ms: u64) {
        let Some(ti) = self.last_impact_incident_ms else { return };
        if self.stillness_fired_for == Some(ti) {
            return;
        }
        let s = &self.cfg.signals;
        if now_ms.saturating_sub(ti) as f32 > s.stillness_after_impact_min * 60_000.0 {
            return;
        }
        let still_s = self.stillness_s(now_ms);
        let last_touch = self.ctx.last_touch_ms;
        let touch_age_s = if last_touch == 0 { f32::MAX } else { now_ms.saturating_sub(last_touch.max(ti)) as f32 / 1000.0 };
        if still_s >= s.stillness_s && touch_age_s >= s.stillness_s {
            self.stillness_fired_for = Some(ti);
            let since = now_ms.saturating_sub(ti) as f32 / 1000.0;
            let raw = format!(
                "{{\"stillness_s\":{:.0},\"since_impact_s\":{:.0},\"last_touch_age_s\":{}}}",
                still_s,
                since,
                if last_touch == 0 { "null".to_string() } else { format!("{:.0}", touch_age_s) }
            );
            let summary = format!("No movement for {} min after impact, phone untouched", (still_s / 60.0).floor() as u32);
            self.record_incident(IncidentKind::Stillness, now_ms, summary, 0.0, raw);
        }
    }

    /// Separated incident: separated for ≥ separated_min while distance to home is not decreasing.
    fn check_separated(&mut self, now_ms: u64) {
        let Some(since) = self.separated_since else { return };
        if self.separated_fired || !self.ctx.separated {
            return;
        }
        let s = &self.cfg.signals;
        let dur_s = now_ms.saturating_sub(since) as f32 / 1000.0;
        if dur_s < s.separated_min * 60.0 {
            return;
        }
        let start = self.home_hist.front().map(|(_, d)| *d).unwrap_or(-1.0);
        let cur = self.ctx.distance_home_m;
        let heading_home = start >= 0.0 && cur >= 0.0 && start - cur > s.separated_home_margin_m;
        if heading_home {
            return;
        }
        self.separated_fired = true;
        let raw = format!("{{\"separated_s\":{:.0},\"distance_home_m\":{:.0},\"distance_home_start_m\":{:.0}}}", dur_s, cur, start);
        let summary = format!("Separated from the group for {} min, not heading home", (dur_s / 60.0).floor() as u32);
        self.record_incident(IncidentKind::Separated, now_ms, summary, 0.0, raw);
    }

    /// Engine-decided sensor mode; emits `SamplingRateChanged` on change and once at the first tick.
    fn update_sampling(&mut self, now_ms: u64) {
        let sc = &self.cfg.sampling;
        let h = self.ctx.hour_local;
        let night_window = h >= sc.full_hour_start || h < sc.full_hour_end;
        let recent_incident = self.last_incident_ms.map(|t| now_ms.saturating_sub(t) as f32 <= sc.after_incident_min * 60_000.0).unwrap_or(false);
        let learn_walk = sc.learn_walks_full_rate
            && self.learning
            && !self.night_mode
            && self.ctx.activity == Activity::Walking
            && !self.baseline.any_trusted(&self.cfg.baseline);
        let want_full = (self.ctx.away_from_home && night_window) || recent_incident || learn_walk;
        if self.sampling_full_desired != Some(want_full) {
            self.sampling_full_desired = Some(want_full);
            let (hz, gyro) = if want_full { (sc.full_hz, true) } else { (sc.low_hz, false) };
            self.events.push(EngineEvent::SamplingRateChanged { hz, gyro });
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
        ContextFlags {
            away_from_home: self.ctx.away_from_home,
            separated: self.ctx.separated,
            late,
            rapid_drift: false,
            sequence_boost: self.sequence_boost,
        }
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

    /// Activity from the freshest motion evidence: the last gait window if it is at most one hop old,
    /// otherwise the last 1 s spike block (stillness), otherwise the OS activity.
    fn activity(&self) -> Activity {
        let still = self.cfg.gait.still_rms_g;
        let fresh = |t: u64| self.now_ms.saturating_sub(t) <= (self.cfg.gait.hop_s * 1000.0) as u64 + 1000;
        match self.last_features {
            Some(f) if fresh(f.t_ms) && f.is_running => Activity::Running,
            Some(f) if fresh(f.t_ms) && f.is_walking => Activity::Walking,
            Some(f) if fresh(f.t_ms) && f.energy_rms < still => Activity::Stationary,
            _ => match self.spikes.latest() {
                Some(b) if fresh(b.t_ms) && b.energy_rms < still => Activity::Stationary,
                _ => self.ctx.activity,
            },
        }
    }

    /// Live metrics vs. bands, the four state probabilities and baseline trust (dashboard).
    ///
    /// Never more than one tick stale: the gait metrics (cadence, stride_cv, regularity, sway, wobble)
    /// are the latest 1 s-hop window with their instantaneous band status (the 30 s persistence only
    /// gates the GaitDrift *incident*; a building run is spelled out in `evidence`), and the spike
    /// metrics (jerk, rotation, peak_g) are a peak-hold over the last `signals.spike_hold_s` seconds
    /// of per-tick blocks with the band evaluated against the held peak. In low-rate mode the gait and
    /// gyro bands are unavailable (value 0, in band, baseline mean/sd) and `evidence` says so.
    pub fn metrics(&self) -> LiveMetrics {
        let now = self.now_ms;
        let full = self.ctx.sampling_full;
        let bcfg = &self.cfg.baseline;
        let scfg = &self.cfg.signals;
        let trusted = self.baseline.trusted(bcfg, self.placement);
        let k = if trusted { scfg.band_sd } else { scfg.band_sd_untrusted };
        let mut bands = if self.bands.bands.is_empty() {
            // no gait window yet: baseline bands with empty values so the dashboard shows the targets
            Bands::compute(&self.baseline, bcfg, scfg, self.placement, &GaitFeatures::default()).bands
        } else {
            self.bands.bands.clone()
        };
        let held = self.spikes.held(now);
        let act = self.activity();
        let walking = matches!(act, Activity::Walking | Activity::Running);
        for (mi, b) in bands.iter_mut().enumerate() {
            if mi >= SPIKE_FIRST {
                let (value, evaluable) = match held {
                    Some(h) => match mi - SPIKE_FIRST {
                        0 => (h.jerk_peak, full),
                        1 => (h.rot_peak_dps, full && h.has_gyro),
                        _ => (h.peak_g, true),
                    },
                    None => (0.0, false),
                };
                b.value = if evaluable { value } else { 0.0 };
                b.sd_distance = if evaluable { (value - b.mean) / b.sd.max(1e-6) } else { 0.0 };
                b.in_band = !evaluable || Bands::within(mi, b.sd_distance, k);
            } else if !full {
                b.value = 0.0;
                b.sd_distance = 0.0;
                b.in_band = true;
            } else if !walking {
                // Gait bands only mean something while walking; standing still is not "-11 SD of cadence".
                b.sd_distance = 0.0;
                b.in_band = true;
            }
        }
        let mut evidence = self.hmm.evidence();
        let mut note = |s: String| {
            if !evidence.is_empty() {
                evidence.push_str("; ");
            }
            evidence.push_str(&s);
        };
        if full && !walking {
            note("not walking: gait bands idle".to_string());
        }
        if full {
            if let Some((names, persist)) = self.drift.building(scfg, self.cfg.gait.hop_s, now) {
                if !names.is_empty() {
                    note(format!("{} out of band for {:.0} s", names.join(", "), persist));
                }
            }
        } else {
            note("low-rate sampling: gait metrics paused".to_string());
        }
        let p = self.hmm.posterior();
        LiveMetrics {
            t_ms: now,
            placement: self.placement,
            sampling_full: full,
            activity: act,
            bands,
            p_normal: p[0],
            p_impaired: p[1],
            p_incident: p[2],
            p_unresponsive: p[3],
            baseline_trusted: trusted,
            baseline_walk_days: self.baseline.walk_days(self.placement) as f32,
            evidence,
        }
    }

    /// Incident log, newest last; entries expire after `log.expiry_h`.
    pub fn incident_log(&self) -> Vec<IncidentRecord> {
        self.log.records().to_vec()
    }

    /// Opaque blob: baselines + pending session + typing + incident log.
    pub fn export_baseline(&self) -> Vec<u8> {
        let mut b = self.baseline.clone();
        b.log = self.log.state().clone();
        b.to_bytes()
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
    pub fn sequence_boost(&self) -> f32 {
        self.sequence_boost
    }
    pub fn sequence_summary(&self) -> Option<String> {
        self.log.sequence_summary(self.now_ms)
    }
    pub fn sampling_full_desired(&self) -> Option<bool> {
        self.sampling_full_desired
    }
    /// Time of the last HMM forward step (scheduled or immediate).
    pub fn last_hmm_step_ms(&self) -> u64 {
        self.last_step_ms
    }
    pub fn baseline(&self) -> &Baseline {
        &self.baseline
    }
}
