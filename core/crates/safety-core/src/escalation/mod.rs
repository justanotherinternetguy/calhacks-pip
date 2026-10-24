//! Escalation state machine. Driven by the incident log, not by a probability:
//! Check ("You okay?") when the check-in trigger holds (a Danger incident, or Watch incidents from two independent
//! families) → HeadsUp to friends (no location) once the check deadline passes with the trigger still holding →
//! UnlockLocation after `unlock_no_response_s` (since the check) if it still holds → CallOptionAvailable after
//! `call_option_s`. If the trigger stops holding (got up and walked, back with the group) the episode resolves.
//! Grab: HeadsUp (+ SnatchDetected) immediately, UnlockLocation after `grab_unlock_s` unless the owner unlocks the
//! phone (PhoneUnlocked / BiometricDismiss). NeedHelp / ManualSos unlock immediately.
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

/// What the engine must do after `update`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TickEffect {
    /// a check-in was just requested: the recent incidents join a new episode
    pub episode_started: bool,
    /// the check deadline passed unanswered: log CheckInMissed
    pub check_missed: bool,
    /// the episode resolved on its own
    pub resolved: bool,
}

/// Side effects the engine must apply after an action.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ActionEffect {
    /// the user (or a friend) said they are fine: acknowledge the active incidents, close the episode
    pub dismissed: bool,
    /// the owner has the phone again: the grab is over
    pub snatch_cleared: bool,
    /// the user asked for help (NeedHelp / ManualSos): start an episode
    pub help: bool,
}

pub struct Escalation {
    cfg: ThresholdCfg,
    level: EscalationLevel,
    check_deadline: Option<u64>,
    /// start of the current alert episode (check requested / grab / help) for the no-response timers
    episode_start: Option<u64>,
    /// the grab path: Unlocked follows after grab_unlock_s
    grab_at: Option<u64>,
    call_option_fired: bool,
    last_check_ms: Option<u64>,
    loc_interval: u32,
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
            last_check_ms: None,
            loc_interval: cfg.location_upload_s,
            rng: StdRng::seed_from_u64(seed),
            phrase: String::new(),
            summary: String::new(),
        }
    }
    pub fn level(&self) -> EscalationLevel {
        self.level
    }
    pub fn phrase(&self) -> &str {
        &self.phrase
    }
    pub fn check_deadline(&self) -> Option<u64> {
        self.check_deadline
    }
    pub fn location_interval_s(&self) -> u32 {
        self.loc_interval
    }
    /// Friends have been told (heads-up, unlock or snatch).
    pub fn alerted(&self) -> bool {
        matches!(self.level, EscalationLevel::HeadsUp | EscalationLevel::Unlocked | EscalationLevel::Snatch)
    }
    pub fn reset(&mut self) {
        self.set_level(EscalationLevel::Idle);
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

    /// Called every tick. `trigger` = the incident log asks for a check-in right now; `summary` = the episode's
    /// one-liner (or the active incidents).
    pub fn update(&mut self, now_ms: u64, trigger: bool, summary: &str) -> (Vec<EngineEvent>, TickEffect) {
        let mut ev = Vec::new();
        let mut fx = TickEffect::default();
        match self.level {
            EscalationLevel::Resolved => self.set_level(EscalationLevel::Idle),
            EscalationLevel::Idle => {
                let gap_ok = self
                    .last_check_ms
                    .map(|t| now_ms.saturating_sub(t) >= self.cfg.check_repeat_cooldown_s as u64 * 1000)
                    .unwrap_or(true);
                if trigger && gap_ok {
                    self.phrase = self.new_phrase();
                    let deadline = now_ms + self.cfg.check_deadline_s as u64 * 1000;
                    self.set_level(EscalationLevel::Check);
                    self.check_deadline = Some(deadline);
                    self.last_check_ms = Some(now_ms);
                    self.episode_start = Some(now_ms);
                    fx.episode_started = true;
                    ev.push(EngineEvent::CheckRequested { phrase: self.phrase.clone(), deadline_ms: deadline, summary: summary.to_string() });
                }
            }
            EscalationLevel::Check => {
                // the user always gets the full check-in window before friends are involved
                if self.check_deadline.map(|d| now_ms >= d).unwrap_or(false) {
                    if trigger {
                        self.set_level(EscalationLevel::HeadsUp);
                        self.summary = summary.to_string();
                        fx.check_missed = true;
                        ev.push(EngineEvent::HeadsUp { summary: format!("no answer to a check-in; {}", self.summary) });
                    } else {
                        self.set_level(EscalationLevel::Resolved);
                        fx.resolved = true;
                        ev.push(EngineEvent::Resolved);
                    }
                }
            }
            EscalationLevel::HeadsUp => {
                if !trigger {
                    // the evidence cleared on its own (walking again, back with the group)
                    self.set_level(EscalationLevel::Resolved);
                    fx.resolved = true;
                    ev.push(EngineEvent::Resolved);
                } else if self.since_episode(now_ms).unwrap_or(0) >= self.cfg.unlock_no_response_s as u64 * 1000 {
                    self.set_level(EscalationLevel::Unlocked);
                    if !summary.is_empty() {
                        self.summary = summary.to_string();
                    }
                    ev.push(EngineEvent::UnlockLocation { summary: self.summary.clone() });
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
        if self.alerted() && !self.call_option_fired {
            if let Some(w) = self.since_episode(now_ms) {
                if w >= self.cfg.call_option_s as u64 * 1000 {
                    self.call_option_fired = true;
                    let s = if self.summary.is_empty() { summary.to_string() } else { self.summary.clone() };
                    ev.push(EngineEvent::CallOptionAvailable { summary: format!("no response for {} min; {s}", w / 60_000) });
                }
            }
        }
        ev.extend(self.sync_interval());
        (ev, fx)
    }

    /// Location upload interval: `location_upload_alert_s` once friends were alerted, `location_upload_s` otherwise.
    /// `unlock_on_danger`: straight to Unlocked (friends get the location now) from Idle / Check / HeadsUp.
    /// Returns the events and whether this started the episode.
    pub fn unlock_now(&mut self, now_ms: u64, summary: &str) -> (Vec<EngineEvent>, bool) {
        if !matches!(self.level, EscalationLevel::Idle | EscalationLevel::Check | EscalationLevel::HeadsUp) {
            return (Vec::new(), false);
        }
        let started = self.episode_start.is_none();
        self.set_level(EscalationLevel::Unlocked);
        if started {
            self.episode_start = Some(now_ms);
        }
        self.summary = summary.to_string();
        let mut ev = vec![EngineEvent::UnlockLocation { summary: summary.to_string() }];
        ev.extend(self.sync_interval());
        (ev, started)
    }

    fn sync_interval(&mut self) -> Vec<EngineEvent> {
        let iv = if self.alerted() { self.cfg.location_upload_alert_s } else { self.cfg.location_upload_s };
        if iv == self.loc_interval {
            return Vec::new();
        }
        self.loc_interval = iv;
        vec![EngineEvent::LocationIntervalChanged { seconds: iv }]
    }

    /// Typing far off baseline during a Check: friends get the heads-up now instead of at the deadline.
    pub fn typing_impaired(&mut self, summary: &str) -> Vec<EngineEvent> {
        if self.level == EscalationLevel::Check {
            self.set_level(EscalationLevel::HeadsUp);
            self.summary = summary.to_string();
            let mut ev = vec![EngineEvent::HeadsUp { summary: format!("check-in typing far off baseline; {summary}") }];
            ev.extend(self.sync_interval());
            return ev;
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
        ev.extend(self.sync_interval());
        ev
    }

    pub fn apply_action(&mut self, a: UserAction, now_ms: u64) -> (Vec<EngineEvent>, ActionEffect) {
        let mut ev = Vec::new();
        let mut fx = ActionEffect::default();
        let dismiss = |s: &mut Self, ev: &mut Vec<EngineEvent>, fx: &mut ActionEffect| {
            fx.dismissed = true;
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
            // a typo: the check stays open until its deadline, the user can try again
            UserAction::DismissWrongPhrase => {}
            UserAction::NeedHelp | UserAction::ManualSos => {
                if self.level != EscalationLevel::Unlocked {
                    self.set_level(EscalationLevel::Unlocked);
                    if self.episode_start.is_none() {
                        self.episode_start = Some(now_ms);
                    }
                    let summary = if a == UserAction::ManualSos { "manual SOS" } else { "user asked for help" };
                    self.summary = summary.into();
                    fx.help = true;
                    ev.push(EngineEvent::UnlockLocation { summary: summary.into() });
                    ev.extend(self.sync_interval());
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

    fn has<F: Fn(&EngineEvent) -> bool>(ev: &[EngineEvent], f: F) -> bool {
        ev.iter().any(f)
    }

    #[test]
    fn check_headsup_unlock_follow_the_trigger() {
        let cfg = Config::default_v1().thresholds;
        let mut e = Escalation::new(&cfg, 7);
        let (ev, _) = e.update(0, false, "");
        assert!(!has(&ev, |e| matches!(e, EngineEvent::CheckRequested { .. })));
        let (ev, fx) = e.update(1000, true, "");
        assert!(fx.episode_started);
        assert!(matches!(ev[0], EngineEvent::CheckRequested { deadline_ms: 121_000, .. }));
        if let EngineEvent::CheckRequested { phrase, .. } = &ev[0] {
            assert_eq!(phrase.split(' ').count(), 3);
        }
        assert!(e.update(60_000, true, "").0.is_empty());
        let (ev, fx) = e.update(121_000, true, "A fall, then down for 2 min");
        assert!(fx.check_missed);
        assert!(matches!(&ev[0], EngineEvent::HeadsUp { summary } if summary.ends_with("down for 2 min")));
        assert_eq!(e.location_interval_s(), 60, "faster location once friends are alerted");
        // unlock 240 s after the check while the trigger still holds
        assert!(!has(&e.update(240_000, true, "").0, |e| matches!(e, EngineEvent::UnlockLocation { .. })));
        let (ev, _) = e.update(241_000, true, "A fall, then down for 2 min");
        assert!(matches!(&ev[0], EngineEvent::UnlockLocation { summary } if summary.starts_with("A fall")));
        // call option once at 600 s
        assert!(!has(&e.update(600_000, true, "").0, |e| matches!(e, EngineEvent::CallOptionAvailable { .. })));
        let (ev, _) = e.update(601_000, true, "");
        assert!(matches!(ev[0], EngineEvent::CallOptionAvailable { .. }), "{ev:?}");
        assert!(!has(&e.update(700_000, true, "").0, |e| matches!(e, EngineEvent::CallOptionAvailable { .. })));
        let (ev, fx) = e.apply_action(UserAction::DismissOk, 730_000);
        assert!(fx.dismissed && ev.contains(&EngineEvent::Resolved));
        e.update(731_000, false, "");
        assert_eq!(e.level(), EscalationLevel::Idle);
    }

    #[test]
    fn trigger_clearing_resolves_and_check_waits_its_deadline() {
        let cfg = Config::default_v1().thresholds;
        let mut e = Escalation::new(&cfg, 7);
        e.update(0, true, "");
        // trigger gone before the deadline: still no heads-up, resolved at the deadline
        assert!(e.update(10_000, false, "").0.is_empty());
        let (ev, fx) = e.update(120_000, false, "");
        assert!(fx.resolved && ev.contains(&EngineEvent::Resolved));
        // no new check inside the repeat cooldown
        e.update(121_000, false, "");
        assert!(!has(&e.update(200_000, true, "").0, |e| matches!(e, EngineEvent::CheckRequested { .. })));
        assert!(has(&e.update(300_000, true, "").0, |e| matches!(e, EngineEvent::CheckRequested { .. })));
        // heads-up, then the trigger clears: resolved without unlock
        e.update(420_000, true, "x");
        assert_eq!(e.level(), EscalationLevel::HeadsUp);
        let (ev, fx) = e.update(430_000, false, "");
        assert!(fx.resolved && ev.contains(&EngineEvent::Resolved));
    }

    #[test]
    fn grab_heads_up_then_unlock_unless_owner_unlocks() {
        let cfg = Config::default_v1().thresholds;
        let mut e = Escalation::new(&cfg, 1);
        let ev = e.grab(10_000, "jerk".into());
        assert!(matches!(ev[0], EngineEvent::SnatchDetected { .. }));
        assert!(matches!(ev[1], EngineEvent::HeadsUp { .. }));
        assert!(!has(&ev, |e| matches!(e, EngineEvent::UnlockLocation { .. })));
        e.apply_action(UserAction::DismissOk, 11_000);
        assert_eq!(e.level(), EscalationLevel::Snatch);
        assert!(!has(&e.update(129_000, false, "").0, |e| matches!(e, EngineEvent::UnlockLocation { .. })));
        let (ev, _) = e.update(130_000, false, "");
        assert!(matches!(ev[0], EngineEvent::UnlockLocation { .. }), "{ev:?}");
        assert_eq!(e.level(), EscalationLevel::Unlocked);

        let mut e = Escalation::new(&cfg, 1);
        e.grab(10_000, "jerk".into());
        let (_, fx) = e.apply_action(UserAction::PhoneUnlocked, 60_000);
        assert!(fx.snatch_cleared);
        assert_eq!(e.level(), EscalationLevel::Resolved);
        assert!(!has(&e.update(130_000, false, "").0, |e| matches!(e, EngineEvent::UnlockLocation { .. })));

        let mut e = Escalation::new(&cfg, 1);
        e.grab(10_000, "jerk".into());
        let (_, fx) = e.apply_action(UserAction::BiometricDismiss, 20_000);
        assert!(fx.snatch_cleared);
        assert_eq!(e.level(), EscalationLevel::Resolved);
    }

    #[test]
    fn need_help_skips_to_unlock() {
        let cfg = Config::default_v1().thresholds;
        let mut e = Escalation::new(&cfg, 1);
        let (ev, fx) = e.apply_action(UserAction::NeedHelp, 0);
        assert!(fx.help);
        assert!(matches!(ev[0], EngineEvent::UnlockLocation { .. }));
        assert_eq!(e.location_interval_s(), 60);
    }
}
