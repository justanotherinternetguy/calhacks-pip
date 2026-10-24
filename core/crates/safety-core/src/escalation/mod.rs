//! Escalation state machine with hysteresis, cooldowns and timers (PLAN §4, timings per spec v1.1):
//! Check (P ≥ t_check) → HeadsUp once the check deadline passes → UnlockLocation after
//! `unlock_no_response_s` with P ≥ t_unlock → CallOptionAvailable after `call_option_s`.
//! Grab: HeadsUp (+ SnatchDetected) immediately, UnlockLocation after `grab_unlock_s` unless the owner
//! unlocks the phone (PhoneUnlocked / BiometricDismiss).
use crate::config::ThresholdCfg;
use crate::types::{EngineEvent, EscalationLevel, UserAction};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

const WORDS: &[&str] = &[
    "blue", "river", "stone", "lamp", "green", "door", "cloud", "tiger", "apple", "candle", "maple", "silver", "window",
    "ocean", "pencil", "garden", "rocket", "violet", "copper", "forest", "piano", "summer", "bridge", "cotton", "falcon",
    "honey", "island", "jacket", "kettle", "lemon", "mirror", "needle", "orange", "paper", "quiet", "ribbon", "saddle",
    "tunnel", "umbrella", "velvet", "walnut", "yellow", "zebra", "anchor", "basket",
];

/// Side effects the engine must apply after an action.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ActionEffect {
    pub reset_posterior: bool,
    pub wrong_phrase: bool,
    pub snatch_cleared: bool,
}

pub struct Escalation {
    cfg: ThresholdCfg,
    level: EscalationLevel,
    check_deadline: Option<u64>,
    /// start of the current alert episode (check requested / grab) for the no-response timers
    episode_start: Option<u64>,
    /// the grab path: Unlocked follows after grab_unlock_s
    grab_at: Option<u64>,
    call_option_fired: bool,
    cooldown_until: u64,
    last_check_ms: Option<u64>,
    risk_band: u8,
    loc_interval: u32,
    battery_fired: bool,
    rng: StdRng,
    phrase: String,
    summary: String,
}

impl Escalation {
    pub fn new(cfg: &ThresholdCfg, seed: u64) -> Self {
        Escalation {
            cfg: cfg.clone(),
            level: EscalationLevel::Idle,
            check_deadline: None,
            episode_start: None,
            grab_at: None,
            call_option_fired: false,
            cooldown_until: 0,
            last_check_ms: None,
            risk_band: 0,
            loc_interval: cfg.location_interval_s[0],
            battery_fired: false,
            rng: StdRng::seed_from_u64(seed),
            phrase: String::new(),
            summary: String::new(),
        }
    }
    pub fn level(&self) -> EscalationLevel {
        self.level
    }
    pub fn risk_band(&self) -> u8 {
        self.risk_band
    }
    pub fn phrase(&self) -> &str {
        &self.phrase
    }
    pub fn in_cooldown(&self, now_ms: u64) -> bool {
        now_ms < self.cooldown_until
    }
    pub fn location_interval_s(&self) -> u32 {
        self.loc_interval
    }
    pub fn reset(&mut self) {
        self.level = EscalationLevel::Idle;
        self.check_deadline = None;
        self.episode_start = None;
        self.grab_at = None;
        self.call_option_fired = false;
    }

    fn boost(&self, now_ms: u64) -> f32 {
        if self.in_cooldown(now_ms) { self.cfg.cooldown_threshold_boost } else { 0.0 }
    }
    fn new_phrase(&mut self) -> String {
        let mut w = Vec::new();
        while w.len() < 3 {
            let c = WORDS[self.rng.gen_range(0..WORDS.len())];
            if !w.contains(&c) {
                w.push(c);
            }
        }
        w.join(" ")
    }

    fn set_level(&mut self, l: EscalationLevel) {
        self.level = l;
        if l != EscalationLevel::Check {
            self.check_deadline = None;
        }
        if matches!(l, EscalationLevel::Idle | EscalationLevel::Resolved) {
            self.episode_start = None;
            self.grab_at = None;
            self.call_option_fired = false;
        }
    }

    fn since_episode(&self, now_ms: u64) -> Option<u64> {
        self.episode_start.map(|s| now_ms.saturating_sub(s))
    }

    /// Called every tick with the current posterior danger, the HMM evidence string and the one-line
    /// summary (sequence summary when the incident log has one, otherwise the evidence).
    pub fn update(&mut self, now_ms: u64, p: f32, evidence: &str, summary: &str) -> Vec<EngineEvent> {
        let mut ev = Vec::new();
        let b = self.boost(now_ms);
        let (t_check, t_heads, t_unlock) =
            (self.cfg.t_check + b, self.cfg.t_heads_up + b, (self.cfg.t_unlock + b).min(0.999));
        let summary_or = |s: &str| if summary.is_empty() { s.to_string() } else { summary.to_string() };
        match self.level {
            EscalationLevel::Resolved => self.set_level(EscalationLevel::Idle),
            EscalationLevel::Idle => {
                let gap_ok = self
                    .last_check_ms
                    .map(|t| now_ms.saturating_sub(t) >= self.cfg.check_repeat_cooldown_s as u64 * 1000)
                    .unwrap_or(true);
                if p >= t_check && gap_ok {
                    self.phrase = self.new_phrase();
                    let deadline = now_ms + self.cfg.check_deadline_s as u64 * 1000;
                    self.check_deadline = Some(deadline);
                    self.last_check_ms = Some(now_ms);
                    self.set_level(EscalationLevel::Check);
                    self.episode_start = Some(now_ms);
                    self.call_option_fired = false;
                    ev.push(EngineEvent::CheckRequested { phrase: self.phrase.clone(), deadline_ms: deadline });
                }
            }
            EscalationLevel::Check => {
                // the user always gets the full check-in window before friends are involved
                if self.check_deadline.map(|d| now_ms >= d).unwrap_or(false) {
                    if p >= t_heads {
                        self.set_level(EscalationLevel::HeadsUp);
                        self.summary = summary_or(evidence);
                        ev.push(EngineEvent::HeadsUp { summary: format!("no response to check-in; {}", self.summary) });
                    } else {
                        self.set_level(EscalationLevel::Resolved);
                        ev.push(EngineEvent::Resolved);
                    }
                }
            }
            EscalationLevel::HeadsUp => {
                let waited = self.since_episode(now_ms).unwrap_or(0);
                if p >= t_unlock && waited >= self.cfg.unlock_no_response_s as u64 * 1000 {
                    self.set_level(EscalationLevel::Unlocked);
                    self.summary = summary_or(evidence);
                    ev.push(EngineEvent::UnlockLocation { summary: self.summary.clone() });
                } else if p < 0.2 {
                    // posterior recovered on its own (walking resumed etc.)
                    self.set_level(EscalationLevel::Resolved);
                    ev.push(EngineEvent::Resolved);
                }
            }
            EscalationLevel::Snatch => {
                if let Some(g) = self.grab_at {
                    if now_ms.saturating_sub(g) >= self.cfg.grab_unlock_s as u64 * 1000 {
                        self.set_level(EscalationLevel::Unlocked);
                        self.grab_at = Some(g);
                        ev.push(EngineEvent::UnlockLocation { summary: self.summary.clone() });
                    }
                }
            }
            EscalationLevel::Unlocked => {}
        }
        if matches!(self.level, EscalationLevel::HeadsUp | EscalationLevel::Unlocked | EscalationLevel::Snatch)
            && !self.call_option_fired
        {
            if let Some(w) = self.since_episode(now_ms) {
                if w >= self.cfg.call_option_s as u64 * 1000 {
                    self.call_option_fired = true;
                    let s = if self.summary.is_empty() { summary_or(evidence) } else { self.summary.clone() };
                    ev.push(EngineEvent::CallOptionAvailable { summary: format!("no response for {} min; {s}", w / 60_000) });
                }
            }
        }
        ev.extend(self.update_band(p));
        ev
    }

    fn update_band(&mut self, p: f32) -> Vec<EngineEvent> {
        let e = self.cfg.risk_band_edges;
        let h = self.cfg.risk_band_hysteresis;
        let raw = if p >= e[2] { 3 } else if p >= e[1] { 2 } else if p >= e[0] { 1 } else { 0 };
        let mut band = raw;
        if raw < self.risk_band {
            // only step down once clear of the edge by the hysteresis margin
            let edge = e[(self.risk_band - 1) as usize];
            if p > edge - h {
                band = self.risk_band;
            }
        }
        if matches!(self.level, EscalationLevel::Unlocked | EscalationLevel::Snatch) {
            band = 3;
        }
        let mut ev = Vec::new();
        if band != self.risk_band {
            self.risk_band = band;
            ev.push(EngineEvent::RiskBandChanged { band });
            let iv = self.cfg.location_interval_s[band as usize];
            if iv != self.loc_interval {
                self.loc_interval = iv;
                ev.push(EngineEvent::LocationIntervalChanged { seconds: iv });
            }
        }
        ev
    }

    /// Typing far off baseline during a Check counts as evidence; with P ≥ T_heads_up it escalates.
    pub fn typing_impaired(&mut self, now_ms: u64, p: f32, evidence: &str) -> Vec<EngineEvent> {
        if self.level == EscalationLevel::Check && p >= self.cfg.t_heads_up + self.boost(now_ms) {
            self.set_level(EscalationLevel::HeadsUp);
            self.summary = evidence.to_string();
            return vec![EngineEvent::HeadsUp { summary: format!("check-in typing far off baseline; {evidence}") }];
        }
        Vec::new()
    }

    /// Grab detected: HeadsUp (no location) + SnatchDetected immediately; UnlockLocation follows after
    /// `grab_unlock_s` unless PhoneUnlocked / BiometricDismiss.
    pub fn grab(&mut self, now_ms: u64, summary: String) -> Vec<EngineEvent> {
        if matches!(self.level, EscalationLevel::Snatch | EscalationLevel::Unlocked) {
            return Vec::new();
        }
        self.set_level(EscalationLevel::Snatch);
        self.episode_start = Some(now_ms);
        self.grab_at = Some(now_ms);
        self.call_option_fired = false;
        self.summary = summary.clone();
        let mut ev = vec![EngineEvent::SnatchDetected { summary: summary.clone() }, EngineEvent::HeadsUp { summary }];
        ev.extend(self.update_band(1.0));
        ev
    }

    pub fn battery(&mut self, pct: u8) -> Vec<EngineEvent> {
        if pct <= self.cfg.battery_dying_pct && !self.battery_fired {
            self.battery_fired = true;
            return vec![EngineEvent::BatteryDying];
        }
        if pct > self.cfg.battery_dying_pct + 7 {
            self.battery_fired = false;
        }
        Vec::new()
    }

    pub fn apply_action(&mut self, a: UserAction, now_ms: u64) -> (Vec<EngineEvent>, ActionEffect) {
        let mut ev = Vec::new();
        let mut fx = ActionEffect::default();
        let dismiss = |s: &mut Self, ev: &mut Vec<EngineEvent>, fx: &mut ActionEffect| {
            s.cooldown_until = now_ms + s.cfg.dismiss_cooldown_s as u64 * 1000;
            fx.reset_posterior = true;
            if s.level != EscalationLevel::Idle {
                s.set_level(EscalationLevel::Resolved);
                ev.push(EngineEvent::Resolved);
            }
        };
        let grab_pending = self.grab_at.is_some();
        match a {
            UserAction::DismissOk => {
                if self.level != EscalationLevel::Snatch {
                    dismiss(self, &mut ev, &mut fx);
                }
            }
            UserAction::DismissWrongPhrase => fx.wrong_phrase = true,
            UserAction::NeedHelp | UserAction::ManualSos => {
                if self.level != EscalationLevel::Unlocked {
                    self.set_level(EscalationLevel::Unlocked);
                    let summary = if a == UserAction::ManualSos { "manual SOS" } else { "user asked for help" };
                    self.summary = summary.into();
                    ev.push(EngineEvent::UnlockLocation { summary: summary.into() });
                    ev.extend(self.update_band(1.0));
                }
            }
            UserAction::BiometricDismiss => {
                if self.level == EscalationLevel::Snatch || grab_pending {
                    fx.snatch_cleared = true;
                }
                dismiss(self, &mut ev, &mut fx);
            }
            UserAction::PhoneUnlocked => {
                // the owner has the phone: a pending grab (HeadsUp sent, unlock not yet) is cleared
                if self.level == EscalationLevel::Snatch {
                    fx.snatch_cleared = true;
                    dismiss(self, &mut ev, &mut fx);
                }
            }
            UserAction::FriendMarkedSafe => {
                if matches!(self.level, EscalationLevel::HeadsUp | EscalationLevel::Unlocked) {
                    dismiss(self, &mut ev, &mut fx);
                }
            }
            UserAction::CheckTimeout => {
                if self.level == EscalationLevel::Check {
                    self.check_deadline = Some(now_ms);
                }
            }
        }
        (ev, fx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn check_timeout_headsup_unlock_and_dismiss_cooldown() {
        let cfg = Config::default_v1().thresholds;
        let mut e = Escalation::new(&cfg, 7);
        assert!(e.update(0, 0.65, "x", "").iter().all(|e| !matches!(e, EngineEvent::CheckRequested { .. })), "below t_check = 0.7");
        let ev = e.update(0, 0.75, "x", "");
        assert!(matches!(ev[0], EngineEvent::CheckRequested { deadline_ms: 90_000, .. }));
        if let EngineEvent::CheckRequested { phrase, .. } = &ev[0] {
            assert_eq!(phrase.split(' ').count(), 3);
        }
        assert!(e.update(60_000, 0.75, "x", "").is_empty());
        let ev = e.update(90_000, 0.75, "x", "");
        assert!(matches!(ev[0], EngineEvent::HeadsUp { .. }));
        // P high but no response for less than 120 s: no unlock yet
        assert!(e.update(100_000, 0.96, "fall", "").iter().all(|e| !matches!(e, EngineEvent::UnlockLocation { .. })));
        let ev = e.update(120_000, 0.96, "fall", "Fall, then no movement for 2 min");
        assert!(matches!(&ev[0], EngineEvent::UnlockLocation { summary } if summary.starts_with("Fall")));
        assert_eq!(e.risk_band(), 3);
        // call option once at 600 s
        assert!(e.update(599_000, 0.96, "fall", "").iter().all(|e| !matches!(e, EngineEvent::CallOptionAvailable { .. })));
        let ev = e.update(600_000, 0.96, "fall", "");
        assert!(matches!(ev[0], EngineEvent::CallOptionAvailable { .. }), "{ev:?}");
        assert!(e.update(700_000, 0.96, "fall", "").iter().all(|e| !matches!(e, EngineEvent::CallOptionAvailable { .. })));
        // dismiss resets, and cooldown raises the bar for 30 min
        let (ev, fx) = e.apply_action(UserAction::DismissOk, 730_000);
        assert!(fx.reset_posterior && ev.contains(&EngineEvent::Resolved));
        e.update(731_000, 0.1, "", "");
        assert_eq!(e.level(), EscalationLevel::Idle);
        assert!(e.update(740_000, 0.8, "x", "").iter().all(|e| !matches!(e, EngineEvent::CheckRequested { .. })));
        let ev = e.update(730_000 + 1_800_001 + 300_000, 0.8, "x", "");
        assert!(ev.iter().any(|e| matches!(e, EngineEvent::CheckRequested { .. })));
    }

    #[test]
    fn grab_heads_up_then_unlock_unless_owner_unlocks() {
        let cfg = Config::default_v1().thresholds;
        let mut e = Escalation::new(&cfg, 1);
        let ev = e.grab(10_000, "jerk".into());
        assert!(matches!(ev[0], EngineEvent::SnatchDetected { .. }));
        assert!(matches!(ev[1], EngineEvent::HeadsUp { .. }));
        assert!(!ev.iter().any(|e| matches!(e, EngineEvent::UnlockLocation { .. })));
        e.apply_action(UserAction::DismissOk, 11_000);
        assert_eq!(e.level(), EscalationLevel::Snatch);
        assert!(e.update(129_000, 0.3, "", "").iter().all(|e| !matches!(e, EngineEvent::UnlockLocation { .. })));
        let ev = e.update(130_000, 0.3, "", "");
        assert!(matches!(ev[0], EngineEvent::UnlockLocation { .. }), "{ev:?}");
        assert_eq!(e.level(), EscalationLevel::Unlocked);

        let mut e = Escalation::new(&cfg, 1);
        e.grab(10_000, "jerk".into());
        let (_, fx) = e.apply_action(UserAction::PhoneUnlocked, 60_000);
        assert!(fx.snatch_cleared);
        assert_eq!(e.level(), EscalationLevel::Resolved);
        assert!(e.update(130_000, 0.3, "", "").iter().all(|e| !matches!(e, EngineEvent::UnlockLocation { .. })));

        let mut e = Escalation::new(&cfg, 1);
        e.grab(10_000, "jerk".into());
        let (_, fx) = e.apply_action(UserAction::BiometricDismiss, 20_000);
        assert!(fx.snatch_cleared);
        assert_eq!(e.level(), EscalationLevel::Resolved);
    }

    #[test]
    fn need_help_skips_to_unlock_and_battery_fires_once() {
        let cfg = Config::default_v1().thresholds;
        let mut e = Escalation::new(&cfg, 1);
        let (ev, _) = e.apply_action(UserAction::NeedHelp, 0);
        assert!(matches!(ev[0], EngineEvent::UnlockLocation { .. }));
        assert_eq!(e.battery(3), vec![EngineEvent::BatteryDying]);
        assert!(e.battery(2).is_empty());
    }
}
