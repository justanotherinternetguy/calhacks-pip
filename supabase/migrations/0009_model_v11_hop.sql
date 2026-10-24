-- model-v1.toml: 1 s gait hop, spike peak-hold (dashboard responsiveness).
update public.model_configs set toml = $toml$
# Safety detection model v1 (+ v1.1 addendum) — hand-set parameters (learned from data in v2).
# Loaded by safety_core::config::Config::from_toml. Every number here is a
# tunable; the structure must match config.rs.
#
# States are indexed everywhere as: 0 = Normal, 1 = Impaired, 2 = Incident, 3 = Unresponsive.

[hmm]
# Initial posterior when night mode starts.
initial = [0.97, 0.02, 0.005, 0.005]
# Forward filter step period. Impacts trigger an immediate extra step.
step_seconds = 60
# Base transition logits, row = from-state, col = to-state. Rows are softmaxed
# at runtime (after context is added to the forward entries), so only relative
# values matter. Recovery transitions (Incident→Impaired, Impaired→Normal,
# Unresponsive→Incident) are built in here so story B resolves without alarm.
base_logits = [
  [ 4.0, -0.6, -3.5, -6.5],   # Normal:       ~0.985 stay, ~1%/min leak to Impaired, ~0.05%/min direct to Incident
  [ 1.6,  3.0,  0.0, -1.4],   # Impaired:     ~19%/min back to Normal, ~4%/min to Incident
  [-2.0, -0.4,  2.2,  1.2],   # Incident:     transient: ~25%/min to Unresponsive, ~5%/min to Impaired (walking resumes)
  [-3.5, -2.6, -0.6,  3.5],   # Unresponsive: sticky (~98%), recovers via Incident
]

[hmm.context]
# Weights added to the logits of *forward* transitions (to-state > from-state)
# for each from-state when the context flag is active:
# T(ctx) = softmax(base_logits + Σ ctx_i · w_i), forward entries only.
away_from_home = [0.3, 0.4, 0.3, 0.0]
separated      = [0.5, 0.8, 0.8, 0.0]
late           = [0.3, 0.4, 0.3, 0.0]
rapid_drift    = [1.0, 1.2, 0.3, 0.0]
# Sequence agent (incident log): its log-odds boost b ∈ [0, sequence.max_boost] is added to the
# forward logits as sequence[from] · b. Only incidents that form a concerning sequence contribute;
# an isolated gait drift never does.
sequence       = [1.0, 1.0, 0.6, 0.0]
# hour_local in [late_hour_start, late_hour_end] counts as "late" (wraps midnight).
late_hour_start = 0
late_hour_end = 5
# Gait drift z rising faster than this per minute flags "rapid drift onset" (possible spiking).
rapid_drift_z_per_min = 1.0

[emissions]
# Rule: a quiet minute (nothing observed) is ~equally likely under Normal and Unresponsive, so
# sitting at a table for hours can never compound into danger; only the Incident gateway
# (impact) separates them. Positive events carry the information.
# P(walking observed | state) — applied only when walking is seen
p_walking = [0.4, 0.7, 0.1, 0.02]
# Gait-drift z (given walking observed) ~ N(mean, sd) per state
# Incident shares Impaired's gait emission so drift raises P(Impaired), not P(Incident).
# The engine clips drift z to [0, 4].
gait_z_mean = [0.0, 2.5, 2.5, 0.0]
gait_z_sd   = [1.0, 1.5, 1.5, 2.0]
# P(fall-like impact this step | state). A detector likelihood ≥0.5 counts as an impact;
# otherwise the "no impact" term (1-p) applies — it drains the transient Incident state.
p_impact = [0.001, 0.005, 0.6, 0.01]
# Stillness is emitted as bounded bucket-crossing events: when the still duration first
# passes each edge, P(reached bucket | state) is applied once. Buckets reset once motion resumes.
stillness_buckets_s = [30, 120, 240, 480]
p_stillness = [
  [0.30, 0.20, 0.10, 0.10],   # Normal: sitting at a table is fine
  [0.30, 0.20, 0.10, 0.10],
  [0.30, 0.25, 0.12, 0.10],
  [0.30, 0.40, 0.60, 0.50],   # Unresponsive favours long stillness (≥4 min: 6x, ≥8 min: 5x)
]
# P(agitation | state) — weighted low because dancing looks the same (Unresponsive = Normal: quiet parity)
p_agitation = [0.10, 0.15, 0.30, 0.10]
# P(audio jump above venue background | state)
p_audio = [0.05, 0.08, 0.25, 0.05]
# P(phone touched / screen on during the minute | state) — applied only when touched
p_touched = [0.40, 0.40, 0.15, 0.02]
# Evidence pushed immediately on a wrong check-in phrase
p_wrong_phrase = [0.10, 0.50, 0.50, 0.50]
# Evidence pushed immediately when check-in typing is far off baseline
p_typing_impaired = [0.10, 0.60, 0.60, 0.30]

[thresholds]
# Escalation timings (v1.1): Check at P ≥ t_check; the user gets check_deadline_s to answer, then
# HeadsUp (friends, no location) if P ≥ t_heads_up; UnlockLocation once there has been no response for
# unlock_no_response_s since the check AND P ≥ t_unlock; CallOptionAvailable once after call_option_s
# with no response. NeedHelp / ManualSos unlock immediately.
t_check = 0.7
t_heads_up = 0.5
t_unlock = 0.9
check_deadline_s = 90
unlock_no_response_s = 120
call_option_s = 600
# Grab: HeadsUp immediately (no location), UnlockLocation after grab_unlock_s unless PhoneUnlocked / BiometricDismiss.
grab_unlock_s = 120
# A good dismiss resets the posterior toward Normal and raises every threshold
# by `cooldown_threshold_boost` for `dismiss_cooldown_s`.
dismiss_cooldown_s = 1800
cooldown_threshold_boost = 0.2
# Posterior after a good dismiss
dismiss_posterior = [0.9, 0.09, 0.005, 0.005]
# Minimum gap between two Check prompts
check_repeat_cooldown_s = 300
# Risk band 0..3 from P(danger); hysteresis applies when going down
risk_band_edges = [0.2, 0.45, 0.7]
risk_band_hysteresis = 0.05
# Location upload interval per risk band (seconds)
location_interval_s = [300, 180, 120, 60]
battery_dying_pct = 3
# Typing z above this = "far off baseline" (also logs a TypingOff incident)
typing_z_reject = 2.5
# Edit distance / phrase length above this = wrong phrase
typing_max_edit_ratio = 0.3

[gait]
# Nominal full rate. Filters are designed from the rate actually observed in each window
# (sample timestamps), so 50 Hz and 10 Hz input both work.
sample_hz = 50
# Below this observed rate (low-rate mode) a window yields activity/energy/peak only:
# no cadence, stride, sway, wobble, jerk or rotation metrics.
min_sample_hz = 20
window_s = 6.0
# Feature hop: a new gait window (and therefore new live metrics / bands) every hop_s seconds over the
# sliding window_s window. 1 s keeps the dashboard current; the GaitDrift persistence clock counts
# seconds of walking, not windows, so drift_persist_s is unaffected, and baseline learning weights each
# window by hop_s so overlapping windows do not inflate the baseline.
hop_s = 1.0
band_low_hz = 0.5
band_high_hz = 3.0
# Peak threshold on band-passed vertical accel (g)
peak_min_g = 0.05
min_step_interval_s = 0.25
walk_cadence_min = 70.0
walk_cadence_max = 150.0
run_cadence_min = 150.0
min_regularity_walk = 0.35
# Window RMS below this = no motion (stillness tracker)
still_rms_g = 0.04
# Window RMS above this with no periodic gait = agitation
agitation_rms_g = 0.35

[impact]
# Fall pattern: free fall (<free_fall_g for ≥ min_free_fall_ms) → peak ≥ peak_g → orientation change → low motion.
free_fall_g = 0.5
min_free_fall_ms = 80
peak_g = 3.0
# Coarse path (works at 10 Hz accel-only too): any peak > incident_peak_g, no free fall required.
# Impact incident = peak > incident_peak_g AND (orientation change ≥ orientation_change_deg OR fall likelihood ≥ 0.5).
incident_peak_g = 2.5
impact_window_ms = 400
post_window_ms = 2000
orientation_change_deg = 45.0
post_still_rms_g = 0.15
# "Phone dropped alone": long free fall, lands flat, no body motion after
drop_min_free_fall_ms = 350
drop_flat_gz = 0.85
drop_post_rms_g = 0.06
# Motion above this after a drop = picked up (drop resolves)
pickup_rms_g = 0.12

[grab]
# In-hand = touched within in_hand_touch_s (Context.last_touch_ms) or screen on in a held orientation.
# Trigger = jerk above the user's jerk band AND above jerk_g_per_s, with rotation rate above the rotation
# band AND above rotation_deg_per_s (gyro). Confirmed by running cadence or speed > speed_mps persisting
# confirm_s (halved when separated) within arm_window_s.
jerk_g_per_s = 50.0
rotation_deg_per_s = 300.0
in_hand_touch_s = 2.0
arm_window_s = 15
speed_mps = 3.0
confirm_s = 4

[signals]
# Bands = baseline mean ± band_sd · SD per placement (band_sd_untrusted while the baseline is not trusted).
band_sd = 2.5
band_sd_untrusted = 3.5
# GaitDrift: a gait metric out of band (cadence either side; stride CV / sway / wobble above; regularity
# below) persisting this many seconds of walking; re-fires at most every drift_refire_s while it persists.
drift_persist_s = 30
drift_refire_s = 300
# A gap of more than this between walking windows (stopped, stood still) restarts the persistence clock.
drift_gap_s = 6
# Spike metrics (jerk, rotation, peak_g) are computed per 1 s block from the raw sample stream and the
# dashboard (Engine::metrics) reports the peak over the last spike_hold_s seconds, with the band evaluated
# against that held peak, so a 300 ms grab / impact flash stays visible for a few seconds. Grab and impact
# detection use the instantaneous per-sample values and are not affected by this hold.
spike_hold_s = 8
# Stillness: still (no body motion) ≥ stillness_s AND no touch ≥ stillness_s, after an impact
# within the last stillness_after_impact_min minutes.
stillness_s = 180
stillness_after_impact_min = 30
# Separated: Context.separated continuously for separated_min while distance_home_m is not decreasing
# (a drop of more than separated_home_margin_m over the period = heading home ⇒ no incident).
separated_min = 10
separated_home_margin_m = 50

[sampling]
# Engine-decided sensor mode, emitted as SamplingRateChanged on change and once at the first tick.
# Full (full_hz + gyro) when away_from_home and hour_local ∈ [full_hour_start, 24) ∪ [0, full_hour_end),
# or within after_incident_min of any logged incident; otherwise low (low_hz, accel only).
full_hz = 50
low_hz = 10
full_hour_start = 21
full_hour_end = 6
after_incident_min = 30
# Also request full rate while learning is on, night mode is off, the OS reports walking and the
# baseline is not yet trusted — otherwise a day-time baseline could never be learned at 10 Hz.
learn_walks_full_rate = true

[sequence]
# Rule-based sequence agent over the incident log. Concerning runs inside window_min minutes
# (Grab alone; Impact→Stillness; GaitDrift→Impact; GaitDrift→Separated; Separated→Impact; …)
# get a sequence_id, members are `watched`, and the sum of member weights (capped at max_boost)
# is added to the HMM forward logits (see hmm.context.sequence).
window_min = 60
# A GaitDrift with no other incident within this many minutes after it is irrelevant and removed.
prune_isolated_gait_drift_min = 20
max_boost = 2.5
w_gait_drift = 0.5
w_separated = 0.5
w_impact = 1.0
w_stillness = 1.0
w_grab = 1.5
w_typing_off = 0.5

[log]
# Incident records expire after this many hours (dropped on tick and on blob load).
expiry_h = 8

[baseline]
# Per-placement rolling window of per-day statistics. Trusted after trusted_days distinct local days
# with walking data; days older than window_days are dropped. Night sessions that produced an
# incident are excluded. Population priors (below) are used until trusted.
trusted_days = 7
window_days = 14
# Personal SD is floored at this fraction of the prior SD (keeps bands from collapsing).
sd_floor_frac = 0.3
# Gait-drift z (HMM input) is scaled by this while the baseline is untrusted
cold_start_z_scale = 0.7
# Typing baseline (robust median/MAD + EWMA)
min_samples = 10
max_samples = 300
ewma_alpha = 0.05

[baseline.priors]
# Population priors per gait metric: [mean, sd]
cadence        = [110.0, 10.0]     # steps/min
step_cv        = [0.04, 0.02]      # stride-time coefficient of variation
regularity     = [0.90, 0.06]      # autocorrelation at the step lag
harmonic_ratio = [4.0, 1.5]
sway_rms       = [0.05, 0.025]     # g, lateral
wobble         = [15.0, 6.0]        # deg/s RMS rotation rate orthogonal to gravity while walking
jerk           = [8.0, 4.0]        # g/s peak d|a|/dt per gait window
rotation       = [40.0, 25.0]      # deg/s peak rotation rate per gait window
peak_g         = [1.5, 0.3]        # g, peak total acceleration per gait window

[baseline.typing_priors]
# Population priors per typing feature: [median, sd]
ik_median_ms   = [250.0, 80.0]
ik_cv          = [0.6, 0.2]
backspace_rate = [0.05, 0.08]
edit_ratio     = [0.02, 0.05]
ms_per_char    = [350.0, 120.0]

$toml$, signature = 'unsigned-dev', created_at = now() where version = 'v1';
