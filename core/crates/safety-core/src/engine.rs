//! `Engine`: the single entry point mirrored by the FFI (docs/CONTRACTS.md §1 + §6).
//!
//! Rule-based: every signal opens and clears explicit incidents (see `IncidentKind` for tiers and families,
//! `model-v1.toml [incidents]` for the rules). Watch / Danger incidents turn on full sensing; a fall, grab, missed
//! check-in or unsteady gait opens the microphone listening window; the incident log decides when to ask
//! "You okay?" and the escalation state machine takes it from there. There is no probability model.
use crate::baseline::{local_day, Baseline};
use crate::config::Config;
use crate::escalation::Escalation;
use crate::log::IncidentLog;
use crate::signal::live::SPIKE_FIRST;
use crate::signal::placement::PlacementVoter;
use crate::signal::{
    infer_placement, AudioWindow, Bands, DriftRule, DriftStep, DriftTracker, GaitAnalyzer, GaitFeatures, GrabDetector,
    ImpactDetector, ImpactEvent, ImpactKind, SpikeTracker, StumbleRule,
};
use crate::types::*;
use crate::typing;
use std::collections::VecDeque;

/// A possible fall or hard impact being watched for recovery (steps) or for "down after fall".
#[derive(Clone, Copy, Debug)]
struct FallWatch {
    /// impact time
    t_ms: u64,
    /// end of the impact's post window: "down" is counted from here
    end_ms: u64,
    /// last sign of being responsive: a touch
    alive_ms: u64,
    down_logged: bool,
    snore_logged: bool,
}

pub struct Engine {
    cfg: Config,
    gait: GaitAnalyzer,
    impact: ImpactDetector,
    grab: GrabDetector,
    /// The HardImpact opened at the high-g onset, until the impact is classified (fall / drop / grab / nothing).
    onset_impact: Option<u32>,
    /// A phone drop waiting `drop_pickup_s` for a pickup before it is logged.
    pending_drop: Option<ImpactEvent>,
    unsteady: DriftTracker,
    slowed: DriftTracker,
    /// per-tick spike blocks (jerk / rotation / peak_g) for the live-metrics peak-hold
    spikes: SpikeTracker,
    voter: PlacementVoter,
    baseline: Baseline,
    esc: Escalation,
    log: IncidentLog,
    audio: AudioWindow,
    ctx: Context,
    night_mode: bool,
    learning: bool,
    pending: Vec<MotionSample>,
    placement: Placement,
    last_features: Option<GaitFeatures>,
    last_impact: Option<ImpactEvent>,
    last_gravity: Option<[f32; 3]>,
    events: Vec<EngineEvent>,
    bands: Bands,
    now_ms: u64,
    sampling_full_desired: Option<bool>,
    listening: Option<bool>,
    last_incident_ms: Option<u64>,
    session_incident: bool,
    // ---- incident rule state ----
    fall: Option<FallWatch>,
    /// newest touch / interaction time seen (Context.last_touch_ms or a screen-on edge)
    last_touch_ms: u64,
    last_walk_ms: Option<u64>,
    /// last sign of travelling: a walking/running window, the OS reporting a vehicle, or speed above moving_speed_mps
    last_moving_ms: u64,
    stopped_fired_for: Option<u64>,
    stumbles: VecDeque<u64>,
    walk_since_stumble_s: f32,
    /// start of the current "no micro-motion at all" run
    set_down_since: Option<u64>,
    separated_since: Option<u64>,
    separated_fired: bool,
    /// (t_ms, metres from home), last ~2 × heading_home_window_min
    home_hist: VecDeque<(u64, f32)>,
    /// newest fall / drop / hard impact / grab (screams count within scream_after_s of it)
    last_fall_or_grab_ms: Option<u64>,
    /// newest moment a listening-trigger incident was active
    last_listen_ms: Option<u64>,
}

fn json_num(x: f32) -> String {
    if x.is_finite() { format!("{x:.3}") } else { "null".into() }
}

impl Engine {
    pub fn new(config_toml: &str, baseline_blob: Option<&[u8]>, now_ms: u64) -> Result<Engine, EngineError> {
        let cfg = Config::from_toml(config_toml)?;
        let mut baseline = match baseline_blob {
            Some(b) if !b.is_empty() => Baseline::from_bytes(b)?,
            _ => Baseline::new(),
        };
        let log_state = std::mem::take(&mut baseline.log);
        let stumble = StumbleRule { interval_dev: cfg.incidents.stumble_interval_dev, lateral_g: cfg.incidents.stumble_lateral_g };
        Ok(Engine {
            gait: GaitAnalyzer::with_stumbles(&cfg.gait, stumble),
            impact: ImpactDetector::new(&cfg.impact),
            grab: GrabDetector::new(&cfg.grab),
            onset_impact: None,
            pending_drop: None,
            unsteady: DriftTracker::new(),
            slowed: DriftTracker::new(),
            spikes: SpikeTracker::new(cfg.signals.spike_hold_s),
            voter: PlacementVoter::new(),
            baseline,
            esc: Escalation::new(&cfg.thresholds, now_ms ^ 0x5afe),
            log: IncidentLog::new(&cfg.sequence, &cfg.log, &cfg.incidents, log_state, now_ms),
            audio: AudioWindow::new(),
            cfg,
            ctx: Context::default(),
            night_mode: false,
            learning: true,
            pending: Vec::new(),
            placement: Placement::Unknown,
            last_features: None,
            last_impact: None,
            last_gravity: None,
            events: Vec::new(),
            bands: Bands::default(),
            now_ms,
            sampling_full_desired: None,
            listening: None,
            last_incident_ms: None,
            session_incident: false,
            fall: None,
            last_touch_ms: 0,
            last_walk_ms: None,
            last_moving_ms: now_ms,
            stopped_fired_for: None,
            stumbles: VecDeque::new(),
            walk_since_stumble_s: 0.0,
            set_down_since: None,
            separated_since: None,
            separated_fired: false,
            home_hist: VecDeque::new(),
            last_fall_or_grab_ms: None,
            last_listen_ms: None,
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
            self.last_touch_ms = self.last_touch_ms.max(ctx.t_ms);
        }
        if ctx.last_touch_ms > self.last_touch_ms {
            self.last_touch_ms = ctx.last_touch_ms;
        }
        if ctx.t_ms > 0 {
            self.baseline.prune(&self.cfg.baseline, local_day(ctx.t_ms, ctx.hour_local));
        }
        if ctx.activity == Activity::Vehicle || ctx.speed_mps > self.cfg.incidents.moving_speed_mps {
            self.last_moving_ms = self.last_moving_ms.max(ctx.t_ms);
        }
        if ctx.distance_home_m >= 0.0 {
            self.home_hist.push_back((ctx.t_ms, ctx.distance_home_m));
            let keep = (self.cfg.incidents.heading_home_window_min.max(self.cfg.incidents.separated_min) * 60_000.0) as u64 * 2;
            while self.home_hist.front().map(|(t, _)| ctx.t_ms.saturating_sub(*t) > keep).unwrap_or(false) {
                self.home_hist.pop_front();
            }
        }
        if ctx.separated {
            if self.separated_since.is_none() {
                self.separated_since = Some(ctx.t_ms);
                self.separated_fired = false;
            }
        } else {
            self.separated_since = None;
            self.separated_fired = false;
        }
        self.ctx = ctx;
    }

    /// One ~1 s microphone frame (labels + level). Ignored while the listening window is closed.
    pub fn push_audio(&mut self, s: AudioScores) {
        if self.listening == Some(true) {
            self.audio.push(s);
        }
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
                let raw = format!(
                    "{{\"z\":{:.3},\"ik_median_ms\":{:.1},\"ik_cv\":{:.3},\"backspace_rate\":{:.3},\"edit_ratio\":{:.3},\"ms_per_char\":{:.1}}}",
                    verdict.z_score, feats.ik_median_ms, feats.ik_cv, feats.backspace_rate, feats.edit_ratio, feats.ms_per_char
                );
                if self.log.active_of(IncidentKind::TypingOff).is_none() {
                    let summary = format!("Check-in typing far off baseline (z {:.1})", verdict.z_score);
                    self.open(IncidentKind::TypingOff, now_ms, summary, verdict.z_score, raw);
                }
                let summary = self.summary();
                let ev = self.esc.typing_impaired(&summary);
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
        if fx.dismissed {
            // "I'm fine": what is active now no longer asks; the episode closes; answered check-in clears its kinds
            for k in [IncidentKind::CheckInMissed, IncidentKind::TypingOff, IncidentKind::SnoringWhileDown] {
                self.clear_kind(k, now_ms);
            }
            self.log.acknowledge_active();
            self.log.end_episode();
            if let Some(f) = self.fall.as_mut() {
                // answered after a fall: responsive, so this fall can no longer become "down after fall"
                f.alive_ms = f.alive_ms.max(now_ms);
                f.down_logged = true;
            }
        }
        if fx.snatch_cleared {
            self.grab.reset();
            self.clear_kind(IncidentKind::Grab, now_ms);
        }
        if fx.help {
            self.log.start_episode(now_ms);
        }
    }

    pub fn set_night_mode(&mut self, active: bool, now_ms: u64) {
        if active == self.night_mode {
            return;
        }
        if !active {
            // home (or the night is over): nothing that was going on is active any more
            for rec in self.log.clear_all(now_ms) {
                self.events.push(EngineEvent::IncidentCleared { record: rec });
            }
            self.log.end_episode();
            // a night that produced an incident is not representative: drop its walking
            if self.session_incident {
                self.baseline.discard_session();
            } else {
                self.baseline.commit_session(&self.cfg.baseline);
            }
        }
        self.session_incident = false;
        self.night_mode = active;
        self.esc.reset();
        self.grab.reset();
        self.unsteady.reset();
        self.slowed.reset();
        self.spikes.reset();
        self.audio.clear();
        self.onset_impact = None;
        self.pending_drop = None;
        self.fall = None;
        self.stumbles.clear();
        self.walk_since_stumble_s = 0.0;
        self.set_down_since = None;
        self.separated_fired = false;
        self.stopped_fired_for = None;
        self.last_moving_ms = now_ms;
        self.last_fall_or_grab_ms = None;
        self.last_listen_ms = None;
        if active {
            self.events.push(EngineEvent::LocationIntervalChanged { seconds: self.esc.location_interval_s() });
        }
    }

    /// User reset: empty the incident log and put sensing back to its resting state — every rule clock restarts, the
    /// mic window closes, incident-driven full sampling ends, any check-in / alert in progress ends. Baselines stay.
    pub fn reset_incidents(&mut self, now_ms: u64) {
        if !matches!(self.esc.level(), EscalationLevel::Idle | EscalationLevel::Resolved) {
            self.events.push(EngineEvent::Resolved);
        }
        self.esc.reset();
        self.log.reset();
        self.grab.reset();
        self.unsteady.reset();
        self.slowed.reset();
        self.audio.clear();
        self.onset_impact = None;
        self.pending_drop = None;
        self.fall = None;
        self.stumbles.clear();
        self.walk_since_stumble_s = 0.0;
        self.set_down_since = None;
        self.separated_since = if self.ctx.separated { Some(now_ms) } else { None };
        self.separated_fired = false;
        self.stopped_fired_for = None;
        self.last_moving_ms = now_ms;
        self.last_fall_or_grab_ms = None;
        self.last_listen_ms = None;
        self.last_incident_ms = None;
        self.events.push(EngineEvent::IncidentLogCleared);
        self.update_sampling(now_ms);
        self.update_listening(now_ms);
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
            self.last_gravity = Some([s.gx, s.gy, s.gz]);
            if let Some(ev) = self.impact.push(&s) {
                self.on_impact(ev);
            }
            if let Some((t, g)) = self.impact.take_onset() {
                self.on_impact_onset(t, g);
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
            self.check_falls(now_ms);
            self.check_set_down(now_ms);
            self.check_location(now_ms);
            self.check_device(now_ms);
            self.check_audio(now_ms);
        }
        self.log.maintain(now_ms);
        if self.night_mode {
            let ic = &self.cfg.incidents;
            let trigger = self.cfg.thresholds.auto_escalate
                && (self.log.check_trigger(self.cfg.thresholds.check_min_families)
                    || self.log.check_trigger_alone(&ic.check_alone_kinds(), (ic.check_alone_after_s * 1000.0) as u64, now_ms));
            let summary = self.summary();
            let (ev, fx) = self.esc.update(now_ms, trigger, &summary);
            if fx.episode_started {
                self.log.start_episode(now_ms);
            }
            self.events.extend(ev);
            if fx.check_missed {
                let raw = format!("{{\"deadline_s\":{}}}", self.cfg.thresholds.check_deadline_s);
                self.open(IncidentKind::CheckInMissed, now_ms, "\"You okay?\" check-in not answered".into(), 0.0, raw);
            }
            if self.cfg.thresholds.auto_escalate && self.cfg.thresholds.unlock_on_danger && self.log.unacked_danger() {
                let summary = self.summary();
                let (ev, started) = self.esc.unlock_now(now_ms, &summary);
                if started {
                    self.log.start_episode(now_ms);
                }
                self.events.extend(ev);
            }
            if fx.resolved {
                // the evidence cleared on its own: the unanswered check-in is no longer news
                self.clear_kind(IncidentKind::CheckInMissed, now_ms);
                self.log.end_episode();
            }
        }
        self.update_sampling(now_ms);
        self.update_listening(now_ms);
        std::mem::take(&mut self.events)
    }

    // ---- incident bookkeeping ----

    /// Log an incident and emit `SignalIncident`. Returns its id.
    fn open(&mut self, kind: IncidentKind, t_ms: u64, summary: String, sd_distance: f32, raw_json: String) -> u32 {
        let rec = IncidentRecord {
            id: 0,
            t_ms,
            kind,
            tier: kind.tier(),
            summary,
            sd_distance,
            placement: self.placement,
            raw_json,
            cleared_ms: 0,
            acknowledged: false,
            sequence_id: 0,
            watched: false,
        };
        let rec = self.log.push(rec);
        self.last_incident_ms = Some(self.last_incident_ms.map_or(t_ms, |l| l.max(t_ms)));
        if rec.tier > IncidentTier::Context {
            self.session_incident = true;
        }
        let id = rec.id;
        self.events.push(EngineEvent::SignalIncident { record: rec });
        id
    }

    /// Clear every active incident of a kind (emits `IncidentCleared`).
    fn clear_kind(&mut self, kind: IncidentKind, t_ms: u64) {
        let ids: Vec<u32> = self.log.active().filter(|r| r.kind == kind).map(|r| r.id).collect();
        for id in ids {
            if let Some(rec) = self.log.clear(id, t_ms) {
                self.events.push(EngineEvent::IncidentCleared { record: rec });
            }
        }
    }

    fn active(&self, kind: IncidentKind) -> bool {
        self.log.active_of(kind).is_some()
    }

    /// The episode's one-liner, or the active incidents when no episode is open.
    fn summary(&self) -> String {
        if self.log.episode_open() {
            if let Some(s) = self.log.sequence_summary() {
                return s;
            }
        }
        self.log.active_summary()
    }

    /// Phone in hand: touched within `in_hand_touch_s`, or screen on in a held orientation.
    fn in_hand(&self, t_ms: u64) -> bool {
        let touched = self.ctx.last_touch_ms > 0
            && t_ms.saturating_sub(self.ctx.last_touch_ms) <= (self.cfg.grab.in_hand_touch_s * 1000.0) as u64;
        touched || (self.ctx.screen_on && self.placement == Placement::Hand)
    }

    fn night_window(&self) -> bool {
        let sc = &self.cfg.sampling;
        let h = self.ctx.hour_local;
        h >= sc.full_hour_start || h < sc.full_hour_end
    }

    fn away_late(&self) -> bool {
        self.ctx.away_from_home && self.night_window()
    }

    // ---- motion ----

    /// High-g onset: warn at once with a HardImpact; `on_impact` settles it ~`impact_window + post_window` later.
    fn on_impact_onset(&mut self, t_ms: u64, g: f32) {
        if !self.night_mode {
            return;
        }
        self.last_fall_or_grab_ms = Some(t_ms);
        let raw = format!("{{\"onset_g\":{g:.3}}}");
        let id = self.open(IncidentKind::HardImpact, t_ms, format!("High-g impact ({g:.1} g)"), 0.0, raw);
        self.onset_impact = Some(id);
    }

    fn clear_id(&mut self, id: u32, t_ms: u64) {
        if let Some(rec) = self.log.clear(id, t_ms) {
            self.events.push(EngineEvent::IncidentCleared { record: rec });
        }
    }

    /// The impact is classified: a fall replaces the onset warning with PossibleFall, a hard knock with a tilt keeps it
    /// as the HardImpact, a drop or a peak without a tilt clears it.
    fn on_impact(&mut self, ev: ImpactEvent) {
        self.last_impact = Some(ev);
        if !self.night_mode {
            return;
        }
        let onset = self.onset_impact.take();
        if ev.kind == ImpactKind::Drop {
            // logged only if nobody picks the phone up within drop_pickup_s (see check_falls)
            self.pending_drop = Some(ev);
            self.last_fall_or_grab_ms = Some(ev.t_ms);
            if let Some(id) = onset {
                self.clear_id(id, ev.t_ms);
            }
            return;
        }
        if !ev.is_incident(&self.cfg.impact) {
            if let Some(id) = onset {
                self.clear_id(id, ev.t_ms); // a peak without a tilt (jump, slap, dancing)
            }
            return;
        }
        self.last_fall_or_grab_ms = Some(ev.t_ms);
        if ev.kind == ImpactKind::Fall {
            let answered = onset.and_then(|id| self.log.get(id)).map(|r| r.acknowledged).unwrap_or(false);
            if let Some(id) = onset {
                self.clear_id(id, ev.t_ms); // superseded by the PossibleFall
            }
            if let Some(id) = self.log_impact(ev) {
                if answered {
                    // "I'm fine" came between the high-g warning and the classification: the fall is answered too
                    self.log.acknowledge(id);
                    if let Some(f) = self.fall.as_mut() {
                        f.down_logged = true;
                    }
                }
            }
        } else {
            if onset.is_none() {
                self.log_impact(ev); // classified without an onset (should not happen; keep the incident anyway)
            }
            // a hard knock with a tilt that then lies still is treated like a fall: same down-after-fall clock
            self.watch_fall(ev.t_ms);
        }
    }

    /// PossibleFall (fall pattern) or HardImpact (anything else above the impact threshold with an orientation change).
    fn log_impact(&mut self, ev: ImpactEvent) -> Option<u32> {
        let raw = format!(
            "{{\"peak_g\":{:.3},\"free_fall_ms\":{},\"orientation_change_deg\":{:.1},\"post_motion_rms\":{:.4},\"fall_likelihood\":{:.2}}}",
            ev.peak_g, ev.free_fall_ms, ev.orientation_change_deg, ev.post_motion_rms, ev.fall_likelihood
        );
        let sd = self.bands.get("peak_g").map(|b| (ev.peak_g - b.mean) / b.sd.max(1e-6)).unwrap_or(0.0);
        if ev.kind == ImpactKind::Fall {
            let summary = format!("Possible fall ({:.1} g, turned {:.0}°)", ev.peak_g, ev.orientation_change_deg);
            let id = self.open(IncidentKind::PossibleFall, ev.t_ms, summary, sd, raw);
            self.watch_fall(ev.t_ms);
            Some(id)
        } else {
            let summary = format!("Hard impact ({:.1} g, turned {:.0}°)", ev.peak_g, ev.orientation_change_deg);
            Some(self.open(IncidentKind::HardImpact, ev.t_ms, summary, sd, raw))
        }
    }

    /// Start the "down after fall" clock for an impact (possible fall or hard impact).
    fn watch_fall(&mut self, t_ms: u64) {
        let end_ms = t_ms + self.cfg.impact.impact_window_ms + self.cfg.impact.post_window_ms;
        self.fall = Some(FallWatch { t_ms, end_ms, alive_ms: 0, down_logged: false, snore_logged: false });
    }

    fn on_features(&mut self, f: GaitFeatures) {
        self.last_features = Some(f);
        self.placement = self.voter.push(infer_placement(&f, self.ctx.screen_on));
        let g = self.cfg.gait.clone();
        let ic = self.cfg.incidents.clone();
        // micro-motion: anything above the set-down floor means the phone is on a body (or moving)
        if f.energy_rms >= ic.set_down_rms_g {
            self.set_down_since = None;
        } else if self.set_down_since.is_none() {
            self.set_down_since = Some(f.t_ms.saturating_sub((g.window_s * 1000.0) as u64));
        }
        self.bands = Bands::compute(&self.baseline, &self.cfg.baseline, &self.cfg.signals, self.placement, &f);
        let k = if self.bands.trusted { self.cfg.signals.band_sd } else { self.cfg.signals.band_sd_untrusted };
        self.grab.set_bands(self.bands.upper("jerk", k), self.bands.upper("rotation", k));
        if f.is_walking || f.is_running {
            self.last_walk_ms = Some(f.t_ms);
            self.last_moving_ms = self.last_moving_ms.max(f.t_ms);
            if self.night_mode {
                self.on_steps(f.t_ms);
            }
        }
        if f.full && f.is_walking {
            if self.learning && self.ctx.activity == Activity::Walking && self.placement != Placement::Unknown {
                let day = local_day(f.t_ms, self.ctx.hour_local);
                self.baseline.learn(&self.cfg.baseline, self.placement, &f, g.hop_s, day, self.night_mode);
            }
            // the OS activity gates gait incidents: sporadic periodic windows while dancing / riding are not walking
            let os_walking = !matches!(self.ctx.activity, Activity::Stationary | Activity::Vehicle);
            if os_walking && self.night_mode {
                self.gait_incidents(&f);
            }
        }
        if f.full {
            if let Some(gr) = self.grab.update(f.t_ms, f.is_running, self.ctx.speed_mps, self.ctx.separated) {
                if self.night_mode {
                    let summary = format!(
                        "Phone grabbed: jerk {:.0} g/s, rotation {:.0}°/s, then {}",
                        gr.jerk_g_per_s,
                        gr.rotation_dps,
                        if gr.running { "running".to_string() } else { format!("moving at {:.1} m/s", gr.speed_mps.max(0.0)) }
                    );
                    let raw = format!(
                        "{{\"jerk_g_per_s\":{:.1},\"rotation_dps\":{:.1},\"speed_mps\":{:.2},\"running\":{}}}",
                        gr.jerk_g_per_s, gr.rotation_dps, gr.speed_mps, gr.running
                    );
                    let sd = self.bands.get("jerk").map(|b| (gr.jerk_g_per_s - b.mean) / b.sd.max(1e-6)).unwrap_or(0.0);
                    // the wrench out of the hand is not a fall: clear impact warnings from the arm window
                    let since = gr.t_ms.saturating_sub(self.cfg.grab.arm_window_s as u64 * 1000);
                    let wrench: Vec<u32> = self
                        .log
                        .active()
                        .filter(|r| matches!(r.kind, IncidentKind::HardImpact | IncidentKind::PossibleFall) && r.t_ms >= since)
                        .map(|r| r.id)
                        .collect();
                    for id in wrench {
                        self.clear_id(id, gr.t_ms);
                    }
                    if self.fall.map(|f| f.t_ms >= since).unwrap_or(false) {
                        self.fall = None;
                    }
                    self.onset_impact = None;
                    self.last_fall_or_grab_ms = Some(gr.t_ms);
                    if self.cfg.thresholds.auto_escalate {
                        self.log.start_episode(gr.t_ms);
                    }
                    self.open(IncidentKind::Grab, gr.t_ms, summary.clone(), sd, raw);
                    if self.cfg.thresholds.auto_escalate {
                        let seq = self.log.sequence_summary().unwrap_or_else(|| summary.clone());
                        let ev = self.esc.grab(gr.t_ms, seq);
                        self.events.extend(ev);
                    }
                }
            }
        }
    }

    /// Steps resumed (a walking or running window that starts after the impact settled): falls recover, a hard
    /// impact clears.
    fn on_steps(&mut self, t_ms: u64) {
        let settle = self.cfg.impact.impact_window_ms + self.cfg.impact.post_window_ms + (self.cfg.gait.window_s * 1000.0) as u64;
        if let Some(fw) = self.fall {
            if t_ms > fw.t_ms + settle {
                let down = self.log.active_of(IncidentKind::DownAfterFall).is_some();
                let since = (t_ms - fw.t_ms) as f32 / 1000.0;
                let raw = format!("{{\"since_fall_s\":{since:.0},\"was_down\":{down}}}");
                self.open(IncidentKind::FallRecovered, t_ms, format!("Up and walking {since:.0} s after the fall"), 0.0, raw);
                for k in [IncidentKind::PossibleFall, IncidentKind::DownAfterFall, IncidentKind::SnoringWhileDown] {
                    self.clear_kind(k, t_ms);
                }
                self.fall = None;
            }
        }
        if self.log.active_of(IncidentKind::HardImpact).map(|r| t_ms > r.t_ms + settle).unwrap_or(false) {
            self.clear_kind(IncidentKind::HardImpact, t_ms);
        }
    }

    /// Unsteady gait, slowed walk, stumbles (night mode, full rate, walking).
    fn gait_incidents(&mut self, f: &GaitFeatures) {
        let ic = self.cfg.incidents.clone();
        let hop = self.cfg.gait.hop_s;
        // unsteady: stride variability / regularity / sway / wobble out of band
        let rule = DriftRule { persist_s: ic.unsteady_persist_s, clear_s: ic.unsteady_clear_s, gap_s: ic.drift_gap_s };
        let (oob, worst) = self.bands.unsteady_out();
        match self.unsteady.push_walking(&rule, hop, f.t_ms, &oob, worst) {
            DriftStep::Open => {
                let names = self.unsteady.metrics.join(", ");
                let summary = format!("Unsteady walking: {names} out of band ({:+.1} SD) for {:.0} s", self.unsteady.worst_sd, self.unsteady.persist_s(hop));
                let raw = self.bands.raw_json();
                self.open(IncidentKind::UnsteadyGait, f.t_ms, summary, self.unsteady.worst_sd, raw);
            }
            DriftStep::Clear => self.clear_kind(IncidentKind::UnsteadyGait, f.t_ms),
            DriftStep::None => {}
        }
        // slowed: cadence well below the baseline mean
        let rule = DriftRule { persist_s: ic.slowed_persist_s, clear_s: ic.slowed_clear_s, gap_s: ic.drift_gap_s };
        let (slow, sd) = match self.bands.get("cadence") {
            Some(b) => (f.cadence_spm < b.mean * (1.0 - ic.slowed_cadence_frac), b.sd_distance),
            None => (false, 0.0),
        };
        let oob: &[&str] = if slow { &["cadence"] } else { &[] };
        match self.slowed.push_walking(&rule, hop, f.t_ms, oob, sd) {
            DriftStep::Open => {
                let mean = self.bands.get("cadence").map(|b| b.mean).unwrap_or(0.0);
                let summary = format!("Slow walking: {:.0} steps/min vs usual {:.0} for {:.0} s", f.cadence_spm, mean, self.slowed.persist_s(hop));
                let raw = format!("{{\"cadence\":{:.1},\"baseline_mean\":{:.1}}}", f.cadence_spm, mean);
                self.open(IncidentKind::SlowedWalk, f.t_ms, summary, sd, raw);
            }
            DriftStep::Clear => self.clear_kind(IncidentKind::SlowedWalk, f.t_ms),
            DriftStep::None => {}
        }
        // stumbles (single ones stop being logged while repeated stumbling is already active)
        if let Some(st) = f.stumble.filter(|_| !self.active(IncidentKind::RepeatedStumbles)) {
            let raw = format!("{{\"interval_dev\":{:.2},\"lateral_g\":{:.2}}}", st.interval_dev, st.lateral_g);
            let summary = format!("Stumble: step {:.0}% off rhythm, {:.1} g sideways", st.interval_dev * 100.0, st.lateral_g);
            self.open(IncidentKind::Stumble, st.t_ms, summary, 0.0, raw);
            self.walk_since_stumble_s = 0.0;
            let window = (ic.repeated_stumbles_window_min * 60_000.0) as u64;
            self.stumbles.push_back(st.t_ms);
            while self.stumbles.front().map(|t| st.t_ms.saturating_sub(*t) > window).unwrap_or(false) {
                self.stumbles.pop_front();
            }
            if self.stumbles.len() as u32 >= ic.repeated_stumbles_n && !self.active(IncidentKind::RepeatedStumbles) {
                let n = self.stumbles.len();
                let summary = format!("Repeated stumbling: {n} stumbles in {:.0} min", ic.repeated_stumbles_window_min);
                self.open(IncidentKind::RepeatedStumbles, st.t_ms, summary, 0.0, format!("{{\"stumbles\":{n}}}"));
            }
        } else {
            self.walk_since_stumble_s += hop;
            if self.walk_since_stumble_s >= ic.repeated_stumbles_clear_min * 60.0 {
                self.clear_kind(IncidentKind::RepeatedStumbles, f.t_ms);
            }
        }
    }

    // ---- per-tick rules (night mode) ----

    fn touched_since(&self, t_ms: u64) -> bool {
        self.last_touch_ms > t_ms
    }

    /// Phone drop (not picked up), down after fall, snoring while down.
    fn check_falls(&mut self, now_ms: u64) {
        let ic = self.cfg.incidents.clone();
        if let Some(d) = self.pending_drop {
            if !self.impact.drop_active || self.touched_since(d.t_ms) {
                self.pending_drop = None; // picked up in time: not an incident
            } else if now_ms.saturating_sub(d.t_ms) as f32 >= ic.drop_pickup_s * 1000.0 {
                self.pending_drop = None;
                let raw = format!("{{\"peak_g\":{:.3},\"free_fall_ms\":{},\"not_picked_up_s\":{:.0}}}", d.peak_g, d.free_fall_ms, ic.drop_pickup_s);
                let summary = format!("Phone dropped ({:.1} g) and not picked up for {:.0} s", d.peak_g, ic.drop_pickup_s);
                self.open(IncidentKind::PhoneDrop, d.t_ms, summary, 0.0, raw);
            }
        }
        if let Some(r) = self.log.active_of(IncidentKind::PhoneDrop) {
            let t = r.t_ms;
            if !self.impact.drop_active || self.touched_since(t) {
                self.clear_kind(IncidentKind::PhoneDrop, now_ms);
            }
        }
        let Some(mut fw) = self.fall else { return };
        if now_ms < fw.end_ms {
            return;
        }
        if self.touched_since(fw.t_ms) {
            fw.alive_ms = fw.alive_ms.max(self.last_touch_ms);
        }
        let down_ms = now_ms.saturating_sub(fw.end_ms.max(fw.alive_ms));
        if !fw.down_logged && down_ms as f32 >= ic.down_after_fall_s * 1000.0 {
            fw.down_logged = true;
            let down_s = down_ms as f32 / 1000.0;
            let raw = format!("{{\"down_s\":{:.0},\"since_fall_s\":{:.0}}}", down_s, now_ms.saturating_sub(fw.t_ms) as f32 / 1000.0);
            let summary = format!("Down after the fall: no steps, no touch for {}", crate::log::duration(down_s));
            self.open(IncidentKind::DownAfterFall, now_ms, summary, 0.0, raw);
        }
        if fw.down_logged && !fw.snore_logged && self.active(IncidentKind::DownAfterFall) && self.active(IncidentKind::CheckInMissed) {
            let since = now_ms.saturating_sub((ic.snore_window_s * 1000.0) as u64);
            let n = self.audio.count(since, |a| a.snore >= ic.snore_min);
            if n as u32 >= ic.snore_frames {
                fw.snore_logged = true;
                let peak = self.audio.peak(since, |a| a.snore);
                let raw = format!("{{\"frames\":{n},\"peak\":{}}}", json_num(peak));
                self.open(IncidentKind::SnoringWhileDown, now_ms, "Snoring sounds while down after a fall, check-in unanswered".into(), 0.0, raw);
            }
        }
        self.fall = Some(fw);
    }

    /// Phone set down (context) and left behind (incident).
    fn check_set_down(&mut self, now_ms: u64) {
        let ic = self.cfg.incidents.clone();
        if let Some(since) = self.set_down_since {
            if self.touched_since(since) {
                self.set_down_since = None;
            }
        }
        let set_down_ms = self.set_down_since.map(|s| now_ms.saturating_sub(s)).unwrap_or(0);
        if self.set_down_since.is_none() {
            self.clear_kind(IncidentKind::PhoneLeftBehind, now_ms);
            return;
        }
        if set_down_ms as f32 >= ic.left_behind_min * 60_000.0 && self.away_late() && !self.active(IncidentKind::PhoneLeftBehind) {
            let s = set_down_ms as f32 / 1000.0;
            let raw = format!("{{\"set_down_s\":{s:.0}}}");
            let summary = format!("Phone left behind: set down, untouched for {} min while out late", (s / 60.0).floor() as u32);
            self.open(IncidentKind::PhoneLeftBehind, now_ms, summary, 0.0, raw);
        }
    }

    fn phone_set_down(&self) -> bool {
        self.set_down_since.map(|s| self.now_ms.saturating_sub(s) as f32 >= self.cfg.incidents.set_down_s * 1000.0).unwrap_or(false)
    }

    /// Distance home at (or just before) `t_ms`.
    fn home_at(&self, t_ms: u64) -> Option<f32> {
        self.home_hist.iter().rev().find(|(t, _)| *t <= t_ms).or_else(|| self.home_hist.front()).map(|(_, d)| *d)
    }

    /// Separated from the group, stopped on the way home, in a vehicle.
    fn check_location(&mut self, now_ms: u64) {
        let ic = self.cfg.incidents.clone();
        // separated
        if !self.ctx.separated {
            self.clear_kind(IncidentKind::Separated, now_ms);
        } else if let Some(since) = self.separated_since {
            let dur_s = now_ms.saturating_sub(since) as f32 / 1000.0;
            if !self.separated_fired && dur_s >= ic.separated_min * 60.0 {
                let start = self.home_at(since).unwrap_or(-1.0);
                let cur = self.ctx.distance_home_m;
                let heading_home = start >= 0.0 && cur >= 0.0 && start - cur > ic.separated_home_margin_m;
                if !heading_home {
                    self.separated_fired = true;
                    let raw = format!("{{\"separated_s\":{dur_s:.0},\"distance_home_m\":{cur:.0},\"distance_home_start_m\":{start:.0}}}");
                    let summary = format!("Separated from the group for {} min, not heading home", (dur_s / 60.0).floor() as u32);
                    self.open(IncidentKind::Separated, now_ms, summary, 0.0, raw);
                }
            }
        }
        // stopped on the way home
        let stopped_ms = now_ms.saturating_sub(self.last_moving_ms);
        if let Some(r) = self.log.active_of(IncidentKind::StoppedOnWayHome) {
            if self.last_moving_ms > r.t_ms || !self.ctx.away_from_home {
                self.clear_kind(IncidentKind::StoppedOnWayHome, now_ms);
            }
        } else if self.ctx.away_from_home
            && stopped_ms as f32 >= ic.stopped_min * 60_000.0
            && self.stopped_fired_for != Some(self.last_moving_ms)
        {
            let stop = self.last_moving_ms;
            let before = self.home_at(stop.saturating_sub((ic.heading_home_window_min * 60_000.0) as u64));
            let at_stop = self.home_at(stop);
            if let (Some(b), Some(a)) = (before, at_stop) {
                if b - a >= ic.heading_home_margin_m {
                    self.stopped_fired_for = Some(stop);
                    let s = stopped_ms as f32 / 1000.0;
                    let raw = format!("{{\"stopped_s\":{s:.0},\"distance_home_m\":{a:.0},\"approached_m\":{:.0}}}", b - a);
                    let summary = format!("Stopped on the way home for {} min, {:.0} m from home", (s / 60.0).floor() as u32, a);
                    self.open(IncidentKind::StoppedOnWayHome, now_ms, summary, 0.0, raw);
                }
            }
        }
        // in a vehicle (context)
        if self.ctx.activity == Activity::Vehicle {
            if !self.active(IncidentKind::InVehicle) {
                self.open(IncidentKind::InVehicle, now_ms, "Got into a vehicle".into(), 0.0, "{}".into());
            }
        } else {
            self.clear_kind(IncidentKind::InVehicle, now_ms);
        }
    }

    /// Battery critical while away late (context; native uploads the latest location on BatteryDying).
    fn check_device(&mut self, now_ms: u64) {
        let ic = &self.cfg.incidents;
        let pct = self.ctx.battery_pct;
        if self.active(IncidentKind::BatteryCritical) {
            if self.ctx.charging || pct >= ic.battery_clear_pct {
                self.clear_kind(IncidentKind::BatteryCritical, now_ms);
            }
        } else if pct <= ic.battery_critical_pct && !self.ctx.charging && self.away_late() {
            let raw = format!("{{\"battery_pct\":{pct}}}");
            self.open(IncidentKind::BatteryCritical, now_ms, format!("Battery at {pct}% while out late"), 0.0, raw);
            self.events.push(EngineEvent::BatteryDying);
        }
    }

    /// Screaming / shouting soon after a fall or grab (not in a loud venue); clears after scream_clear_min.
    fn check_audio(&mut self, now_ms: u64) {
        let ic = self.cfg.incidents.clone();
        if let Some(r) = self.log.active_of(IncidentKind::ScreamShout) {
            if now_ms.saturating_sub(r.t_ms) as f32 >= ic.scream_clear_min * 60_000.0 {
                self.clear_kind(IncidentKind::ScreamShout, now_ms);
            }
            return;
        }
        let (Some(anchor), Some(newest)) = (self.last_fall_or_grab_ms, self.audio.newest_ms()) else { return };
        if newest < anchor || (newest - anchor) as f32 > ic.scream_after_s * 1000.0 {
            return;
        }
        let since = newest.saturating_sub((ic.scream_window_s * 1000.0) as u64).max(anchor);
        let loud = |a: &AudioScores| a.scream.max(a.shout) >= ic.scream_min;
        let n = self.audio.count(since, loud);
        if (n as u32) < ic.scream_frames || self.audio.loud(ic.loud_venue_frames as usize, ic.loud_venue_db) {
            return;
        }
        let peak = self.audio.peak(since, |a| a.scream.max(a.shout));
        let level = self.audio.median_level(ic.loud_venue_frames as usize).unwrap_or(f32::NAN);
        let raw = format!("{{\"frames\":{n},\"peak\":{},\"level_db\":{},\"after_s\":{:.0}}}", json_num(peak), json_num(level), (newest - anchor) as f32 / 1000.0);
        let summary = format!("Screaming or shouting {:.0} s after a fall or grab", (newest - anchor) as f32 / 1000.0);
        self.open(IncidentKind::ScreamShout, newest, summary, 0.0, raw);
        self.audio.clear(); // one incident per burst
    }

    // ---- sensing control ----

    /// Engine-decided sensor mode; emits `SamplingRateChanged` on change and once at the first tick.
    fn update_sampling(&mut self, now_ms: u64) {
        let sc = &self.cfg.sampling;
        let recent_incident = self.last_incident_ms.map(|t| now_ms.saturating_sub(t) as f32 <= sc.after_incident_min * 60_000.0).unwrap_or(false);
        let learn_walk = sc.learn_walks_full_rate
            && self.learning
            && !self.night_mode
            && self.ctx.activity == Activity::Walking
            && !self.baseline.any_trusted(&self.cfg.baseline);
        let want_full = self.away_late() || self.log.watching() || recent_incident || learn_walk;
        if self.sampling_full_desired != Some(want_full) {
            self.sampling_full_desired = Some(want_full);
            let (hz, gyro) = if want_full { (sc.full_hz, true) } else { (sc.low_hz, false) };
            self.events.push(EngineEvent::SamplingRateChanged { hz, gyro });
        }
    }

    /// Microphone listening window (night mode): `listen_hold_min` after a fall / drop / grab / missed check-in /
    /// unsteady gait incident opened, and for as long as an escalation runs (+ the same hold). A long-lasting incident
    /// does not keep the mic on by itself. Emits `AudioListening` on change.
    fn update_listening(&mut self, now_ms: u64) {
        let newest_trigger = self.log.records().iter().filter(|r| r.kind.opens_listening() && !r.acknowledged).map(|r| r.t_ms).max();
        let escalating = !matches!(self.esc.level(), EscalationLevel::Idle | EscalationLevel::Resolved);
        let mark = if escalating && self.night_mode { Some(now_ms) } else { newest_trigger.filter(|_| self.night_mode) };
        if let Some(t) = mark {
            self.last_listen_ms = Some(self.last_listen_ms.map_or(t, |l| l.max(t)));
        }
        let hold = (self.cfg.incidents.listen_hold_min * 60_000.0) as u64;
        let want = self.night_mode && self.last_listen_ms.map(|t| now_ms.saturating_sub(t) <= hold).unwrap_or(false);
        if self.listening != Some(want) {
            if self.listening.is_some() || want {
                self.events.push(EngineEvent::AudioListening { on: want });
            }
            self.listening = Some(want);
            if !want {
                self.audio.clear();
            }
        }
    }

    // ---- read side ----

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            escalation: self.esc.level(),
            // the open escalation episode's one-liner (what friends would see); empty otherwise
            evidence: if self.log.episode_open() { self.log.sequence_summary().unwrap_or_default() } else { String::new() },
            sensing_full: self.sampling_full_desired.unwrap_or(false),
            listening: self.listening.unwrap_or(false),
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

    /// Context conditions that hold right now (shown with the metrics; never logged as incidents).
    fn context_flags(&self) -> Vec<String> {
        let mut c = Vec::new();
        if self.away_late() {
            c.push("away from home late".to_string());
        }
        if self.ctx.activity == Activity::Vehicle {
            c.push("in a vehicle".into());
        }
        if self.phone_set_down() {
            c.push("phone set down".into());
        }
        let ic = &self.cfg.incidents;
        if self.listening == Some(true) && self.audio.loud(ic.loud_venue_frames as usize, ic.loud_venue_db) {
            c.push("loud venue".into());
        }
        c
    }

    /// Live metrics vs. bands, the risk band, active incidents, context and baseline trust (dashboard).
    ///
    /// Never more than one tick stale: the gait metrics (cadence, stride_cv, regularity, sway, wobble)
    /// are the latest 1 s-hop window with their instantaneous band status (persistence only gates the
    /// gait *incidents*; a building run is spelled out in `evidence`), and the spike metrics (jerk,
    /// rotation, peak_g) are a peak-hold over the last `signals.spike_hold_s` seconds of per-tick blocks
    /// with the band evaluated against the held peak. In low-rate mode the gait and gyro bands are
    /// unavailable (value 0, in band, baseline mean/sd) and `evidence` says so.
    pub fn metrics(&self) -> LiveMetrics {
        let now = self.now_ms;
        let full = self.ctx.sampling_full;
        let bcfg = &self.cfg.baseline;
        let scfg = &self.cfg.signals;
        let ic = &self.cfg.incidents;
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
            }
        }
        let mut evidence = String::new();
        let mut note = |s: String| {
            if !evidence.is_empty() {
                evidence.push_str("; ");
            }
            evidence.push_str(&s);
        };
        if full {
            if !walking {
                note("not walking: gait bands idle".to_string());
            }
            let rule = DriftRule { persist_s: ic.unsteady_persist_s, clear_s: ic.unsteady_clear_s, gap_s: ic.drift_gap_s };
            if !self.unsteady.active {
                if let Some((names, persist)) = self.unsteady.building(&rule, self.cfg.gait.hop_s, now) {
                    if !names.is_empty() {
                        note(format!("{} out of band for {:.0} s", names.join(", "), persist));
                    }
                }
            }
        } else {
            note("low-rate sampling: gait metrics paused".to_string());
        }
        LiveMetrics {
            t_ms: now,
            placement: self.placement,
            sampling_full: full,
            activity: act,
            bands,
            listening: self.listening.unwrap_or(false),
            context: self.context_flags(),
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
    pub fn check_deadline_ms(&self) -> Option<u64> {
        self.esc.check_deadline()
    }
    pub fn sequence_summary(&self) -> Option<String> {
        self.log.sequence_summary()
    }
    pub fn sampling_full_desired(&self) -> Option<bool> {
        self.sampling_full_desired
    }
    pub fn listening(&self) -> bool {
        self.listening.unwrap_or(false)
    }
    /// Active incidents right now (not cleared).
    pub fn active_incidents(&self) -> Vec<IncidentRecord> {
        self.log.active().cloned().collect()
    }
    pub fn baseline(&self) -> &Baseline {
        &self.baseline
    }
}
