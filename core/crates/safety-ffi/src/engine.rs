//! uniffi mirror of `safety_core::Engine` (docs/CONTRACTS.md §1). Thin: conversions + a Mutex.
use std::sync::{Arc, Mutex};

#[derive(uniffi::Record, Clone, Debug)]
pub struct MotionSample { pub t_ms: u64, pub ax: f32, pub ay: f32, pub az: f32, pub gx: f32, pub gy: f32, pub gz: f32 }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity { Unknown, Stationary, Walking, Running, Vehicle }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement { Unknown, Pocket, Hand, Bag }
#[derive(uniffi::Record, Clone, Debug)]
pub struct Context { pub t_ms: u64, pub away_from_home: bool, pub separated: bool, pub hour_local: u8, pub screen_on: bool, pub activity: Activity, pub battery_pct: u8, pub speed_mps: f32 }
#[derive(uniffi::Record, Clone, Debug)]
pub struct AudioScores { pub t_ms: u64, pub scream: f32, pub shout: f32, pub glass: f32 }
#[derive(uniffi::Record, Clone, Debug)]
pub struct TypingSample { pub phrase: String, pub typed: String, pub key_times_ms: Vec<u64>, pub backspaces: u32, pub duration_ms: u64 }
#[derive(uniffi::Record, Clone, Debug)]
pub struct TypingVerdict { pub accepted: bool, pub z_score: f32, pub reason: String }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserAction { DismissOk, DismissWrongPhrase, NeedHelp, ManualSos, BiometricDismiss, FriendMarkedSafe, CheckTimeout }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum HmmState { Normal, Impaired, Incident, Unresponsive }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscalationLevel { Idle, Check, HeadsUp, Unlocked, Snatch, Resolved }
#[derive(uniffi::Record, Clone, Debug)]
pub struct Snapshot { pub p_danger: f32, pub hmm_state: HmmState, pub escalation: EscalationLevel, pub risk_band: u8, pub evidence: String, pub baseline_seconds: u32, pub placement: Placement, pub night_mode: bool }
#[derive(uniffi::Enum, Clone, Debug)]
pub enum EngineEvent {
    CheckRequested { phrase: String, deadline_ms: u64 },
    HeadsUp { summary: String },
    UnlockLocation { summary: String },
    SnatchDetected { summary: String },
    Resolved,
    RiskBandChanged { band: u8 },
    BatteryDying,
    LocationIntervalChanged { seconds: u32 },
}
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum EngineError {
    #[error("config: {msg}")]
    Config { msg: String },
    #[error("baseline: {msg}")]
    Baseline { msg: String },
}

// ---- conversions ----
use safety_core as core;

impl From<MotionSample> for core::MotionSample {
    fn from(s: MotionSample) -> Self { core::MotionSample { t_ms: s.t_ms, ax: s.ax, ay: s.ay, az: s.az, gx: s.gx, gy: s.gy, gz: s.gz } }
}
impl From<Activity> for core::Activity {
    fn from(a: Activity) -> Self {
        match a { Activity::Unknown => core::Activity::Unknown, Activity::Stationary => core::Activity::Stationary, Activity::Walking => core::Activity::Walking, Activity::Running => core::Activity::Running, Activity::Vehicle => core::Activity::Vehicle }
    }
}
impl From<core::Placement> for Placement {
    fn from(p: core::Placement) -> Self {
        match p { core::Placement::Unknown => Placement::Unknown, core::Placement::Pocket => Placement::Pocket, core::Placement::Hand => Placement::Hand, core::Placement::Bag => Placement::Bag }
    }
}
impl From<Context> for core::Context {
    fn from(c: Context) -> Self {
        core::Context { t_ms: c.t_ms, away_from_home: c.away_from_home, separated: c.separated, hour_local: c.hour_local, screen_on: c.screen_on, activity: c.activity.into(), battery_pct: c.battery_pct, speed_mps: c.speed_mps }
    }
}
impl From<AudioScores> for core::AudioScores {
    fn from(a: AudioScores) -> Self { core::AudioScores { t_ms: a.t_ms, scream: a.scream, shout: a.shout, glass: a.glass } }
}
impl From<TypingSample> for core::TypingSample {
    fn from(s: TypingSample) -> Self { core::TypingSample { phrase: s.phrase, typed: s.typed, key_times_ms: s.key_times_ms, backspaces: s.backspaces, duration_ms: s.duration_ms } }
}
impl From<core::TypingVerdict> for TypingVerdict {
    fn from(v: core::TypingVerdict) -> Self { TypingVerdict { accepted: v.accepted, z_score: v.z_score, reason: v.reason } }
}
impl From<UserAction> for core::UserAction {
    fn from(a: UserAction) -> Self {
        match a {
            UserAction::DismissOk => core::UserAction::DismissOk,
            UserAction::DismissWrongPhrase => core::UserAction::DismissWrongPhrase,
            UserAction::NeedHelp => core::UserAction::NeedHelp,
            UserAction::ManualSos => core::UserAction::ManualSos,
            UserAction::BiometricDismiss => core::UserAction::BiometricDismiss,
            UserAction::FriendMarkedSafe => core::UserAction::FriendMarkedSafe,
            UserAction::CheckTimeout => core::UserAction::CheckTimeout,
        }
    }
}
impl From<core::HmmState> for HmmState {
    fn from(s: core::HmmState) -> Self {
        match s { core::HmmState::Normal => HmmState::Normal, core::HmmState::Impaired => HmmState::Impaired, core::HmmState::Incident => HmmState::Incident, core::HmmState::Unresponsive => HmmState::Unresponsive }
    }
}
impl From<core::EscalationLevel> for EscalationLevel {
    fn from(l: core::EscalationLevel) -> Self {
        match l {
            core::EscalationLevel::Idle => EscalationLevel::Idle,
            core::EscalationLevel::Check => EscalationLevel::Check,
            core::EscalationLevel::HeadsUp => EscalationLevel::HeadsUp,
            core::EscalationLevel::Unlocked => EscalationLevel::Unlocked,
            core::EscalationLevel::Snatch => EscalationLevel::Snatch,
            core::EscalationLevel::Resolved => EscalationLevel::Resolved,
        }
    }
}
impl From<core::Snapshot> for Snapshot {
    fn from(s: core::Snapshot) -> Self {
        Snapshot { p_danger: s.p_danger, hmm_state: s.hmm_state.into(), escalation: s.escalation.into(), risk_band: s.risk_band, evidence: s.evidence, baseline_seconds: s.baseline_seconds, placement: s.placement.into(), night_mode: s.night_mode }
    }
}
impl From<core::EngineEvent> for EngineEvent {
    fn from(e: core::EngineEvent) -> Self {
        match e {
            core::EngineEvent::CheckRequested { phrase, deadline_ms } => EngineEvent::CheckRequested { phrase, deadline_ms },
            core::EngineEvent::HeadsUp { summary } => EngineEvent::HeadsUp { summary },
            core::EngineEvent::UnlockLocation { summary } => EngineEvent::UnlockLocation { summary },
            core::EngineEvent::SnatchDetected { summary } => EngineEvent::SnatchDetected { summary },
            core::EngineEvent::Resolved => EngineEvent::Resolved,
            core::EngineEvent::RiskBandChanged { band } => EngineEvent::RiskBandChanged { band },
            core::EngineEvent::BatteryDying => EngineEvent::BatteryDying,
            core::EngineEvent::LocationIntervalChanged { seconds } => EngineEvent::LocationIntervalChanged { seconds },
        }
    }
}
impl From<core::EngineError> for EngineError {
    fn from(e: core::EngineError) -> Self {
        match e { core::EngineError::Config { msg } => EngineError::Config { msg }, core::EngineError::Baseline { msg } => EngineError::Baseline { msg } }
    }
}

#[derive(uniffi::Object)]
pub struct SafetyEngine {
    inner: Mutex<core::Engine>,
}

impl SafetyEngine {
    fn lock(&self) -> std::sync::MutexGuard<'_, core::Engine> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[uniffi::export]
impl SafetyEngine {
    #[uniffi::constructor]
    pub fn new(config_toml: String, baseline_blob: Option<Vec<u8>>, now_ms: u64) -> Result<Arc<Self>, EngineError> {
        let engine = core::Engine::new(&config_toml, baseline_blob.as_deref(), now_ms)?;
        Ok(Arc::new(SafetyEngine { inner: Mutex::new(engine) }))
    }
    pub fn push_motion(&self, samples: Vec<MotionSample>) {
        self.lock().push_motion(samples.into_iter().map(Into::into).collect());
    }
    pub fn push_context(&self, ctx: Context) {
        self.lock().push_context(ctx.into());
    }
    pub fn push_audio(&self, s: AudioScores) {
        self.lock().push_audio(s.into());
    }
    pub fn push_typing(&self, s: TypingSample, now_ms: u64) -> TypingVerdict {
        self.lock().push_typing(s.into(), now_ms).into()
    }
    pub fn push_action(&self, a: UserAction, now_ms: u64) {
        self.lock().push_action(a.into(), now_ms);
    }
    pub fn set_night_mode(&self, active: bool, now_ms: u64) {
        self.lock().set_night_mode(active, now_ms);
    }
    pub fn set_learning(&self, enabled: bool) {
        self.lock().set_learning(enabled);
    }
    /// Call every ~1 s in night mode; the HMM step runs internally once a minute + on impact.
    pub fn tick(&self, now_ms: u64) -> Vec<EngineEvent> {
        self.lock().tick(now_ms).into_iter().map(Into::into).collect()
    }
    pub fn snapshot(&self) -> Snapshot {
        self.lock().snapshot().into()
    }
    /// Opaque baseline bytes; store encrypted on device.
    pub fn export_baseline(&self) -> Vec<u8> {
        self.lock().export_baseline()
    }
}
