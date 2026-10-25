-- 0017_model_v6_pocket_calibration.sql — model config v6: core/config/model-v1.toml verbatim. Changes from v5 (calibrated on one
-- person's /collect recordings, phone in a trouser pocket, 2026-10-25):
--   [incidents] unsteady_metrics = regularity, sway, wobble (stride_cv dropped); walk_impact_hold_s = 10 (a mid-walk bump
--   is held and dropped if walking continues)
--   [baseline.placement_priors.pocket / .unknown] priors from that person's normal walk

insert into public.model_configs (version, toml, signature)
select 'v6', $toml$
# Safety detection model v2 — rule-based incidents (no probability model). Hand-set parameters.
# Loaded by safety_core::config::Config::from_toml. Every number here is a tunable; the structure must
# match config.rs. Keys missing from a served config fall back to this file; unknown keys are ignored.
#
# How it works: sensors → signals (gait, impact, grab, stillness, audio labels, location context) → incidents.
# Every incident has a tier and a clearing rule:
#   Context  logged only (fall recovered, single stumble, in a vehicle, battery critical)
#   Watch    full sensing (50 Hz + gyro, faster location), counts toward a check-in
#   Danger   asks "You okay?" by itself (down after a fall, check-in missed, snoring while down; grab has its own path)
# A check-in is asked when a Danger incident is active, a serious Watch incident listed in incidents.check_alone has
# been open for check_alone_after_s, or Watch incidents from >= check_min_families independent families (fall / gait /
# phone / location / check-in / audio) are active at the same time. Answering it acknowledges the active incidents;
# only a new one can ask again.

[thresholds]
# true = incidents escalate on their own: check-in, heads-up, location unlock, grab alert.
# false = incident logging only: incidents open, clear, log and drive sensing, but nothing escalates on its own.
# Manual SOS / "I need help" unlock either way.
auto_escalate = true
check_deadline_s = 120         # "You okay?" unanswered this long ⇒ CheckInMissed + heads-up to friends (no location)
unlock_no_response_s = 240     # since the check (2 min after the heads-up), trigger still holding ⇒ location unlock
call_option_s = 600            # since the check ⇒ friends get the one-tap campus safety / 911 option
grab_unlock_s = 120            # grab: snatch alert at once, unlock step after this unless the owner unlocks the phone
check_repeat_cooldown_s = 300
check_min_families = 2
# Encrypted location upload interval: normally, and once friends were alerted (heads-up / unlock / grab / SOS)
location_upload_s = 300
location_upload_alert_s = 60
# Typing z above this = "far off baseline" (logs TypingOff during a check-in)
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
# Classified after post_window_ms: drop (below) ⇒ PhoneDrop if not picked up; fall pattern (orientation change +
# micro-motion after, or free fall + hard peak) ⇒ PossibleFall; any other peak > incident_peak_g with an orientation
# change ⇒ HardImpact. A peak without orientation change (dancing, jumping, a slap) is not an incident.
incident_peak_g = 3.0
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
# Spike metrics (jerk, rotation, peak_g) are computed per 1 s block; the dashboard shows the peak over the last
# spike_hold_s seconds so a 300 ms flash stays visible. Detection uses the instantaneous values.
spike_hold_s = 8

[incidents]
# ---- falls ----
# Phone drop (long free fall, lands flat, dead still): logged only if not picked up within drop_pickup_s.
drop_pickup_s = 60
# The first sample above impact.incident_peak_g opens a HardImpact ("High-g impact") at once; when the impact is
# classified (~impact_window_ms + post_window_ms later) a fall replaces it with PossibleFall, a drop or a peak
# without a tilt clears it, a hard knock with a tilt keeps it.
# Possible fall or hard impact ⇒ Down after fall when, for this long after the impact settled, there are no steps
# and no touch (eager: lying still, sitting up or a phone that stays where it landed all count).
down_after_fall_s = 15
# ---- gait ---- (needs full-rate sampling; the OS must not report stationary/vehicle)
# Unsteady gait: stride variability / regularity / sway / wobble out of band for unsteady_persist_s of walking;
# clears after unsteady_clear_s of in-band walking. A pause longer than drift_gap_s restarts the persistence clock.
unsteady_persist_s = 35
unsteady_clear_s = 120
# Metrics the rule looks at. stride_cv is left out: in a pocket the step peaks are too noisy for it (it measured
# 0.42 on a normal walk and lower on an unsteady one, 2026-10-25 /collect recordings).
unsteady_metrics = ["regularity", "sway", "wobble"]
# A bump with a tilt in the middle of a walk (a pocket sees one every few steps at 3 to 4 g) is held this long:
# a walking window that starts after it drops it, a walk that stopped opens it as a hard impact.
walk_impact_hold_s = 10
drift_gap_s = 6
# Slowed walk: cadence below (1 - slowed_cadence_frac) × baseline mean for slowed_persist_s of walking.
slowed_cadence_frac = 0.2
slowed_persist_s = 60
slowed_clear_s = 30
# Stumble: one step interval off the window median by > stumble_interval_dev (fraction) with a sideways spike
# > stumble_lateral_g, while walking continues. Removed after stumble_prune_min if nothing follows.
stumble_interval_dev = 0.4
stumble_lateral_g = 0.5
stumble_prune_min = 30
repeated_stumbles_n = 3
repeated_stumbles_window_min = 5
repeated_stumbles_clear_min = 10
# ---- stillness ----
# Phone set down (context): window RMS below set_down_rms_g (no micro-motion) for set_down_s.
set_down_rms_g = 0.004
set_down_s = 300
# Phone left behind: set down this long while away from home late.
left_behind_min = 20
# ---- location ----
# Separated: separated from all friends for separated_min while the distance home is not falling by more than
# separated_home_margin_m (heading home ⇒ no incident).
separated_min = 10
separated_home_margin_m = 50
# Stopped on the way home: distance home fell by >= heading_home_margin_m over heading_home_window_min, then no
# steps / vehicle / speed above moving_speed_mps for stopped_min, away from home.
stopped_min = 10
heading_home_window_min = 15
heading_home_margin_m = 200
moving_speed_mps = 1.0
# ---- device ----
battery_critical_pct = 10
battery_clear_pct = 15
# ---- audio ---- (mic listens only after a fall, grab, missed check-in or unsteady gait, for listen_hold_min after)
# Scream/shout: >= scream_frames frames with score >= scream_min within scream_window_s, within scream_after_s of a
# grab or fall, and not in a loud venue. Clears after scream_clear_min.
scream_min = 0.5
scream_frames = 2
scream_window_s = 10
scream_after_s = 120
scream_clear_min = 10
# Loud venue: median level of the last loud_venue_frames frames >= loud_venue_db (dB SPL).
loud_venue_db = 80
loud_venue_frames = 15
# Snoring while down: >= snore_frames frames with snore >= snore_min within snore_window_s, while down after a fall
# and a check-in was missed.
snore_min = 0.4
snore_frames = 3
snore_window_s = 60
listen_hold_min = 10
# ---- check-in ----
# Serious enough to ask "You okay?" on their own (Danger kinds always do). Milder Watch kinds need
# thresholds.check_min_families families at once. The delay lets a high-g impact be classified first (~2.4 s:
# a drop or a peak without a tilt clears it), so a dropped phone does not ask.
check_alone = ["possible_fall", "hard_impact", "scream_shout"]
check_alone_after_s = 5

[sampling]
# Engine-decided sensor mode, emitted as SamplingRateChanged on change and once at the first tick.
# Full (full_hz + gyro) when away from home in [full_hour_start, 24) ∪ [0, full_hour_end), while any Watch or Danger
# incident is active, or within after_incident_min of any logged incident; otherwise low (low_hz, accel only).
full_hz = 50
low_hz = 10
full_hour_start = 21
full_hour_end = 6
after_incident_min = 30
# Also request full rate while learning is on, night mode is off, the OS reports walking and the
# baseline is not yet trusted — otherwise a day-time baseline could never be learned at 10 Hz.
learn_walks_full_rate = true

[sequence]
# When a check-in, grab or SOS starts an episode, incidents from the last window_min minutes join it; the
# friends' one-line summary ("Unsteady walking, then a possible fall, then down for 2 min") is built from them.
window_min = 60

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

# Per-placement priors (used until that placement's own baseline is trusted). Pocket and unknown are calibrated to
# one person's normal walk, phone in a trouser pocket (2026-10-25 /collect: regularity 0.93 ± 0.10, median 0.96;
# sway 0.224 ± 0.008 g; wobble 100 ± 4 °/s; unsteady walk: regularity 0.49, sway 0.26 g, wobble 119 °/s). SDs are
# wider than one walk showed so day-to-day variation stays inside the band.
[baseline.placement_priors.pocket]
step_cv    = [0.42, 0.06]
regularity = [0.95, 0.07]
sway_rms   = [0.224, 0.012]
wobble     = [100.0, 6.0]

[baseline.placement_priors.unknown]
step_cv    = [0.42, 0.06]
regularity = [0.95, 0.07]
sway_rms   = [0.224, 0.012]
wobble     = [100.0, 6.0]

[baseline.typing_priors]
# Population priors per typing feature: [median, sd]
ik_median_ms   = [250.0, 80.0]
ik_cv          = [0.6, 0.2]
backspace_rate = [0.05, 0.08]
edit_ratio     = [0.02, 0.05]
ms_per_char    = [350.0, 120.0]
$toml$, 'unsigned-dev'
where not exists (select 1 from public.model_configs where version = 'v6');
