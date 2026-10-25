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
    pub last_touch_ms: u64, pub distance_home_m: f32, pub sampling_full: bool, pub charging: bool,
}
/// One ~1 s microphone frame: YAMNet scores + estimated level (dB SPL) + distress-word confidence (0 when nothing was
/// heard or the spotter is off). Labels only, never audio or words.
#[derive(uniffi::Record, Clone, Debug)]
pub struct AudioScores { pub t_ms: u64, pub scream: f32, pub shout: f32, pub snore: f32, pub level_db: f32, pub distress: f32 }
#[derive(uniffi::Record, Clone, Debug)]
pub struct TypingSample { pub phrase: String, pub typed: String, pub key_times_ms: Vec<u64>, pub backspaces: u32, pub duration_ms: u64 }
#[derive(uniffi::Record, Clone, Debug)]
pub struct TypingVerdict { pub accepted: bool, pub z_score: f32, pub reason: String }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum UserAction { DismissOk, DismissWrongPhrase, NeedHelp, ManualSos, BiometricDismiss, FriendMarkedSafe, CheckTimeout, PhoneUnlocked }
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscalationLevel { Idle, Check, HeadsUp, Unlocked, Snatch, Resolved }
#[derive(uniffi::Record, Clone, Debug)]
pub struct Snapshot {
    pub escalation: EscalationLevel, pub evidence: String, pub sensing_full: bool, pub listening: bool,
    pub baseline_seconds: u32, pub placement: Placement, pub night_mode: bool,
}
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum IncidentKind {
    PhoneDrop, PossibleFall, FallRecovered, DownAfterFall, HardImpact,
    UnsteadyGait, Stumble, RepeatedStumbles, SlowedWalk,
    PhoneLeftBehind, Grab,
    Separated, StoppedOnWayHome, InVehicle,
    BatteryCritical,
    CheckInMissed, TypingOff,
    ScreamShout, SnoringWhileDown, DistressWords,
}
/// Context: logged only · Watch: full sensing, counts toward a check-in · Danger: asks "You okay?" on its own
#[derive(uniffi::Enum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum IncidentTier { Context, Watch, Danger }
#[derive(uniffi::Record, Clone, Debug)]
pub struct MetricBand { pub name: String, pub value: f32, pub mean: f32, pub sd: f32, pub sd_distance: f32, pub in_band: bool }
#[derive(uniffi::Record, Clone, Debug)]
pub struct LiveMetrics {
    pub t_ms: u64, pub placement: Placement, pub sampling_full: bool, pub activity: Activity,
    /// cadence, stride_cv, regularity, sway, wobble, jerk, rotation, peak_g
    pub bands: Vec<MetricBand>,
    pub listening: bool,
    /// context that holds right now: "away from home late", "in a vehicle", "loud venue", "phone set down"
    pub context: Vec<String>,
    pub baseline_trusted: bool, pub baseline_walk_days: f32, pub evidence: String,
    /// seconds of normal walking since the newest Watch / Danger incident opened
    pub calm_walk_s: f32,
}
#[derive(uniffi::Record, Clone, Debug)]
pub struct IncidentRecord {
    pub id: u32, pub t_ms: u64, pub kind: IncidentKind, pub tier: IncidentTier, pub summary: String, pub sd_distance: f32, pub placement: Placement, pub raw_json: String,
    /// 0 = still active
    pub cleared_ms: u64,
    /// answered a check-in while it was active: no longer asks for another
    pub acknowledged: bool,
    /// escalation episode; 0 = none
    pub sequence_id: u32, pub watched: bool,
}
#[derive(uniffi::Enum, Clone, Debug)]
pub enum EngineEvent {
    CheckRequested { phrase: String, deadline_ms: u64, summary: String },
    HeadsUp { summary: String },
    UnlockLocation { summary: String },
    SnatchDetected { summary: String },
    Resolved,
    BatteryDying,
    LocationIntervalChanged { seconds: u32 },
    SamplingRateChanged { hz: u32, gyro: bool },
    /// microphone listening window opened / closed
    AudioListening { on: bool },
    SignalIncident { record: IncidentRecord },
    IncidentCleared { record: IncidentRecord },
    /// the incident log was reset by the user
    IncidentLogCleared,
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
            last_touch_ms: c.last_touch_ms, distance_home_m: c.distance_home_m, sampling_full: c.sampling_full, charging: c.charging,
        }
    }
}
impl From<AudioScores> for core::AudioScores {
    fn from(a: AudioScores) -> Self { core::AudioScores { t_ms: a.t_ms, scream: a.scream, shout: a.shout, snore: a.snore, level_db: a.level_db, distress: a.distress } }
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
        use core::IncidentKind as K;
        match k {
            K::PhoneDrop => IncidentKind::PhoneDrop,
            K::PossibleFall => IncidentKind::PossibleFall,
            K::FallRecovered => IncidentKind::FallRecovered,
            K::DownAfterFall => IncidentKind::DownAfterFall,
            K::HardImpact => IncidentKind::HardImpact,
            K::UnsteadyGait => IncidentKind::UnsteadyGait,
            K::Stumble => IncidentKind::Stumble,
            K::RepeatedStumbles => IncidentKind::RepeatedStumbles,
            K::SlowedWalk => IncidentKind::SlowedWalk,
            K::PhoneLeftBehind => IncidentKind::PhoneLeftBehind,
            K::Grab => IncidentKind::Grab,
            K::Separated => IncidentKind::Separated,
            K::StoppedOnWayHome => IncidentKind::StoppedOnWayHome,
            K::InVehicle => IncidentKind::InVehicle,
            K::BatteryCritical => IncidentKind::BatteryCritical,
            K::CheckInMissed => IncidentKind::CheckInMissed,
            K::TypingOff => IncidentKind::TypingOff,
            K::ScreamShout => IncidentKind::ScreamShout,
            K::SnoringWhileDown => IncidentKind::SnoringWhileDown,
            K::DistressWords => IncidentKind::DistressWords,
        }
    }
}
impl From<core::IncidentTier> for IncidentTier {
    fn from(t: core::IncidentTier) -> Self {
        match t { core::IncidentTier::Context => IncidentTier::Context, core::IncidentTier::Watch => IncidentTier::Watch, core::IncidentTier::Danger => IncidentTier::Danger }
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
            listening: m.listening, context: m.context,
            baseline_trusted: m.baseline_trusted, baseline_walk_days: m.baseline_walk_days, evidence: m.evidence, calm_walk_s: m.calm_walk_s,
        }
    }
}
impl From<core::IncidentRecord> for IncidentRecord {
    fn from(r: core::IncidentRecord) -> Self {
        IncidentRecord {
            id: r.id, t_ms: r.t_ms, kind: r.kind.into(), tier: r.tier.into(), summary: r.summary, sd_distance: r.sd_distance, placement: r.placement.into(), raw_json: r.raw_json,
            cleared_ms: r.cleared_ms, acknowledged: r.acknowledged,
            sequence_id: r.sequence_id, watched: r.watched,
        }
    }
}
impl From<core::Snapshot> for Snapshot {
    fn from(s: core::Snapshot) -> Self {
        Snapshot {
            escalation: s.escalation.into(), evidence: s.evidence, sensing_full: s.sensing_full, listening: s.listening,
            baseline_seconds: s.baseline_seconds, placement: s.placement.into(), night_mode: s.night_mode,
        }
    }
}
impl From<core::EngineEvent> for EngineEvent {
    fn from(e: core::EngineEvent) -> Self {
        match e {
            core::EngineEvent::CheckRequested { phrase, deadline_ms, summary } => EngineEvent::CheckRequested { phrase, deadline_ms, summary },
            core::EngineEvent::HeadsUp { summary } => EngineEvent::HeadsUp { summary },
            core::EngineEvent::UnlockLocation { summary } => EngineEvent::UnlockLocation { summary },
            core::EngineEvent::SnatchDetected { summary } => EngineEvent::SnatchDetected { summary },
            core::EngineEvent::Resolved => EngineEvent::Resolved,
            core::EngineEvent::BatteryDying => EngineEvent::BatteryDying,
            core::EngineEvent::LocationIntervalChanged { seconds } => EngineEvent::LocationIntervalChanged { seconds },
            core::EngineEvent::SamplingRateChanged { hz, gyro } => EngineEvent::SamplingRateChanged { hz, gyro },
            core::EngineEvent::AudioListening { on } => EngineEvent::AudioListening { on },
            core::EngineEvent::SignalIncident { record } => EngineEvent::SignalIncident { record: record.into() },
            core::EngineEvent::IncidentCleared { record } => EngineEvent::IncidentCleared { record: record.into() },
            core::EngineEvent::IncidentLogCleared => EngineEvent::IncidentLogCleared,
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
    /// Run the distress-word spotter on this frame? (mic open and a fall within `distress_after_s`)
    pub fn words_wanted(&self, now_ms: u64) -> bool {
        self.lock().words_wanted(now_ms)
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
    /// User reset: empty the incident log and put sensing back to rest (baselines stay). Events follow on the next tick.
    pub fn reset_incidents(&self, now_ms: u64) {
        self.lock().reset_incidents(now_ms);
    }
    pub fn set_learning(&self, enabled: bool) {
        self.lock().set_learning(enabled);
    }
    /// Data-collection mode: incident rules run (night mode or not), but nothing escalates and nothing is learned.
    pub fn set_collecting(&self, on: bool, now_ms: u64) {
        self.lock().set_collecting(on, now_ms);
    }
    /// Call every ~1 s in night mode; every incident rule and the escalation run inside.
    pub fn tick(&self, now_ms: u64) -> Vec<EngineEvent> {
        self.lock().tick(now_ms).into_iter().map(Into::into).collect()
    }
    pub fn snapshot(&self) -> Snapshot {
        self.lock().snapshot().into()
    }
    /// Live metrics vs. bands, risk band, active incidents, context, baseline trust (dashboard).
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
