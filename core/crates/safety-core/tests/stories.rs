//! Golden stories and end-to-end behaviour through `Engine` (spec v1 + v1.1 addendum).
use safety_core::config::DEFAULT_TOML;
use safety_core::signal::{gait::compute_features, DriftTracker, ImpactDetector, ImpactKind};
use safety_core::synth::{self, Gen, Scenario, Trace, G_HAND, G_POCKET};
use safety_core::*;

fn engine() -> Engine {
    Engine::new(DEFAULT_TOML, None, 0).unwrap()
}
fn first<F: Fn(&EngineEvent) -> bool>(evs: &[(u64, EngineEvent)], f: F) -> Option<u64> {
    evs.iter().find(|(_, e)| f(e)).map(|(t, _)| *t)
}
fn is_check(e: &EngineEvent) -> bool {
    matches!(e, EngineEvent::CheckRequested { .. })
}
fn is_unlock(e: &EngineEvent) -> bool {
    matches!(e, EngineEvent::UnlockLocation { .. })
}
fn is_heads_up(e: &EngineEvent) -> bool {
    matches!(e, EngineEvent::HeadsUp { .. })
}
fn incidents(evs: &[(u64, EngineEvent)], kind: IncidentKind) -> Vec<(u64, IncidentRecord)> {
    evs.iter()
        .filter_map(|(t, e)| match e {
            EngineEvent::SignalIncident { record } if record.kind == kind => Some((*t, record.clone())),
            _ => None,
        })
        .collect()
}
fn night_ctx(t_ms: u64) -> Context {
    Context { t_ms, away_from_home: true, hour_local: 1, activity: Activity::Walking, speed_mps: 1.3, ..Context::default() }
}
/// Trace with the given motion and a single walking context.
fn motion_trace(motion: Vec<MotionSample>, seed: u64) -> Trace {
    let mut tr = synth::trace(Scenario::Walk, 2, seed);
    tr.motion = motion;
    tr
}

// ---------------- stories ----------------

#[test]
fn story_a_walk_drift_fall_still_reaches_check_then_unlock() {
    let tr = synth::trace(Scenario::Fall, 12, 1);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let incident = tr.meta.incident_t_ms.unwrap();
    let check = first(&evs, is_check).expect("Check requested");
    let heads = first(&evs, is_heads_up).expect("HeadsUp");
    let unlock = first(&evs, is_unlock).expect("Unlock");
    assert!(check < heads && heads < unlock, "check {check} heads-up {heads} unlock {unlock}");
    // v1.1 timings: heads-up at the 90 s check deadline, unlock once 120 s passed with no response
    assert!((heads - check) >= 90_000 && (heads - check) < 93_000, "heads-up delay {}", heads - check);
    assert!((unlock - check) >= 120_000 && (unlock - check) < 125_000, "unlock delay {}", unlock - check);
    assert!(unlock - incident <= 8 * 60_000, "unlock delay {} s", (unlock - incident) / 1000);
    let snap = e.snapshot();
    assert_eq!(snap.escalation, EscalationLevel::Unlocked);
    assert_eq!(snap.risk_band, 3);
    assert!(snap.evidence.contains("fall") && snap.evidence.contains("no movement"), "{}", snap.evidence);
    // the incident log carries the sequence, and the unlock summary is its one-liner
    let drift = incidents(&evs, IncidentKind::GaitDrift);
    let impact = incidents(&evs, IncidentKind::Impact);
    let still = incidents(&evs, IncidentKind::Stillness);
    assert!(!drift.is_empty() && impact.len() == 1 && still.len() == 1, "{evs:?}");
    assert!(impact[0].1.t_ms.abs_diff(incident) < 1500);
    let unlock_summary = evs.iter().find_map(|(_, e)| if let EngineEvent::UnlockLocation { summary } = e { Some(summary.clone()) } else { None }).unwrap();
    assert!(unlock_summary.starts_with("Unsteady walking, then a hard fall"), "{unlock_summary}");
    // the sequence keeps growing after the unlock (stillness joins it)
    assert!(e.sequence_summary().unwrap().starts_with(&unlock_summary), "{:?}", e.sequence_summary());
    let log = e.incident_log();
    assert!(log.iter().all(|r| r.watched && r.sequence_id == log[0].sequence_id), "{log:?}");
    assert!(e.sequence_boost() >= 2.0);
}

#[test]
fn story_b_still_acceleration_stumble_walk_never_checks() {
    let tr = synth::trace(Scenario::Still, 15, 2);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    assert!(first(&evs, is_check).is_none(), "{evs:?}");
    assert!(e.snapshot().p_danger < 0.3, "{}", e.snapshot().p_danger);
    // a 2.4 g stumble is below the impact band and the person kept walking: no incident at all
    assert!(e.incident_log().is_empty(), "{:?}", e.incident_log());
}

#[test]
fn benign_scenarios_stay_quiet() {
    for (sc, seed) in [(Scenario::Walk, 3), (Scenario::Drunk, 4), (Scenario::Dance, 5), (Scenario::Drop, 6)] {
        let tr = synth::trace(sc, 8, seed);
        let mut e = engine();
        let evs = synth::replay(&mut e, &tr);
        assert!(first(&evs, is_check).is_none(), "{sc:?} false alarm: {evs:?}");
        if sc != Scenario::Drunk {
            assert!(incidents(&evs, IncidentKind::GaitDrift).is_empty(), "{sc:?} spurious gait drift");
        }
        assert!(incidents(&evs, IncidentKind::Impact).is_empty(), "{sc:?} spurious impact");
    }
}

#[test]
fn recovery_walking_after_fall_resolves_without_unlock() {
    let mut g = Gen::new(0, 9);
    g.walk(120.0, G_POCKET);
    g.fall(G_POCKET, 45.0);
    g.walk(420.0, G_POCKET);
    let tr = motion_trace(g.out, 9);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    assert!(first(&evs, is_unlock).is_none(), "{evs:?}");
    let snap = e.snapshot();
    assert!(snap.p_danger < 0.2, "p_danger {}", snap.p_danger);
    assert!(matches!(snap.escalation, EscalationLevel::Idle | EscalationLevel::Resolved), "{:?}", snap.escalation);
    // no stillness after the fall: the impact is logged alone
    assert!(incidents(&evs, IncidentKind::Stillness).is_empty());
}

#[test]
fn good_dismiss_resets_and_lowers_sensitivity() {
    let tr = synth::trace(Scenario::Fall, 12, 1);
    let mut e = engine();
    e.set_night_mode(true, 0);
    let mut dismissed_at = None;
    let mut t = 1000;
    let mut mi = 0;
    while t <= tr.motion.last().unwrap().t_ms {
        let s = mi;
        while mi < tr.motion.len() && tr.motion[mi].t_ms < t {
            mi += 1;
        }
        e.push_motion(tr.motion[s..mi].to_vec());
        for c in &tr.context {
            if c.t_ms + 1000 > t && c.t_ms < t {
                e.push_context(*c);
            }
        }
        for ev in e.tick(t) {
            match ev {
                EngineEvent::CheckRequested { phrase, .. } if dismissed_at.is_none() => {
                    // user types the phrase correctly at a normal pace
                    let n = phrase.len() as u64;
                    let sample = TypingSample {
                        phrase: phrase.clone(),
                        typed: phrase.clone(),
                        key_times_ms: (0..n).map(|i| i * 230).collect(),
                        backspaces: 0,
                        duration_ms: n * 230,
                    };
                    let v = e.push_typing(sample, t);
                    assert!(v.accepted, "{v:?}");
                    dismissed_at = Some(t);
                }
                EngineEvent::UnlockLocation { .. } => panic!("unlocked after a good dismiss"),
                EngineEvent::CheckRequested { .. } => panic!("re-checked inside the 30 min cooldown"),
                _ => {}
            }
        }
        t += 1000;
    }
    assert!(dismissed_at.is_some());
    let snap = e.snapshot();
    assert!(matches!(snap.escalation, EscalationLevel::Idle | EscalationLevel::Resolved));
    assert_eq!(e.sequence_boost(), 0.0, "a dismiss mutes the sequence boost");
}

#[test]
fn wrong_phrase_is_evidence_and_need_help_unlocks() {
    let mut e = engine();
    e.set_night_mode(true, 0);
    let mut g = Gen::new(0, 11);
    g.walk(60.0, G_POCKET);
    g.drunk_walk(120.0, G_POCKET);
    g.fall(G_POCKET, 50.0);
    let tr = motion_trace(g.out, 11);
    let evs = synth::replay(&mut e, &tr);
    let t0 = first(&evs, is_check).expect("check");
    let p_before = e.snapshot().p_danger;
    let post_before = e.posterior();
    e.push_action(UserAction::DismissWrongPhrase, t0 + 5_000);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Check);
    assert!(e.posterior()[0] < post_before[0], "wrong phrase did not count against Normal: {post_before:?} -> {:?}", e.posterior());
    assert!(e.snapshot().p_danger >= p_before - 0.02, "wrong phrase lowered p: {p_before} -> {} (t0={t0})", e.snapshot().p_danger);
    e.push_action(UserAction::NeedHelp, t0 + 30_000);
    let evs = e.tick(t0 + 31_000);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Unlocked);
    assert!(evs.is_empty() || !evs.iter().any(is_check));
}

#[test]
fn fall_vs_drop_discrimination_and_drop_resolves_on_pickup() {
    let cfg = Config::default_v1();
    let mut g = Gen::new(0, 21);
    g.walk(10.0, G_POCKET);
    g.fall(G_POCKET, 5.0);
    let mut det = ImpactDetector::new(&cfg.impact);
    let fall = g.out.iter().filter_map(|s| det.push(s)).next().expect("fall detected");
    assert_eq!(fall.kind, ImpactKind::Fall, "{fall:?}");
    assert!(fall.peak_g > 3.0 && fall.fall_likelihood >= 0.5 && fall.is_incident(&cfg.impact));

    let mut g = Gen::new(0, 22);
    g.walk(10.0, G_HAND);
    g.drop(5.0);
    let mut det = ImpactDetector::new(&cfg.impact);
    let drop = g.out.iter().filter_map(|s| det.push(s)).next().expect("drop detected");
    assert_eq!(drop.kind, ImpactKind::Drop, "{drop:?}");
    assert!(det.drop_active && !drop.is_incident(&cfg.impact));

    // through the engine: drop keeps stillness at zero, pickup clears it, nothing is logged
    let mut e = engine();
    e.set_night_mode(true, 0);
    let mut g = Gen::new(0, 23);
    g.walk(10.0, G_HAND);
    g.drop(200.0);
    e.push_motion(g.out.clone());
    e.tick(g.t_ms);
    assert!(e.drop_active());
    assert!(e.snapshot().p_danger < 0.2);
    assert!(e.incident_log().is_empty());
    g.pickup();
    g.walk(10.0, G_HAND);
    e.push_motion(g.out[(210.0 * 50.0) as usize..].to_vec());
    e.tick(g.t_ms);
    assert!(!e.drop_active());
}

// ---------------- v1.1: grab ----------------

#[test]
fn grab_heads_up_immediately_then_unlock_at_120s_unless_phone_unlocked() {
    let tr = synth::trace(Scenario::Snatch, 5, 31);
    let incident = tr.meta.incident_t_ms.unwrap();
    let mut no_actions = tr.clone();
    no_actions.actions.clear();
    let mut e = engine();
    let evs = synth::replay(&mut e, &no_actions);
    let t_snatch = first(&evs, |e| matches!(e, EngineEvent::SnatchDetected { .. })).expect("snatch");
    let t_heads = first(&evs, is_heads_up).expect("heads-up");
    let t_unlock = first(&evs, is_unlock).expect("unlock");
    assert!(t_snatch - incident < 20_000, "grab detection delay {}", t_snatch - incident);
    assert_eq!(t_heads, t_snatch, "heads-up is immediate");
    assert!(t_unlock >= t_snatch + 120_000 && t_unlock < t_snatch + 123_000, "unlock {} after grab {}", t_unlock - t_snatch, t_snatch);
    assert!(first(&evs, is_check).is_none(), "a grab never asks the victim to type a phrase");
    let grabs = incidents(&evs, IncidentKind::Grab);
    assert_eq!(grabs.len(), 1);
    assert!(grabs[0].1.watched && grabs[0].1.sequence_id > 0, "{:?}", grabs[0].1);
    assert!(incidents(&evs, IncidentKind::Impact).is_empty(), "the wrench out of the hand is not a fall");
    assert_eq!(e.snapshot().escalation, EscalationLevel::Unlocked);
    assert_eq!(e.snapshot().risk_band, 3);
    let heads_summary = evs.iter().find_map(|(_, e)| if let EngineEvent::HeadsUp { summary } = e { Some(summary.clone()) } else { None }).unwrap();
    assert_eq!(heads_summary, "Phone grabbed");

    // owner unlocks the phone 30 s after the grab: no unlock, episode resolved; DismissOk alone does not clear it
    let mut e = engine();
    let mut unlocked_by_owner = tr.clone();
    unlocked_by_owner.actions = vec![synth::TimedAction { t_ms: t_snatch + 30_000, action: UserAction::PhoneUnlocked }];
    let evs = synth::replay(&mut e, &unlocked_by_owner);
    assert!(first(&evs, is_heads_up).is_some());
    assert!(first(&evs, is_unlock).is_none(), "{evs:?}");
    assert!(matches!(e.snapshot().escalation, EscalationLevel::Idle | EscalationLevel::Resolved));

    let mut e = engine();
    let mut dismissed = tr.clone();
    dismissed.actions = vec![synth::TimedAction { t_ms: t_snatch + 30_000, action: UserAction::DismissOk }];
    let evs = synth::replay(&mut e, &dismissed);
    assert!(first(&evs, is_unlock).is_some(), "DismissOk must not clear a grab");

    // biometric dismiss clears it too (original snatch trace)
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let t = first(&evs, |e| matches!(e, EngineEvent::SnatchDetected { .. })).unwrap();
    assert!(tr.actions[0].t_ms > t);
    assert!(first(&evs, is_unlock).map(|u| u < tr.actions[0].t_ms).unwrap_or(true));
    assert!(matches!(e.snapshot().escalation, EscalationLevel::Idle | EscalationLevel::Resolved));
}

/// A 0.4 s jerk + rotation spike (not the 120 ms snatch fixture) followed by running is a Grab within
/// arm_window_s: the detector works on instantaneous per-sample values, never on held / persisted ones.
#[test]
fn grab_from_a_400ms_spike_then_running_fires_within_arm_window() {
    let cfg = Config::default_v1();
    let mut g = Gen::new(0, 141);
    g.walk(30.0, G_HAND);
    let spike_t = g.t_ms;
    g.grab_spike(0.4, 40.0);
    let mut tr = motion_trace(g.out, 141);
    tr.context = vec![
        Context { t_ms: 0, screen_on: true, last_touch_ms: 0, ..night_ctx(0) },
        Context { t_ms: spike_t + 3_000, activity: Activity::Running, speed_mps: 4.5, screen_on: true, ..night_ctx(spike_t + 3_000) },
    ];
    let mut e = engine();
    let mut jerk_seen_at = None;
    let evs = synth::replay_with(&mut e, &tr, &mut |t, e| {
        let m = e.metrics();
        let j = m.bands.iter().find(|b| b.name == "jerk").unwrap();
        let r = m.bands.iter().find(|b| b.name == "rotation").unwrap();
        if jerk_seen_at.is_none() && !j.in_band && !r.in_band {
            jerk_seen_at = Some(t);
        }
    });
    let grabs = incidents(&evs, IncidentKind::Grab);
    assert_eq!(grabs.len(), 1, "{evs:?}");
    let delay = grabs[0].1.t_ms.saturating_sub(spike_t);
    assert!(delay <= cfg.grab.arm_window_s as u64 * 1000, "grab confirmed {delay} ms after the spike");
    assert!(grabs[0].1.raw_json.contains("\"running\":true"), "{}", grabs[0].1.raw_json);
    assert_eq!(first(&evs, |e| matches!(e, EngineEvent::SnatchDetected { .. })), Some(grabs[0].0));
    // ... and the dashboard showed the spike out of band on the very tick that contained it
    assert_eq!(jerk_seen_at, Some(spike_t / 1000 * 1000 + 1000), "spike at {spike_t}");
}

// ---------------- v1.1: gait drift ----------------

#[test]
fn gait_drift_persistence_29s_quiet_31s_fires() {
    let cfg = Config::default_v1();
    // 1 s hops of out-of-band walking windows: 29 s of persistence stays quiet, 31 s fires
    let mut tr = DriftTracker::new();
    for i in 1..=29u64 {
        assert!(!tr.push_walking(&cfg.signals, 1.0, i * 1000, &["stride_cv"], 4.0), "fired at {} s", i);
    }
    assert!((tr.persist_s(1.0) - 29.0).abs() < 1e-3);
    let mut tr = DriftTracker::new();
    let mut fired_at = None;
    for i in 1..=31u64 {
        if tr.push_walking(&cfg.signals, 1.0, i * 1000, &["sway"], 3.0) {
            fired_at = Some(i);
            break;
        }
    }
    assert_eq!(fired_at, Some(30), "fires as soon as 30 s are covered");
    // an in-band walking window resets; a long non-walking gap resets; a short gap pauses
    let mut tr = DriftTracker::new();
    for i in 1..=20u64 {
        tr.push_walking(&cfg.signals, 1.0, i * 1000, &["sway"], 3.0);
    }
    tr.push_walking(&cfg.signals, 1.0, 21_000, &[], 0.0);
    assert_eq!(tr.persist_s(1.0), 0.0);
    for i in 1..=20u64 {
        tr.push_walking(&cfg.signals, 1.0, 100_000 + i * 1000, &["sway"], 3.0);
    }
    tr.push_walking(&cfg.signals, 1.0, 120_000 + 3_000, &["sway"], 3.0); // 3 s pause: still counting
    assert!(tr.persist_s(1.0) > 20.0);
    tr.push_walking(&cfg.signals, 1.0, 123_000 + 20_000, &["sway"], 3.0); // 20 s gap: restart
    assert!((tr.persist_s(1.0) - 1.0).abs() < 1e-3);

    // end to end: 20 s of drunk walking between steady walks is not an incident, 60 s is
    let mut g = Gen::new(0, 61);
    g.walk(60.0, G_POCKET);
    g.drunk_walk(20.0, G_POCKET);
    g.walk(60.0, G_POCKET);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 61));
    assert!(incidents(&evs, IncidentKind::GaitDrift).is_empty(), "{evs:?}");
    let mut g = Gen::new(0, 62);
    g.walk(60.0, G_POCKET);
    g.drunk_walk(60.0, G_POCKET);
    g.walk(30.0, G_POCKET);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 62));
    let d = incidents(&evs, IncidentKind::GaitDrift);
    assert_eq!(d.len(), 1, "{evs:?}");
    let r = &d[0].1;
    assert!(r.t_ms > 60_000 && r.t_ms < 120_000, "{r:?}");
    assert!(r.summary.starts_with("Unsteady walking"), "{}", r.summary);
    assert!(r.raw_json.contains("\"stride_cv\"") && r.raw_json.contains("\"wobble\""), "{}", r.raw_json);
    assert!(!r.watched && r.sequence_id == 0, "an isolated drift is not a sequence");
    assert_eq!(e.sequence_boost(), 0.0);
}

// ---------------- v1.1: low-rate mode & sampling policy ----------------

#[test]
fn low_rate_mode_ignores_gait_but_keeps_activity_stillness_and_coarse_impact() {
    // 10 Hz accel-only walking: no gait metrics, all bands in band, activity from the OS
    let tr = synth::decimate(&synth::trace(Scenario::Walk, 3, 71), 5);
    assert!(tr.motion.windows(2).all(|w| w[1].t_ms - w[0].t_ms == 100) && tr.motion.iter().all(|s| s.rx == 0.0));
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let f = e.last_features().expect("windows still computed");
    assert!(!f.full && !f.is_walking && (f.fs - 10.0).abs() < 0.5 && f.energy_rms > 0.1, "{f:?}");
    let m = e.metrics();
    assert!(!m.sampling_full);
    // gait + gyro bands are unavailable (value 0, in band, baseline mean/sd); peak_g is rate-independent
    // and stays live (the coarse impact path relies on it at 10 Hz too)
    for b in &m.bands {
        if b.name == "peak_g" {
            assert!(b.value > 1.0 && b.in_band, "{b:?}");
        } else {
            assert!(b.in_band && b.sd_distance == 0.0 && b.value == 0.0 && b.sd > 0.0, "{b:?}");
        }
    }
    assert!(m.evidence.contains("low-rate sampling: gait metrics paused"), "{}", m.evidence);
    assert_eq!(m.activity, Activity::Walking, "falls back to the OS activity");
    assert!(incidents(&evs, IncidentKind::GaitDrift).is_empty());
    assert!(e.snapshot().baseline_seconds == 0, "nothing is learned at 10 Hz");
    // ... even a 10 Hz drunk walk is not a gait-drift incident
    let tr = synth::decimate(&synth::trace(Scenario::Drunk, 3, 72), 5);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    assert!(incidents(&evs, IncidentKind::GaitDrift).is_empty(), "{evs:?}");
    // stillness is tracked at 10 Hz
    let tr = synth::decimate(&synth::trace(Scenario::Still, 4, 73), 5);
    let mut e = engine();
    let mut still_seen = false;
    synth::replay_with(&mut e, &tr, &mut |t, e| {
        if t == 120_000 {
            still_seen = e.metrics().activity == Activity::Stationary;
        }
    });
    assert!(still_seen);
    // coarse impact at 10 Hz: the fall is still an Impact incident, followed by Stillness, and unlocks
    let tr = synth::decimate(&synth::trace(Scenario::Fall, 12, 74), 5);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let imp = incidents(&evs, IncidentKind::Impact);
    assert_eq!(imp.len(), 1, "{evs:?}");
    assert!(imp[0].1.t_ms.abs_diff(tr.meta.incident_t_ms.unwrap()) < 1500);
    assert!(imp[0].1.raw_json.contains("\"orientation_change_deg\""));
    assert_eq!(incidents(&evs, IncidentKind::Stillness).len(), 1);
    assert!(first(&evs, is_unlock).is_some());
}

#[test]
fn sampling_mode_events_follow_home_hour_incident_and_learning() {
    let sampling = |evs: &[EngineEvent]| {
        evs.iter().find_map(|e| if let EngineEvent::SamplingRateChanged { hz, gyro } = e { Some((*hz, *gyro)) } else { None })
    };
    // first tick: at home by day => low rate, once
    let mut e = engine();
    e.push_context(Context { t_ms: 1000, hour_local: 12, ..Context::default() });
    assert_eq!(sampling(&e.tick(1000)), Some((10, false)));
    assert_eq!(sampling(&e.tick(2000)), None);
    // away from home at 22:00 => full
    e.push_context(Context { t_ms: 3000, hour_local: 22, away_from_home: true, ..Context::default() });
    assert_eq!(sampling(&e.tick(3000)), Some((50, true)));
    // away at 20:59 => low; at 05:59 => full; at 06:00 => low
    e.push_context(Context { t_ms: 4000, hour_local: 20, away_from_home: true, ..Context::default() });
    assert_eq!(sampling(&e.tick(4000)), Some((10, false)));
    e.push_context(Context { t_ms: 5000, hour_local: 5, away_from_home: true, ..Context::default() });
    assert_eq!(sampling(&e.tick(5000)), Some((50, true)));
    e.push_context(Context { t_ms: 6000, hour_local: 6, away_from_home: true, ..Context::default() });
    assert_eq!(sampling(&e.tick(6000)), Some((10, false)));
    // at home, late, but an incident happened: full for 30 min, then back to low
    let mut e = engine();
    e.set_night_mode(true, 0);
    e.push_context(Context { t_ms: 1000, hour_local: 1, away_from_home: false, sampling_full: true, ..Context::default() });
    assert_eq!(sampling(&e.tick(1000)), Some((10, false)));
    let mut g = Gen::new(2000, 75);
    g.walk(10.0, G_POCKET);
    g.fall(G_POCKET, 5.0);
    e.push_motion(g.out);
    let evs = e.tick(g.t_ms);
    assert_eq!(incidents(&evs.iter().map(|e| (0, e.clone())).collect::<Vec<_>>(), IncidentKind::Impact).len(), 1);
    assert_eq!(sampling(&evs), Some((50, true)));
    assert_eq!(sampling(&e.tick(g.t_ms + 29 * 60_000)), None);
    // (that 29-min tick also logs the Stillness incident, which re-arms the 30 min window)
    assert_eq!(sampling(&e.tick(g.t_ms + 31 * 60_000)), None);
    assert_eq!(sampling(&e.tick(g.t_ms + 60 * 60_000)), Some((10, false)));
    // by day, learning on, OS says walking, baseline untrusted => full so a baseline can be learned
    let mut e = engine();
    e.push_context(Context { t_ms: 1000, hour_local: 12, activity: Activity::Walking, ..Context::default() });
    assert_eq!(sampling(&e.tick(1000)), Some((50, true)));
    e.set_learning(false);
    assert_eq!(sampling(&e.tick(2000)), Some((10, false)));
}

// ---------------- v1.1: separation & stillness rules ----------------

#[test]
fn separated_fires_after_10_min_unless_heading_home() {
    let run = |dist: &dyn Fn(u64) -> f32| {
        let mut e = engine();
        e.set_night_mode(true, 0);
        let mut out = Vec::new();
        for s in 1..=12 * 60u64 {
            let t = s * 1000;
            e.push_context(Context { t_ms: t, separated: true, distance_home_m: dist(s), ..night_ctx(t) });
            out.extend(e.tick(t).into_iter().map(|ev| (t, ev)));
        }
        (incidents(&out, IncidentKind::Separated), e)
    };
    let (sep, e) = run(&|_| 1200.0);
    assert_eq!(sep.len(), 1, "{sep:?}");
    assert!(sep[0].0 >= 600_000 && sep[0].0 <= 602_000, "fired at {}", sep[0].0);
    assert!(sep[0].1.summary.contains("Separated"));
    assert!(e.incident_log().iter().any(|r| r.kind == IncidentKind::Separated));
    // unknown distance: still fires (not decreasing is the default)
    let (sep, _) = run(&|_| -1.0);
    assert_eq!(sep.len(), 1);
    // walking home: 1200 m shrinking to 300 m => heading home, no incident
    let (sep, _) = run(&|s| 1200.0 - (s as f32 * 1.3).min(900.0));
    assert!(sep.is_empty(), "{sep:?}");
    // moving away: fires
    let (sep, _) = run(&|s| 300.0 + s as f32 * 1.3);
    assert_eq!(sep.len(), 1);
    // separation ends before 10 min: nothing
    let mut e = engine();
    e.set_night_mode(true, 0);
    let mut out = Vec::new();
    for s in 1..=15 * 60u64 {
        let t = s * 1000;
        e.push_context(Context { t_ms: t, separated: s < 9 * 60, distance_home_m: 1000.0, ..night_ctx(t) });
        out.extend(e.tick(t).into_iter().map(|ev| (t, ev)));
    }
    assert!(incidents(&out, IncidentKind::Separated).is_empty());
}

#[test]
fn stillness_requires_no_touch_after_the_impact() {
    let tr = synth::trace(Scenario::Fall, 12, 81);
    let incident = tr.meta.incident_t_ms.unwrap();
    // untouched phone: stillness fires 3 min after the fall
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let still = incidents(&evs, IncidentKind::Stillness);
    assert_eq!(still.len(), 1, "{evs:?}");
    assert!(still[0].0 >= incident + 180_000 && still[0].0 < incident + 190_000, "stillness at {} vs fall {}", still[0].0, incident);
    assert!(still[0].1.raw_json.contains("\"stillness_s\""));
    // the person touches the phone 60 s after the fall (and keeps it still): no stillness incident, no unlock
    let mut touched = tr.clone();
    for s in 0..6 {
        let t = incident + 60_000 + s * 60_000;
        touched.context.push(Context { t_ms: t, activity: Activity::Stationary, last_touch_ms: t, ..night_ctx(t) });
    }
    touched.context.sort_by_key(|c| c.t_ms);
    let mut e = engine();
    let evs = synth::replay(&mut e, &touched);
    assert!(incidents(&evs, IncidentKind::Stillness).is_empty(), "{:?}", incidents(&evs, IncidentKind::Stillness));
    assert_eq!(incidents(&evs, IncidentKind::Impact).len(), 1);
    // the sequence stays "hard fall" only, and the touch counts as handling the phone for the HMM
    assert_eq!(e.sequence_summary().unwrap(), "Unsteady walking, then a hard fall");
    assert!(e.posterior()[3] < 0.5, "touched phone argues against Unresponsive: {:?}", e.posterior());
}

// ---------------- v1.1: sequence agent, log, call option ----------------

#[test]
fn sequence_agent_boosts_impact_then_stillness_and_prunes_isolated_gait_drift() {
    // Impact → Stillness: both watched, same sequence, boost = w_impact + w_stillness
    let cfg = Config::default_v1();
    let mut g = Gen::new(0, 91);
    g.walk(60.0, G_POCKET);
    g.fall(G_POCKET, 600.0);
    let mut e = engine();
    let tr = motion_trace(g.out, 91);
    let incident = 60_000;
    let mut boost_after_impact = None;
    let evs = synth::replay_with(&mut e, &tr, &mut |t, e| {
        if t == incident + 60_000 {
            boost_after_impact = Some(e.sequence_boost());
        }
    });
    assert!((boost_after_impact.unwrap() - cfg.sequence.w_impact).abs() < 1e-5, "{boost_after_impact:?}");
    assert_eq!(incidents(&evs, IncidentKind::Stillness).len(), 1);
    assert!((e.sequence_boost() - (cfg.sequence.w_impact + cfg.sequence.w_stillness)).abs() < 1e-5, "{}", e.sequence_boost());
    let log = e.incident_log();
    assert_eq!(log.len(), 2);
    assert!(log.iter().all(|r| r.watched && r.sequence_id == 1), "{log:?}");
    assert_eq!(e.sequence_summary().unwrap(), "Hard fall, then no movement for 3 min");
    assert!(first(&evs, is_unlock).is_some());

    // the boost really changes the forward transitions
    let h = safety_core::hmm::Hmm::new(&cfg.hmm, &cfg.emissions);
    let base = h.transition(&safety_core::hmm::ContextFlags::default());
    let boosted = h.transition(&safety_core::hmm::ContextFlags { sequence_boost: 2.0, ..Default::default() });
    assert!(boosted[1][2] > base[1][2] * 2.0, "Impaired→Incident {} vs {}", boosted[1][2], base[1][2]);
    assert!(boosted[0][1] > base[0][1]);

    // an isolated GaitDrift is removed after 20 quiet minutes
    let mut g = Gen::new(0, 92);
    g.walk(60.0, G_POCKET);
    g.drunk_walk(90.0, G_POCKET);
    g.still(22.0 * 60.0, synth::G_SITTING, 0.006);
    let mut e = engine();
    let mut len_at_10 = None;
    let evs = synth::replay_with(&mut e, &tr_with(g.out, 92), &mut |t, e| {
        if t == 10 * 60_000 {
            len_at_10 = Some(e.incident_log().len());
        }
    });
    assert_eq!(incidents(&evs, IncidentKind::GaitDrift).len(), 1);
    assert_eq!(len_at_10, Some(1), "still in the log 8 min later");
    assert!(e.incident_log().is_empty(), "{:?}", e.incident_log());
    assert_eq!(e.sequence_boost(), 0.0, "an isolated drift never boosts the HMM");
}

fn tr_with(motion: Vec<MotionSample>, seed: u64) -> Trace {
    let mut tr = motion_trace(motion, seed);
    tr.context.push(Context { t_ms: 155_000, activity: Activity::Stationary, speed_mps: 0.0, ..night_ctx(155_000) });
    tr
}

#[test]
fn incident_log_expires_and_roundtrips_through_the_blob() {
    let mut g = Gen::new(0, 101);
    g.walk(60.0, G_POCKET);
    g.fall(G_POCKET, 240.0);
    let mut e = engine();
    let tr = motion_trace(g.out, 101);
    let end = tr.motion.last().unwrap().t_ms;
    synth::replay(&mut e, &tr);
    let log = e.incident_log();
    assert_eq!(log.len(), 2, "{log:?}");
    assert!(log[0].kind == IncidentKind::Impact && log[1].kind == IncidentKind::Stillness, "newest last");
    let blob = e.export_baseline();
    // restart a minute later: same log, same ids and sequence
    let e2 = Engine::new(DEFAULT_TOML, Some(&blob), end + 60_000).unwrap();
    assert_eq!(e2.incident_log(), log);
    // restart 9 h later: expired
    let e3 = Engine::new(DEFAULT_TOML, Some(&blob), end + 9 * 3_600_000).unwrap();
    assert!(e3.incident_log().is_empty());
    // the live log expires on tick as well
    let mut e4 = Engine::new(DEFAULT_TOML, Some(&blob), end + 60_000).unwrap();
    e4.tick(end + 7 * 3_600_000);
    assert_eq!(e4.incident_log().len(), 2);
    e4.tick(end + 8 * 3_600_000 + 1000);
    assert!(e4.incident_log().is_empty());
    // the blob is still a baseline blob: typing + gait survive, and a v1 blob without a log loads
    assert!(Engine::new(DEFAULT_TOML, Some(b"not json"), 0).is_err());
    let v1 = br#"{"version":1,"gait":[],"typing":{"feats":[{"samples":[],"ewma":0,"ewvar":0,"n":0},{"samples":[],"ewma":0,"ewvar":0,"n":0},{"samples":[],"ewma":0,"ewvar":0,"n":0},{"samples":[],"ewma":0,"ewvar":0,"n":0},{"samples":[],"ewma":0,"ewvar":0,"n":0}],"n":0}}"#;
    assert!(Engine::new(DEFAULT_TOML, Some(v1), 0).is_ok());
}

#[test]
fn call_option_after_600s_without_response() {
    let tr = synth::trace(Scenario::Fall, 17, 111);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let check = first(&evs, is_check).expect("check");
    let unlock = first(&evs, is_unlock).expect("unlock");
    let calls: Vec<u64> = evs.iter().filter(|(_, e)| matches!(e, EngineEvent::CallOptionAvailable { .. })).map(|(t, _)| *t).collect();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(calls[0] >= check + 600_000 && calls[0] < check + 603_000, "call option at {} vs check {}", calls[0], check);
    assert!(calls[0] > unlock);
    if let Some((_, EngineEvent::CallOptionAvailable { summary })) = evs.iter().find(|(_, e)| matches!(e, EngineEvent::CallOptionAvailable { .. })) {
        assert!(summary.contains("no response for 10 min"), "{summary}");
    }
    // FriendMarkedSafe before 600 s: no call option
    let mut tr2 = tr.clone();
    tr2.actions.push(synth::TimedAction { t_ms: unlock + 30_000, action: UserAction::FriendMarkedSafe });
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr2);
    assert!(!evs.iter().any(|(_, e)| matches!(e, EngineEvent::CallOptionAvailable { .. })), "{evs:?}");
}

// ---------------- v1.1: baselines ----------------

#[test]
fn baseline_trusted_after_7_distinct_days_and_night_incidents_excluded() {
    const DAY: u64 = 86_400_000;
    let mut e = engine();
    e.set_learning(true);
    let walk_day = |e: &mut Engine, day: u64, secs: f32| {
        let t0 = day * DAY + 12 * 3_600_000;
        e.push_context(Context { t_ms: t0, activity: Activity::Walking, hour_local: 12, ..Context::default() });
        let mut g = Gen::new(t0, 200 + day);
        g.walk(secs, G_POCKET);
        e.push_motion(g.out);
        e.tick(g.t_ms);
    };
    for d in 0..6 {
        walk_day(&mut e, d, 60.0);
    }
    let m = e.metrics();
    assert!(!m.baseline_trusted && (m.baseline_walk_days - 6.0).abs() < 1e-3, "{m:?}");
    assert_eq!(m.placement, Placement::Pocket);
    // walking twice on the same day does not add a day
    walk_day(&mut e, 5, 60.0);
    assert!((e.metrics().baseline_walk_days - 6.0).abs() < 1e-3);
    walk_day(&mut e, 6, 60.0);
    let m = e.metrics();
    assert!(m.baseline_trusted && (m.baseline_walk_days - 7.0).abs() < 1e-3, "{m:?}");
    // trusted bands are personal: cadence mean near the synthetic 112 spm, floored sd, 2.5 SD band
    let cad = m.bands.iter().find(|b| b.name == "cadence").unwrap();
    assert!((cad.mean - 112.0).abs() < 3.0, "{cad:?}");
    assert!(cad.in_band && cad.sd_distance.abs() < 2.5);
    // rolling window: 14 days later only the recent days count
    for d in 20..24 {
        walk_day(&mut e, d, 60.0);
    }
    let m = e.metrics();
    assert!(!m.baseline_trusted && (m.baseline_walk_days - 4.0).abs() < 1e-3, "{m:?}");
    // survives the blob
    let blob = e.export_baseline();
    let e2 = Engine::new(DEFAULT_TOML, Some(&blob), 24 * DAY).unwrap();
    assert_eq!(e2.baseline().walk_days(Placement::Pocket), 4);

    // night sessions: walking during a night that produced an incident is dropped, a quiet night is kept
    let mut e = engine();
    let secs_before = e.snapshot().baseline_seconds;
    e.set_night_mode(true, 0);
    let tr = synth::trace(Scenario::Fall, 12, 121);
    synth::replay(&mut e, &tr);
    assert!(!e.incident_log().is_empty());
    assert!(e.baseline().pending_seconds() > 0.0, "night walking is buffered");
    e.set_night_mode(false, 13 * 60_000);
    assert_eq!(e.snapshot().baseline_seconds, secs_before, "incident night excluded");
    assert_eq!(e.baseline().pending_seconds(), 0.0);
    let mut e = engine();
    let tr = synth::trace(Scenario::Walk, 3, 122);
    synth::replay(&mut e, &tr);
    assert_eq!(e.snapshot().baseline_seconds, 0);
    e.set_night_mode(false, 4 * 60_000);
    assert!(e.snapshot().baseline_seconds >= 120, "quiet night committed: {}", e.snapshot().baseline_seconds);
}

// ---------------- signal-level ----------------

#[test]
fn gait_features_separate_walk_from_drunk_walk() {
    let cfg = Config::default_v1();
    let mut g = Gen::new(0, 41);
    g.walk(8.0, G_POCKET);
    let walk = compute_features(&cfg.gait, &g.out[100..400], true);
    let mut g = Gen::new(0, 42);
    g.drunk_walk(8.0, G_POCKET);
    let drunk = compute_features(&cfg.gait, &g.out[100..400], true);
    assert!(walk.is_walking && walk.full && walk.has_gyro, "{walk:?}");
    assert!((walk.cadence_spm - 112.0).abs() < 10.0, "{walk:?}");
    assert!(drunk.step_cv > walk.step_cv, "walk {walk:?} drunk {drunk:?}");
    assert!(drunk.sway_rms > walk.sway_rms);
    assert!(drunk.regularity < walk.regularity);
    assert!(drunk.wobble_dps > walk.wobble_dps * 2.0, "wobble walk {} drunk {}", walk.wobble_dps, drunk.wobble_dps);
    assert!(walk.jerk_peak > 0.0 && walk.rot_peak_dps > 0.0 && walk.peak_g > 1.1);
    let b = safety_core::baseline::Baseline::new();
    let zw = b.zscore(&cfg.baseline, Placement::Pocket, &walk);
    let zd = b.zscore(&cfg.baseline, Placement::Pocket, &drunk);
    assert!(zd.drift > zw.drift + 1.0, "walk z {} drunk z {}", zw.drift, zd.drift);
    let mut g = Gen::new(0, 43);
    g.still(8.0, synth::G_SITTING, 0.006);
    let still = compute_features(&cfg.gait, &g.out[100..400], true);
    assert!(!still.is_walking && still.energy_rms < cfg.gait.still_rms_g);
    let mut g = Gen::new(0, 44);
    g.dance(8.0);
    let dance = compute_features(&cfg.gait, &g.out[100..400], true);
    assert!(dance.agitation > 0.0 && !dance.is_walking, "{dance:?}");
    // rate awareness: the same window at 10 Hz is energy-only even when full rate is allowed
    let mut g = Gen::new(0, 45);
    g.walk(8.0, G_POCKET);
    let dec: Vec<MotionSample> = g.out.iter().step_by(5).copied().collect();
    let low = compute_features(&cfg.gait, &dec[20..80], true);
    assert!(!low.full && (low.fs - 10.0).abs() < 0.5 && low.energy_rms > 0.1 && low.steps == 0, "{low:?}");
}

#[test]
fn baseline_learns_while_walking_by_day_and_roundtrips_through_blob() {
    let mut e = engine();
    e.set_learning(true);
    e.push_context(Context { t_ms: 0, activity: Activity::Walking, hour_local: 14, ..Context::default() });
    let mut g = Gen::new(0, 51);
    g.walk(180.0, G_POCKET);
    e.push_motion(g.out);
    e.tick(181_000);
    let snap = e.snapshot();
    assert!(snap.baseline_seconds >= 120, "learned {}", snap.baseline_seconds);
    assert_eq!(snap.placement, Placement::Pocket);
    assert_eq!(e.metrics().baseline_walk_days, 1.0);
    let blob = e.export_baseline();
    let e2 = Engine::new(DEFAULT_TOML, Some(&blob), 0).unwrap();
    assert_eq!(e2.snapshot().baseline_seconds, snap.baseline_seconds);
    assert!(Engine::new(DEFAULT_TOML, Some(b"not json"), 0).is_err());
    // no committed learning in night mode (buffered until the session ends)
    let mut e3 = engine();
    e3.set_night_mode(true, 0);
    e3.push_context(Context { t_ms: 0, activity: Activity::Walking, ..Context::default() });
    let mut g = Gen::new(0, 52);
    g.walk(60.0, G_POCKET);
    e3.push_motion(g.out);
    e3.tick(61_000);
    assert_eq!(e3.snapshot().baseline_seconds, 0);
}

#[test]
fn battery_dying_and_location_interval_events() {
    let mut e = engine();
    e.set_night_mode(true, 0);
    let evs = e.tick(1000);
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::LocationIntervalChanged { seconds: 300 })));
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::SamplingRateChanged { .. })), "sampling mode announced at the first tick");
    e.push_context(Context { t_ms: 2000, battery_pct: 3, ..Context::default() });
    let evs = e.tick(2000);
    assert!(evs.contains(&EngineEvent::BatteryDying));
    assert!(!e.tick(3000).contains(&EngineEvent::BatteryDying));
}

#[test]
fn typing_far_off_baseline_logs_typing_off_incident() {
    let mut e = engine();
    let mut g = Gen::new(0, 131);
    g.walk(60.0, G_POCKET);
    g.drunk_walk(120.0, G_POCKET);
    g.fall(G_POCKET, 50.0);
    let tr = motion_trace(g.out, 131);
    let evs = synth::replay(&mut e, &tr);
    let t0 = first(&evs, is_check).expect("check");
    let phrase = e.check_phrase().to_string();
    let n = phrase.len() as u64;
    let slow = TypingSample { phrase: phrase.clone(), typed: phrase, key_times_ms: (0..n).map(|i| i * 900).collect(), backspaces: 6, duration_ms: n * 900 };
    let v = e.push_typing(slow, t0 + 20_000);
    assert!(!v.accepted && v.reason.contains("far off"), "{v:?}");
    let log = e.incident_log();
    let off = log.iter().find(|r| r.kind == IncidentKind::TypingOff).expect("typing off logged");
    assert!(off.sd_distance > 2.5 && off.raw_json.contains("\"z\""), "{off:?}");
}

// ---------------- live metrics (dashboard) ----------------

#[test]
fn live_metrics_update_every_second_and_are_never_stale() {
    let cfg = Config::default_v1();
    assert!((cfg.gait.hop_s - 1.0).abs() < 1e-6);
    // walk 20 s, stand still 20 s, walk again: cadence / activity follow within a tick of each window
    let mut g = Gen::new(0, 151);
    g.walk(20.0, G_POCKET);
    g.still(20.0, G_POCKET, 0.006);
    g.walk(20.0, G_POCKET);
    let tr = motion_trace(g.out, 151);
    let mut e = engine();
    let mut cad = Vec::new();
    synth::replay_with(&mut e, &tr, &mut |t, e| {
        let m = e.metrics();
        assert_eq!(m.t_ms, t);
        let c = m.bands.iter().find(|b| b.name == "cadence").unwrap().value;
        cad.push((t, c, m.activity));
    });
    let at = |t: u64| cad.iter().find(|(x, _, _)| *x == t).unwrap();
    // the first full window closes at 6 s; before that activity still comes from the fresh 1 s block / OS
    assert!(at(2_000).1 == 0.0 && at(2_000).2 == Activity::Walking, "{:?}", at(2_000));
    assert!(at(10_000).1 > 100.0 && at(10_000).2 == Activity::Walking, "{:?}", at(10_000));
    // standing still: cadence 0 and stationary once the 6 s window has emptied of steps
    assert!(at(28_000).1 == 0.0 && at(28_000).2 == Activity::Stationary, "{:?}", at(28_000));
    // the window refills with walking: walking again by 47 s
    assert!(at(48_000).1 > 100.0 && at(48_000).2 == Activity::Walking, "{:?}", at(48_000));
    // 1 s hop: cadence value changes (or is re-evaluated) at consecutive ticks, never held for 2 s pairs only
    let walking: Vec<f32> = cad.iter().filter(|(t, _, _)| *t >= 8_000 && *t <= 18_000).map(|(_, c, _)| *c).collect();
    assert!(walking.windows(2).filter(|w| w[0] != w[1]).count() >= walking.len() / 2, "{walking:?}");
    // a fresh engine with no window yet still reports all eight bands with baseline mean/sd
    let e = engine();
    let m = e.metrics();
    assert_eq!(m.bands.len(), 8);
    assert!(m.bands.iter().all(|b| b.in_band && b.sd > 0.0 && b.value == 0.0));
}

#[test]
fn spike_metrics_show_within_a_second_and_hold_for_spike_hold_s() {
    let cfg = Config::default_v1();
    let hold = cfg.signals.spike_hold_s as u64;
    // standing still, one 0.3 s jerk + spin burst at 10 s, still again
    let mut g = Gen::new(0, 161);
    g.still(10.0, G_HAND, 0.006);
    let spike_t = g.t_ms;
    g.grab_spike(0.3, 0.0);
    g.still(20.0, G_HAND, 0.006);
    let mut tr = motion_trace(g.out, 161);
    tr.context = vec![Context { t_ms: 0, activity: Activity::Stationary, speed_mps: 0.0, ..night_ctx(0) }];
    let mut e = engine();
    let mut out: Vec<(u64, Vec<MetricBand>)> = Vec::new();
    let evs = synth::replay_with(&mut e, &tr, &mut |t, e| out.push((t, e.metrics().bands.clone())));
    let band = |t: u64, name: &str| out.iter().find(|(x, _)| *x == t).unwrap().1.iter().find(|b| b.name == name).unwrap().clone();
    let first_tick = spike_t / 1000 * 1000 + 1000;
    // before: quiet, in band
    for n in ["jerk", "rotation", "peak_g"] {
        assert!(band(first_tick - 1000, n).in_band, "{:?}", band(first_tick - 1000, n));
    }
    // the tick containing the spike: all three spike metrics out of band, values are the spike's
    let j = band(first_tick, "jerk");
    let r = band(first_tick, "rotation");
    let p = band(first_tick, "peak_g");
    assert!(!j.in_band && j.value > cfg.grab.jerk_g_per_s && j.sd_distance > cfg.signals.band_sd_untrusted, "{j:?}");
    assert!(!r.in_band && r.value > cfg.grab.rotation_deg_per_s, "{r:?}");
    assert!(!p.in_band && p.value > 2.5, "{p:?}");
    // held (same value, still out of band) until spike_hold_s after the spike block, then released
    let last_spike_sample = spike_t + 280;
    for t in (first_tick + 1000..first_tick + 12_000).step_by(1000) {
        let j = band(t, "jerk");
        if t <= last_spike_sample + hold * 1000 {
            assert!(!j.in_band && (j.value - band(first_tick, "jerk").value).abs() < 1e-3, "held at {t}: {j:?}");
        } else {
            assert!(j.in_band && j.value < 5.0, "released at {t}: {j:?}");
            assert!(band(t, "peak_g").in_band && band(t, "rotation").in_band);
        }
    }
    // detection is untouched by the hold: not in hand (no touch, screen off) and no running => no grab,
    // no impact (orientation change without a hard enough peak pattern is not a fall)
    assert!(incidents(&evs, IncidentKind::Grab).is_empty(), "{evs:?}");
}

#[test]
fn gait_drift_builds_visibly_in_metrics_before_the_incident_fires() {
    let mut g = Gen::new(0, 171);
    g.walk(30.0, G_POCKET);
    let drunk_t = g.t_ms;
    g.drunk_walk(60.0, G_POCKET);
    let tr = motion_trace(g.out, 171);
    let mut e = engine();
    let mut seen: Vec<(u64, String, bool, f32)> = Vec::new();
    let evs = synth::replay_with(&mut e, &tr, &mut |t, e| {
        let m = e.metrics();
        let oob = m.bands.iter().filter(|b| !b.in_band).map(|b| b.name.clone()).collect::<Vec<_>>().join(",");
        seen.push((t, m.evidence.clone(), !oob.is_empty(), m.p_impaired));
    });
    let drift = incidents(&evs, IncidentKind::GaitDrift);
    assert_eq!(drift.len(), 1, "{evs:?}");
    let fire_t = drift[0].0;
    assert!(fire_t >= drunk_t + 30_000 && fire_t <= drunk_t + 45_000, "fired at {fire_t}, drunk from {drunk_t}");
    // long before the 30 s persistence is met, the bands are already out and the evidence counts up
    let building: Vec<&(u64, String, bool, f32)> = seen.iter().filter(|(t, _, _, _)| *t > drunk_t + 10_000 && *t < fire_t).collect();
    assert!(building.iter().filter(|(_, _, oob, _)| *oob).count() >= building.len() * 2 / 3, "{building:?}");
    let with_text: Vec<&&(u64, String, bool, f32)> = building.iter().filter(|(_, ev, _, _)| ev.contains("out of band for")).collect();
    assert!(with_text.len() >= building.len() / 2, "{building:?}");
    // the counter is in seconds of walking and grows between ticks
    let secs = |ev: &str| ev.split("out of band for ").nth(1).and_then(|r| r.split(' ').next()).and_then(|n| n.parse::<f32>().ok());
    let a = secs(&with_text[0].1).unwrap();
    let b = secs(&with_text[with_text.len() - 1].1).unwrap();
    assert!(b > a + 5.0 && b < 45.0, "{a} -> {b}");
    // the HMM reacts on the incident tick itself, not at the next 60 s step
    let before = seen.iter().find(|(t, _, _, _)| *t == fire_t - 1000).unwrap().3;
    let after = seen.iter().find(|(t, _, _, _)| *t == fire_t).unwrap().3;
    assert!(after > before + 0.05, "p_impaired {before} -> {after} on the GaitDrift tick");
    assert!(drift[0].1.summary.contains("for 30 s") || drift[0].1.summary.contains("for 31 s"), "{}", drift[0].1.summary);
}

#[test]
fn hmm_steps_immediately_on_grab_separated_and_stillness_incidents() {
    // grab: the snatch trace; the HMM steps on the tick the Grab is logged and the posterior moves
    // (the grab sequence boost raises the forward transitions)
    let tr = synth::trace(Scenario::Snatch, 3, 181);
    let mut e = engine();
    let mut p: Vec<(u64, [f32; 4], u64)> = Vec::new();
    let evs = synth::replay_with(&mut e, &tr, &mut |t, e| p.push((t, e.posterior(), e.last_hmm_step_ms())));
    let grab_t = incidents(&evs, IncidentKind::Grab)[0].0;
    let at = |t: u64| p.iter().find(|(x, _, _)| *x == t).unwrap();
    let (b, a) = (at(grab_t - 1000), at(grab_t));
    assert_ne!(grab_t % 60_000, 0, "test needs an off-schedule grab tick");
    assert_eq!(a.2, grab_t, "HMM stepped on the grab tick (previous step {})", b.2);
    assert!(a.1[0] < b.1[0] - 0.005, "P(Normal) {:?} -> {:?} on the grab tick", b.1, a.1);

    // separated (context only): the step runs on the incident tick even though an isolated separation
    // carries no sequence boost, so the posterior itself barely moves
    let mut e = engine();
    e.set_night_mode(true, 0);
    let mut stepped_on_incident = None;
    for s in 1..=11 * 60u64 {
        let t = s * 1000;
        e.push_context(Context { t_ms: t, separated: true, distance_home_m: 900.0, ..night_ctx(t) });
        let before = e.last_hmm_step_ms();
        let evs = e.tick(t);
        if evs.iter().any(|e| matches!(e, EngineEvent::SignalIncident { record } if record.kind == IncidentKind::Separated)) {
            assert_ne!(t % 60_000, 0);
            assert!(before < t && e.last_hmm_step_ms() == t, "separated at {t}: steps {before} -> {}", e.last_hmm_step_ms());
            stepped_on_incident = Some(t);
        }
    }
    assert!(stepped_on_incident.is_some());

    // stillness after a fall: the Stillness incident tick is an HMM step (the posterior is already saturated
    // by the fall + the earlier stillness buckets, so only the timing is asserted)
    let tr = synth::trace(Scenario::Fall, 8, 182);
    let mut e = engine();
    let mut p: Vec<(u64, [f32; 4], u64)> = Vec::new();
    let evs = synth::replay_with(&mut e, &tr, &mut |t, e| p.push((t, e.posterior(), e.last_hmm_step_ms())));
    let still_t = incidents(&evs, IncidentKind::Stillness)[0].0;
    let at = |t: u64| p.iter().find(|(x, _, _)| *x == t).unwrap();
    let (b, a) = (at(still_t - 1000), at(still_t));
    assert_eq!(a.2, still_t, "stepped on the stillness tick (previous {})", b.2);
    assert!(b.2 < still_t && a.1[2] + a.1[3] > 0.9, "{:?} -> {:?}", b.1, a.1);
}
