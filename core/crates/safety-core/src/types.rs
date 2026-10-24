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
    /// phone is plugged in
    #[serde(default)]
    pub charging: bool,
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
            charging: false,
        }
    }
}

/// One ~1 s microphone frame, classified on the phone (YAMNet). Labels and a level only; audio never leaves native.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct AudioScores {
    pub t_ms: u64,
    pub scream: f32,
    pub shout: f32,
    #[serde(default)]
    pub snore: f32,
    /// estimated sound level, dB SPL (from dBFS with the Android CDD voice-recognition calibration)
    #[serde(default)]
    pub level_db: f32,
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
    pub escalation: EscalationLevel,
    /// the open escalation episode's one-line summary ("A hard fall, then down for 5 s"); empty when none
    pub evidence: String,
    /// full sensing: 50 Hz + gyro
    pub sensing_full: bool,
    /// microphone listening window open
    pub listening: bool,
    pub baseline_seconds: u32,
    pub placement: Placement,
    pub night_mode: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum IncidentKind {
    // falls
    PhoneDrop,
    PossibleFall,
    FallRecovered,
    DownAfterFall,
    HardImpact,
    // gait
    UnsteadyGait,
    Stumble,
    RepeatedStumbles,
    SlowedWalk,
    // stillness / handling
    PhoneLeftBehind,
    Grab,
    // location
    Separated,
    StoppedOnWayHome,
    InVehicle,
    // device
    BatteryCritical,
    // check-in
    CheckInMissed,
    TypingOff,
    // audio
    ScreamShout,
    SnoringWhileDown,
}

/// How much an incident counts. Context is logged only; Watch turns on full sensing and counts toward a check-in;
/// Danger asks "You okay?" on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum IncidentTier {
    Context,
    Watch,
    Danger,
}

/// Independent kinds of evidence. Two Watch incidents from different families ask for a check-in; two from the
/// same family (e.g. unsteady gait + slowed walk, both from one walk) do not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum IncidentFamily {
    Fall,
    Gait,
    Phone,
    Handling,
    Location,
    Device,
    CheckIn,
    Audio,
}

impl IncidentKind {
    pub const ALL: [IncidentKind; 19] = [
        IncidentKind::PhoneDrop,
        IncidentKind::PossibleFall,
        IncidentKind::FallRecovered,
        IncidentKind::DownAfterFall,
        IncidentKind::HardImpact,
        IncidentKind::UnsteadyGait,
        IncidentKind::Stumble,
        IncidentKind::RepeatedStumbles,
        IncidentKind::SlowedWalk,
        IncidentKind::PhoneLeftBehind,
        IncidentKind::Grab,
        IncidentKind::Separated,
        IncidentKind::StoppedOnWayHome,
        IncidentKind::InVehicle,
        IncidentKind::BatteryCritical,
        IncidentKind::CheckInMissed,
        IncidentKind::TypingOff,
        IncidentKind::ScreamShout,
        IncidentKind::SnoringWhileDown,
    ];
    pub fn name(self) -> &'static str {
        match self {
            IncidentKind::PhoneDrop => "phone_drop",
            IncidentKind::PossibleFall => "possible_fall",
            IncidentKind::FallRecovered => "fall_recovered",
            IncidentKind::DownAfterFall => "down_after_fall",
            IncidentKind::HardImpact => "hard_impact",
            IncidentKind::UnsteadyGait => "unsteady_gait",
            IncidentKind::Stumble => "stumble",
            IncidentKind::RepeatedStumbles => "repeated_stumbles",
            IncidentKind::SlowedWalk => "slowed_walk",
            IncidentKind::PhoneLeftBehind => "phone_left_behind",
            IncidentKind::Grab => "grab",
            IncidentKind::Separated => "separated",
            IncidentKind::StoppedOnWayHome => "stopped_on_way_home",
            IncidentKind::InVehicle => "in_vehicle",
            IncidentKind::BatteryCritical => "battery_critical",
            IncidentKind::CheckInMissed => "check_in_missed",
            IncidentKind::TypingOff => "typing_off",
            IncidentKind::ScreamShout => "scream_shout",
            IncidentKind::SnoringWhileDown => "snoring_while_down",
        }
    }
    pub fn tier(self) -> IncidentTier {
        use IncidentKind::*;
        match self {
            FallRecovered | Stumble | InVehicle | BatteryCritical => IncidentTier::Context,
            DownAfterFall | Grab | CheckInMissed | SnoringWhileDown => IncidentTier::Danger,
            PhoneDrop | PossibleFall | HardImpact | UnsteadyGait | RepeatedStumbles | SlowedWalk | PhoneLeftBehind | Separated
            | StoppedOnWayHome | TypingOff | ScreamShout => IncidentTier::Watch,
        }
    }
    pub fn family(self) -> IncidentFamily {
        use IncidentKind::*;
        match self {
            PhoneDrop | PossibleFall | FallRecovered | DownAfterFall | HardImpact => IncidentFamily::Fall,
            UnsteadyGait | Stumble | RepeatedStumbles | SlowedWalk => IncidentFamily::Gait,
            PhoneLeftBehind => IncidentFamily::Phone,
            Grab => IncidentFamily::Handling,
            Separated | StoppedOnWayHome | InVehicle => IncidentFamily::Location,
            BatteryCritical => IncidentFamily::Device,
            CheckInMissed | TypingOff => IncidentFamily::CheckIn,
            ScreamShout | SnoringWhileDown => IncidentFamily::Audio,
        }
    }
    /// A moment rather than a condition: logged already cleared (a stumble, getting up after a fall).
    pub fn is_point(self) -> bool {
        matches!(self, IncidentKind::Stumble | IncidentKind::FallRecovered)
    }
    /// Opens the microphone listening window (for `listen_hold_min`): a fall, a drop, a grab, a missed check-in,
    /// unsteady gait.
    pub fn opens_listening(self) -> bool {
        use IncidentKind::*;
        matches!(
            self,
            PhoneDrop | PossibleFall | DownAfterFall | HardImpact | Grab | CheckInMissed | UnsteadyGait | RepeatedStumbles
        )
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
    pub listening: bool,
    /// context conditions that hold right now: "away from home late", "in a vehicle", "loud venue", "phone set down"
    pub context: Vec<String>,
    pub baseline_trusted: bool,
    pub baseline_walk_days: f32,
    pub evidence: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IncidentRecord {
    pub id: u32,
    pub t_ms: u64,
    pub kind: IncidentKind,
    pub tier: IncidentTier,
    pub summary: String,
    pub sd_distance: f32,
    pub placement: Placement,
    /// compact JSON of the raw metric values behind the incident
    pub raw_json: String,
    /// when its clearing condition was met; 0 = still active
    pub cleared_ms: u64,
    /// the user answered a check-in while it was active: it no longer asks for another one
    pub acknowledged: bool,
    /// escalation episode it belongs to; 0 = none
    pub sequence_id: u32,
    /// part of an escalation episode (check-in, grab, SOS)
    pub watched: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum EngineEvent {
    CheckRequested { phrase: String, deadline_ms: u64 },
    HeadsUp { summary: String },
    UnlockLocation { summary: String },
    SnatchDetected { summary: String },
    Resolved,
    /// battery critical while away late: native uploads the latest encrypted location now
    BatteryDying,
    LocationIntervalChanged { seconds: u32 },
    /// native must reconfigure sensors (10 Hz/no gyro by default; 50 Hz + gyro away from home at night or after an incident)
    SamplingRateChanged { hz: u32, gyro: bool },
    /// open (true): native captures ~1 s microphone frames continuously and pushes their labels; closed: mic off
    AudioListening { on: bool },
    /// an incident was logged (opened)
    SignalIncident { record: IncidentRecord },
    /// an incident met its clearing condition (record carries cleared_ms)
    IncidentCleared { record: IncidentRecord },
    /// the user reset the incident log (`reset_incidents`): every record is gone
    IncidentLogCleared,
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
