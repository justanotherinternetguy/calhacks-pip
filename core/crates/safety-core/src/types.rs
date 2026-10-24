//! Plain Rust mirrors of the FFI contract types (docs/CONTRACTS.md §1 + §6 addendum).
use serde::{Deserialize, Serialize};

fn neg_one() -> f32 {
    -1.0
}
fn yes() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct MotionSample {
    pub t_ms: u64,
    /// user acceleration (g, gravity removed), device frame
    pub ax: f32,
    pub ay: f32,
    pub az: f32,
    /// gravity unit vector, device frame
    pub gx: f32,
    pub gy: f32,
    pub gz: f32,
    /// gyroscope rotation rate (rad/s), device frame; all 0 when the gyro is off (low-rate mode)
    #[serde(default)]
    pub rx: f32,
    #[serde(default)]
    pub ry: f32,
    #[serde(default)]
    pub rz: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Activity {
    #[default]
    Unknown,
    Stationary,
    Walking,
    Running,
    Vehicle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Placement {
    #[default]
    Unknown,
    Pocket,
    Hand,
    Bag,
}

impl Placement {
    pub fn index(self) -> usize {
        match self {
            Placement::Unknown => 0,
            Placement::Pocket => 1,
            Placement::Hand => 2,
            Placement::Bag => 3,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Context {
    pub t_ms: u64,
    pub away_from_home: bool,
    pub separated: bool,
    pub hour_local: u8,
    pub screen_on: bool,
    pub activity: Activity,
    pub battery_pct: u8,
    /// -1 = unknown
    pub speed_mps: f32,
    /// wall-clock ms of the last touch / interactive unlock; 0 = never/unknown
    #[serde(default)]
    pub last_touch_ms: u64,
    /// metres from home; -1 = unknown
    #[serde(default = "neg_one")]
    pub distance_home_m: f32,
    /// what native is currently delivering: true = 50 Hz + gyro, false = ~10 Hz accel only
    #[serde(default = "yes")]
    pub sampling_full: bool,
}

impl Default for Context {
    fn default() -> Self {
        Context {
            t_ms: 0,
            away_from_home: false,
            separated: false,
            hour_local: 12,
            screen_on: false,
            activity: Activity::Unknown,
            battery_pct: 100,
            speed_mps: -1.0,
            last_touch_ms: 0,
            distance_home_m: -1.0,
            sampling_full: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct AudioScores {
    pub t_ms: u64,
    pub scream: f32,
    pub shout: f32,
    pub glass: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TypingSample {
    pub phrase: String,
    pub typed: String,
    pub key_times_ms: Vec<u64>,
    pub backspaces: u32,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TypingVerdict {
    pub accepted: bool,
    pub z_score: f32,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UserAction {
    DismissOk,
    DismissWrongPhrase,
    NeedHelp,
    ManualSos,
    BiometricDismiss,
    FriendMarkedSafe,
    CheckTimeout,
    /// owner unlocked the device; clears a grab within its 2-minute window
    PhoneUnlocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HmmState {
    Normal,
    Impaired,
    Incident,
    Unresponsive,
}

impl HmmState {
    pub const ALL: [HmmState; 4] = [
        HmmState::Normal,
        HmmState::Impaired,
        HmmState::Incident,
        HmmState::Unresponsive,
    ];
    pub fn from_index(i: usize) -> Self {
        Self::ALL[i.min(3)]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EscalationLevel {
    Idle,
    Check,
    HeadsUp,
    Unlocked,
    Snatch,
    Resolved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub p_danger: f32,
    pub hmm_state: HmmState,
    pub escalation: EscalationLevel,
    /// 0..3
    pub risk_band: u8,
    pub evidence: String,
    pub baseline_seconds: u32,
    pub placement: Placement,
    pub night_mode: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum IncidentKind {
    GaitDrift,
    Impact,
    Grab,
    Stillness,
    Separated,
    TypingOff,
}

impl IncidentKind {
    pub const ALL: [IncidentKind; 6] = [
        IncidentKind::GaitDrift,
        IncidentKind::Impact,
        IncidentKind::Grab,
        IncidentKind::Stillness,
        IncidentKind::Separated,
        IncidentKind::TypingOff,
    ];
    pub fn name(self) -> &'static str {
        match self {
            IncidentKind::GaitDrift => "gait_drift",
            IncidentKind::Impact => "impact",
            IncidentKind::Grab => "grab",
            IncidentKind::Stillness => "stillness",
            IncidentKind::Separated => "separated",
            IncidentKind::TypingOff => "typing_off",
        }
    }
}

/// One live metric compared to the user's per-placement baseline band.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MetricBand {
    pub name: String,
    pub value: f32,
    pub mean: f32,
    pub sd: f32,
    /// (value - mean) / sd, signed
    pub sd_distance: f32,
    pub in_band: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LiveMetrics {
    pub t_ms: u64,
    pub placement: Placement,
    pub sampling_full: bool,
    pub activity: Activity,
    /// cadence, stride_cv, regularity, sway, wobble, jerk, rotation, peak_g
    pub bands: Vec<MetricBand>,
    pub p_normal: f32,
    pub p_impaired: f32,
    pub p_incident: f32,
    pub p_unresponsive: f32,
    pub baseline_trusted: bool,
    pub baseline_walk_days: f32,
    pub evidence: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IncidentRecord {
    pub id: u32,
    pub t_ms: u64,
    pub kind: IncidentKind,
    pub summary: String,
    pub sd_distance: f32,
    pub placement: Placement,
    /// compact JSON of the raw metric values behind the incident
    pub raw_json: String,
    pub p_normal: f32,
    pub p_impaired: f32,
    pub p_incident: f32,
    pub p_unresponsive: f32,
    /// 0 = none
    pub sequence_id: u32,
    pub watched: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum EngineEvent {
    CheckRequested { phrase: String, deadline_ms: u64 },
    HeadsUp { summary: String },
    UnlockLocation { summary: String },
    SnatchDetected { summary: String },
    Resolved,
    RiskBandChanged { band: u8 },
    BatteryDying,
    LocationIntervalChanged { seconds: u32 },
    /// native must reconfigure sensors (10 Hz/no gyro by default; 50 Hz + gyro away from home at night or after an incident)
    SamplingRateChanged { hz: u32, gyro: bool },
    /// a metric left its band or a grab/impact/stillness/separation/typing rule fired
    SignalIncident { record: IncidentRecord },
    /// 10 min with no response: friends get the one-tap campus safety / 911 option
    CallOptionAvailable { summary: String },
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("config: {msg}")]
    Config { msg: String },
    #[error("baseline: {msg}")]
    Baseline { msg: String },
}
