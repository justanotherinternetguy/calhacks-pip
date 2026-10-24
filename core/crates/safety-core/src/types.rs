//! Plain Rust mirrors of the FFI contract types (docs/CONTRACTS.md §1).
use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("config: {msg}")]
    Config { msg: String },
    #[error("baseline: {msg}")]
    Baseline { msg: String },
}
