//! uniffi mirror of `safety_core::Engine` (docs/CONTRACTS.md §1 + §6). Thin: conversions + a Mutex.
use std::sync::{Arc, Mutex};

#[derive(uniffi::Record, Clone, Debug)]
pub struct MotionSample { pub t_ms: u64, pub ax: f32, pub ay: f32, pub az: f32, pub gx: f32, pub gy: f32, pub gz: f32, pub rx: f32, pub ry: f32, pub rz: f32 }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity { Unknown, Stationary, Walking, Running, Vehicle }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placement { Unknown, Pocket, Hand, Bag }
#[derive(uniffi::Record, Clone, Debug)]
pub struct Context {
    pub t_ms: u64, pub away_from_home: bool, pub separated: bool, pub hour_local: u8, pub screen_on: bool, pub activity: Activity, pub battery_pct: u8, pub speed_mps: f32,
    pub last_touch_ms: u64, pub distance_home_m: f32, pub sampling_full: bool,
}
#[derive(uniffi::Record, Clone, Debug)]
pub struct AudioScores { pub t_ms: u64, pub scream: f32, pub shout: f32, pub glass: f32 }
#[derive(uniffi::Record, Clone, Debug)]
pub struct TypingSample { pub phrase: String, pub typed: String, pub key_times_ms: Vec<u64>, pub backspaces: u32, pub duration_ms: u64 }
#[derive(uniffi::Record, Clone, Debug)]
pub struct TypingVerdict { pub accepted: bool, pub z_score: f32, pub reason: String }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserAction { DismissOk, DismissWrongPhrase, NeedHelp, ManualSos, BiometricDismiss, FriendMarkedSafe, CheckTimeout, PhoneUnlocked }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum HmmState { Normal, Impaired, Incident, Unresponsive }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscalationLevel { Idle, Check, HeadsUp, Unlocked, Snatch, Resolved }
#[derive(uniffi::Record, Clone, Debug)]
pub struct Snapshot { pub p_danger: f32, pub hmm_state: HmmState, pub escalation: EscalationLevel, pub risk_band: u8, pub evidence: String, pub baseline_seconds: u32, pub placement: Placement, pub night_mode: bool }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum IncidentKind { GaitDrift, Impact, Grab, Stillness, Separated, TypingOff }
#[derive(uniffi::Record, Clone, Debug)]
pub struct MetricBand { pub name: String, pub value: f32, pub mean: f32, pub sd: f32, pub sd_distance: f32, pub in_band: bool }
#[derive(uniffi::Record, Clone, Debug)]
pub struct LiveMetrics {
    pub t_ms: u64, pub placement: Placement, pub sampling_full: bool, pub activity: Activity,
    /// cadence, stride_cv, regularity, sway, wobble, jerk, rotation, peak_g
    pub bands: Vec<MetricBand>,
    pub p_normal: f32, pub p_impaired: f32, pub p_incident: f32, pub p_unresponsive: f32,
    pub baseline_trusted: bool, pub baseline_walk_days: f32, pub evidence: String,
}
#[derive(uniffi::Record, Clone, Debug)]
pub struct IncidentRecord {
    pub id: u32, pub t_ms: u64, pub kind: IncidentKind, pub summary: String, pub sd_distance: f32, pub placement: Placement, pub raw_json: String,
    pub p_normal: f32, pub p_impaired: f32, pub p_incident: f32, pub p_unresponsive: f32,
    /// 0 = none
    pub sequence_id: u32, pub watched: bool,
}
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
    SamplingRateChanged { hz: u32, gyro: bool },
    SignalIncident { record: IncidentRecord },
    CallOptionAvailable { summary: String },
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
    fn from(s: MotionSample) -> Self {
        core::MotionSample { t_ms: s.t_ms, ax: s.ax, ay: s.ay, az: s.az, gx: s.gx, gy: s.gy, gz: s.gz, rx: s.rx, ry: s.ry, rz: s.rz }
    }
}
impl From<Activity> for core::Activity {
    fn from(a: Activity) -> Self {
        match a { Activity::Unknown => core::Activity::Unknown, Activity::Stationary => core::Activity::Stationary, Activity::Walking => core::Activity::Walking, Activity::Running => core::Activity::Running, Activity::Vehicle => core::Activity::Vehicle }
    }
}
impl From<core::Activity> for Activity {
    fn from(a: core::Activity) -> Self {
        match a { core::Activity::Unknown => Activity::Unknown, core::Activity::Stationary => Activity::Stationary, core::Activity::Walking => Activity::Walking, core::Activity::Running => Activity::Running, core::Activity::Vehicle => Activity::Vehicle }
    }
}
impl From<core::Placement> for Placement {
    fn from(p: core::Placement) -> Self {
        match p { core::Placement::Unknown => Placement::Unknown, core::Placement::Pocket => Placement::Pocket, core::Placement::Hand => Placement::Hand, core::Placement::Bag => Placement::Bag }
    }
}
impl From<Context> for core::Context {
    fn from(c: Context) -> Self {
        core::Context {
            t_ms: c.t_ms, away_from_home: c.away_from_home, separated: c.separated, hour_local: c.hour_local, screen_on: c.screen_on, activity: c.activity.into(), battery_pct: c.battery_pct, speed_mps: c.speed_mps,
            last_touch_ms: c.last_touch_ms, distance_home_m: c.distance_home_m, sampling_full: c.sampling_full,
        }
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
            UserAction::PhoneUnlocked => core::UserAction::PhoneUnlocked,
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
impl From<core::IncidentKind> for IncidentKind {
    fn from(k: core::IncidentKind) -> Self {
        match k {
            core::IncidentKind::GaitDrift => IncidentKind::GaitDrift,
            core::IncidentKind::Impact => IncidentKind::Impact,
            core::IncidentKind::Grab => IncidentKind::Grab,
            core::IncidentKind::Stillness => IncidentKind::Stillness,
            core::IncidentKind::Separated => IncidentKind::Separated,
            core::IncidentKind::TypingOff => IncidentKind::TypingOff,
        }
    }
}
impl From<core::MetricBand> for MetricBand {
    fn from(b: core::MetricBand) -> Self {
        MetricBand { name: b.name, value: b.value, mean: b.mean, sd: b.sd, sd_distance: b.sd_distance, in_band: b.in_band }
    }
}
impl From<core::LiveMetrics> for LiveMetrics {
    fn from(m: core::LiveMetrics) -> Self {
        LiveMetrics {
            t_ms: m.t_ms, placement: m.placement.into(), sampling_full: m.sampling_full, activity: m.activity.into(),
            bands: m.bands.into_iter().map(Into::into).collect(),
            p_normal: m.p_normal, p_impaired: m.p_impaired, p_incident: m.p_incident, p_unresponsive: m.p_unresponsive,
            baseline_trusted: m.baseline_trusted, baseline_walk_days: m.baseline_walk_days, evidence: m.evidence,
        }
    }
}
impl From<core::IncidentRecord> for IncidentRecord {
    fn from(r: core::IncidentRecord) -> Self {
        IncidentRecord {
            id: r.id, t_ms: r.t_ms, kind: r.kind.into(), summary: r.summary, sd_distance: r.sd_distance, placement: r.placement.into(), raw_json: r.raw_json,
            p_normal: r.p_normal, p_impaired: r.p_impaired, p_incident: r.p_incident, p_unresponsive: r.p_unresponsive,
            sequence_id: r.sequence_id, watched: r.watched,
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
            core::EngineEvent::SamplingRateChanged { hz, gyro } => EngineEvent::SamplingRateChanged { hz, gyro },
            core::EngineEvent::SignalIncident { record } => EngineEvent::SignalIncident { record: record.into() },
            core::EngineEvent::CallOptionAvailable { summary } => EngineEvent::CallOptionAvailable { summary },
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
    /// Live metrics vs. bands, the four state probabilities, baseline trust (dashboard).
    pub fn metrics(&self) -> LiveMetrics {
        self.lock().metrics().into()
    }
    /// Incident log, newest last; entries expire after 8 h.
    pub fn incident_log(&self) -> Vec<IncidentRecord> {
        self.lock().incident_log().into_iter().map(Into::into).collect()
    }
    /// Opaque baseline + incident-log bytes; store encrypted on device.
    pub fn export_baseline(&self) -> Vec<u8> {
        self.lock().export_baseline()
    }
}
