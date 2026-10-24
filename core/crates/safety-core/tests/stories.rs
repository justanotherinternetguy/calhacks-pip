//! Golden stories and end-to-end behaviour through `Engine`.
use safety_core::config::DEFAULT_TOML;
use safety_core::signal::{gait::compute_features, ImpactDetector, ImpactKind};
use safety_core::synth::{self, Gen, Scenario, G_HAND, G_POCKET};
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

#[test]
fn story_a_walk_drift_fall_still_reaches_check_then_unlock() {
    let tr = synth::trace(Scenario::Fall, 12, 1);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let incident = tr.meta.incident_t_ms.unwrap();
    let check = first(&evs, is_check).expect("Check requested");
    let unlock = first(&evs, is_unlock).expect("Unlock");
    assert!(check < unlock, "check {check} before unlock {unlock}");
    assert!(unlock - incident <= 8 * 60_000, "unlock delay {} s", (unlock - incident) / 1000);
    assert!(evs.iter().any(|(_, e)| matches!(e, EngineEvent::HeadsUp { .. })));
    let snap = e.snapshot();
    assert_eq!(snap.escalation, EscalationLevel::Unlocked);
    assert_eq!(snap.risk_band, 3);
    assert!(snap.evidence.contains("fall") && snap.evidence.contains("no movement"), "{}", snap.evidence);
}

#[test]
fn story_b_still_acceleration_stumble_walk_never_checks() {
    let tr = synth::trace(Scenario::Still, 15, 2);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    assert!(first(&evs, is_check).is_none(), "{evs:?}");
    assert!(e.snapshot().p_danger < 0.3, "{}", e.snapshot().p_danger);
}

#[test]
fn benign_scenarios_stay_quiet() {
    for (sc, seed) in [(Scenario::Walk, 3), (Scenario::Drunk, 4), (Scenario::Dance, 5), (Scenario::Drop, 6)] {
        let tr = synth::trace(sc, 8, seed);
        let mut e = engine();
        let evs = synth::replay(&mut e, &tr);
        assert!(first(&evs, is_check).is_none(), "{sc:?} false alarm: {evs:?}");
    }
}

#[test]
fn recovery_walking_after_fall_resolves_without_unlock() {
    let mut g = Gen::new(0, 9);
    g.walk(120.0, G_POCKET);
    g.fall(G_POCKET, 45.0);
    g.walk(420.0, G_POCKET);
    let mut tr = synth::trace(Scenario::Walk, 2, 9);
    tr.motion = g.out;
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    assert!(first(&evs, is_unlock).is_none(), "{evs:?}");
    let snap = e.snapshot();
    assert!(snap.p_danger < 0.2, "p_danger {}", snap.p_danger);
    assert!(matches!(snap.escalation, EscalationLevel::Idle | EscalationLevel::Resolved), "{:?}", snap.escalation);
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
}

#[test]
fn wrong_phrase_is_evidence_and_need_help_unlocks() {
    let mut e = engine();
    e.set_night_mode(true, 0);
    let mut g = Gen::new(0, 11);
    g.walk(60.0, G_POCKET);
    g.drunk_walk(120.0, G_POCKET);
    g.fall(G_POCKET, 50.0);
    let mut tr = synth::trace(Scenario::Walk, 2, 11);
    tr.motion = g.out;
    let evs = synth::replay(&mut e, &tr);
    let t0 = first(&evs, is_check).expect("check");
    let p_before = e.snapshot().p_danger;
    let post_before = e.posterior();
    e.push_action(UserAction::DismissWrongPhrase, t0 + 5_000);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Check);
    // evidence, not a dismiss: mass leaves Normal and the danger estimate holds (no reset toward Normal)
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
    assert!(fall.peak_g > 3.0 && fall.fall_likelihood >= 0.5);

    let mut g = Gen::new(0, 22);
    g.walk(10.0, G_HAND);
    g.drop(5.0);
    let mut det = ImpactDetector::new(&cfg.impact);
    let drop = g.out.iter().filter_map(|s| det.push(s)).next().expect("drop detected");
    assert_eq!(drop.kind, ImpactKind::Drop, "{drop:?}");
    assert!(det.drop_active);

    // through the engine: drop keeps stillness at zero, pickup clears it
    let mut e = engine();
    e.set_night_mode(true, 0);
    let mut g = Gen::new(0, 23);
    g.walk(10.0, G_HAND);
    g.drop(200.0);
    e.push_motion(g.out.clone());
    e.tick(g.t_ms);
    assert!(e.drop_active());
    assert!(e.snapshot().p_danger < 0.2);
    g.pickup();
    g.walk(10.0, G_HAND);
    e.push_motion(g.out[(210.0 * 50.0) as usize..].to_vec());
    e.tick(g.t_ms);
    assert!(!e.drop_active());
}

#[test]
fn snatch_detected_only_biometric_clears() {
    let tr = synth::trace(Scenario::Snatch, 2, 31);
    let mut e = engine();
    let mut tr_no_actions = tr.clone();
    tr_no_actions.actions.clear();
    let evs = synth::replay(&mut e, &tr_no_actions);
    let t = first(&evs, |e| matches!(e, EngineEvent::SnatchDetected { .. })).expect("snatch");
    assert!(t - tr.meta.incident_t_ms.unwrap() < 20_000);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Snatch);
    assert_eq!(e.snapshot().risk_band, 3);
    e.push_action(UserAction::DismissOk, t + 1000);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Snatch);
    e.push_action(UserAction::BiometricDismiss, t + 2000);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Resolved);
}

#[test]
fn gait_features_separate_walk_from_drunk_walk() {
    let cfg = Config::default_v1();
    let mut g = Gen::new(0, 41);
    g.walk(8.0, G_POCKET);
    let walk = compute_features(&cfg.gait, &g.out[100..400]);
    let mut g = Gen::new(0, 42);
    g.drunk_walk(8.0, G_POCKET);
    let drunk = compute_features(&cfg.gait, &g.out[100..400]);
    assert!(walk.is_walking, "{walk:?}");
    assert!((walk.cadence_spm - 112.0).abs() < 10.0, "{walk:?}");
    assert!(drunk.step_cv > walk.step_cv, "walk {walk:?} drunk {drunk:?}");
    assert!(drunk.sway_rms > walk.sway_rms);
    assert!(drunk.regularity < walk.regularity);
    let b = safety_core::baseline::Baseline::new();
    let zw = b.zscore(&cfg.baseline, Placement::Pocket, &walk);
    let zd = b.zscore(&cfg.baseline, Placement::Pocket, &drunk);
    assert!(zd.drift > zw.drift + 1.0, "walk z {} drunk z {}", zw.drift, zd.drift);
    let mut g = Gen::new(0, 43);
    g.still(8.0, synth::G_SITTING, 0.006);
    let still = compute_features(&cfg.gait, &g.out[100..400]);
    assert!(!still.is_walking && still.energy_rms < cfg.gait.still_rms_g);
    let mut g = Gen::new(0, 44);
    g.dance(8.0);
    let dance = compute_features(&cfg.gait, &g.out[100..400]);
    assert!(dance.agitation > 0.0 && !dance.is_walking, "{dance:?}");
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
    let blob = e.export_baseline();
    let e2 = Engine::new(DEFAULT_TOML, Some(&blob), 0).unwrap();
    assert_eq!(e2.snapshot().baseline_seconds, snap.baseline_seconds);
    assert!(Engine::new(DEFAULT_TOML, Some(b"not json"), 0).is_err());
    // no learning in night mode
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
    e.push_context(Context { t_ms: 2000, battery_pct: 3, ..Context::default() });
    let evs = e.tick(2000);
    assert!(evs.contains(&EngineEvent::BatteryDying));
    assert!(!e.tick(3000).contains(&EngineEvent::BatteryDying));
}
