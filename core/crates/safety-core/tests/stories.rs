//! Golden stories and end-to-end behaviour through `Engine` (rule-based incidents, model v2).
use safety_core::config::DEFAULT_TOML;
use safety_core::signal::{gait::compute_features, ImpactDetector, ImpactKind};
use safety_core::synth::{self, Gen, Scenario, Trace, G_FLAT, G_HAND, G_POCKET};
use safety_core::*;

/// Escalation stories run with automatic escalation on, a 2-minute "down after fall" and no lone-incident check-ins
/// (`check_alone = []`), so each story exercises the Danger / two-family rules on their own. The bundled default
/// (5 s down timer, possible fall / hard impact / scream ask on their own) is covered by `default_config_*` and
/// `lone_*`.
fn engine() -> Engine {
    Engine::new("[thresholds]\nauto_escalate = true\n[incidents]\ndown_after_fall_s = 120\ncheck_alone = []\n", None, 0).unwrap()
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
fn cleared(evs: &[(u64, EngineEvent)], kind: IncidentKind) -> Vec<(u64, IncidentRecord)> {
    evs.iter()
        .filter_map(|(t, e)| match e {
            EngineEvent::IncidentCleared { record } if record.kind == kind => Some((*t, record.clone())),
            _ => None,
        })
        .collect()
}
fn kinds(evs: &[(u64, EngineEvent)]) -> Vec<IncidentKind> {
    evs.iter().filter_map(|(_, e)| if let EngineEvent::SignalIncident { record } = e { Some(record.kind) } else { None }).collect()
}
fn summary_of(evs: &[(u64, EngineEvent)], f: fn(&EngineEvent) -> Option<&String>) -> String {
    evs.iter().find_map(|(_, e)| f(e)).cloned().unwrap_or_default()
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
/// Run per-second ticks over `secs` with a context per second; returns (t, event) pairs.
fn run_ctx(e: &mut Engine, from_s: u64, secs: u64, ctx: &dyn Fn(u64) -> Context) -> Vec<(u64, EngineEvent)> {
    let mut out = Vec::new();
    for s in from_s..from_s + secs {
        let t = s * 1000;
        e.push_context(ctx(t));
        out.extend(e.tick(t).into_iter().map(|ev| (t, ev)));
    }
    out
}

// ---------------- stories ----------------

/// Story A: walking, then unsteady (gait family), then a fall (fall family): two independent kinds of evidence ask
/// "You okay?" right after the fall. Lying still turns it into "down after fall"; no answer ⇒ heads-up at the deadline,
/// location 2 min later.
#[test]
fn story_a_unsteady_walk_then_fall_checks_at_once_then_unlocks() {
    let tr = synth::trace(Scenario::Fall, 12, 1);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let fall = tr.meta.incident_t_ms.unwrap();
    let unsteady = incidents(&evs, IncidentKind::UnsteadyGait);
    let possible = incidents(&evs, IncidentKind::PossibleFall);
    let down = incidents(&evs, IncidentKind::DownAfterFall);
    assert_eq!(unsteady.len(), 1, "{:?}", kinds(&evs));
    assert!(unsteady[0].0 < fall);
    assert_eq!(possible.len(), 1, "{:?}", kinds(&evs));
    assert!(possible[0].1.t_ms.abs_diff(fall) < 1500 && possible[0].1.tier == IncidentTier::Watch);
    let check = first(&evs, is_check).expect("check");
    // the high-g warning (fall family) opens the moment the peak is sensed: with the unsteady gait that is two families
    let onset = incidents(&evs, IncidentKind::HardImpact);
    assert_eq!(onset.len(), 1, "{:?}", kinds(&evs));
    assert!(onset[0].1.t_ms.abs_diff(fall) < 500 && onset[0].0 < possible[0].0, "warning before the classification");
    assert_eq!(cleared(&evs, IncidentKind::HardImpact)[0].0, possible[0].0, "replaced by the PossibleFall");
    assert_eq!(check, onset[0].0, "check at the high-g warning");
    assert_eq!(down.len(), 1);
    assert!(down[0].0 >= fall + 120_000 && down[0].0 < fall + 126_000, "down at {} vs fall {fall}", down[0].0);
    let heads = first(&evs, is_heads_up).expect("heads-up");
    let unlock = first(&evs, is_unlock).expect("unlock");
    assert_eq!(heads - check, 120_000, "heads-up at the 2 min deadline");
    assert_eq!(unlock - check, 240_000, "location 2 min after the heads-up");
    assert_eq!(incidents(&evs, IncidentKind::CheckInMissed).len(), 1);
    let snap = e.snapshot();
    assert_eq!(snap.escalation, EscalationLevel::Unlocked);
    assert!(snap.sensing_full && snap.listening);
    assert!(snap.sensing_full && snap.listening);
    let s = summary_of(&evs, |e| if let EngineEvent::UnlockLocation { summary } = e { Some(summary) } else { None });
    assert!(s.contains("nsteady walking") && s.contains("a hard fall") && s.contains("down for 2 min"), "{s}");
    assert!(s.find("a hard fall") < s.find("down for 2 min"), "in order: {s}");
    // every incident of the night belongs to the episode
    assert!(e.incident_log().iter().all(|r| r.watched && r.sequence_id == 1), "{:?}", e.incident_log());
}

const LOG_ONLY: &str = "[thresholds]\nauto_escalate = false\n";

/// `auto_escalate = false` logs incidents only: the same night as story A logs everything, but never checks or alerts.
#[test]
fn log_only_config_logs_incidents_without_escalating() {
    let tr = synth::trace(Scenario::Fall, 12, 1);
    let mut e = Engine::new(LOG_ONLY, None, 0).unwrap();
    let evs = synth::replay(&mut e, &tr);
    for k in [IncidentKind::UnsteadyGait, IncidentKind::PossibleFall, IncidentKind::DownAfterFall] {
        assert_eq!(incidents(&evs, k).len(), 1, "{k:?}: {:?}", kinds(&evs));
    }
    assert!(!evs.iter().any(|(_, e)| matches!(e, EngineEvent::CheckRequested { .. } | EngineEvent::HeadsUp { .. } | EngineEvent::UnlockLocation { .. })));
    assert!(incidents(&evs, IncidentKind::CheckInMissed).is_empty());
    let s = e.snapshot();
    assert_eq!(s.escalation, EscalationLevel::Idle);
    assert!(s.sensing_full);
    // a grab is logged, not alerted
    let mut e = Engine::new(LOG_ONLY, None, 0).unwrap();
    let mut tr = synth::trace(Scenario::Snatch, 3, 31);
    tr.actions.clear();
    let evs = synth::replay(&mut e, &tr);
    assert_eq!(incidents(&evs, IncidentKind::Grab).len(), 1);
    assert!(!evs.iter().any(|(_, e)| matches!(e, EngineEvent::SnatchDetected { .. } | EngineEvent::HeadsUp { .. } | EngineEvent::UnlockLocation { .. })));
    // manual SOS still unlocks
    e.push_action(UserAction::ManualSos, 200_000);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Unlocked);
}

/// The bundled default escalates, and a possible fall asks "You okay?" on its own 5 s after it opened, without
/// waiting for "down after fall" or a second family. The check says what it is about.
#[test]
fn default_config_asks_after_a_lone_possible_fall() {
    let mut g = Gen::new(0, 201);
    g.walk(60.0, G_POCKET);
    g.fall(G_POCKET, 30.0);
    let mut e = Engine::new(DEFAULT_TOML, None, 0).unwrap();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 201));
    let fall = incidents(&evs, IncidentKind::PossibleFall);
    assert_eq!(fall.len(), 1, "{:?}", kinds(&evs));
    let (t_check, ev) = evs.iter().find(|(_, e)| is_check(e)).expect("a lone possible fall asks").clone();
    let opened = fall[0].1.t_ms;
    assert!(t_check >= opened + 5_000 && t_check < opened + 7_000, "check {} ms after the fall", t_check - opened);
    match ev {
        EngineEvent::CheckRequested { summary, phrase, .. } => {
            assert!(summary.to_lowercase().contains("fall"), "summary: {summary}");
            assert_eq!(phrase.split(' ').count(), 3);
        }
        _ => unreachable!(),
    }
}

/// Demo config: a red (Danger) incident unlocks the location the moment it opens (no check-in deadline), and a
/// new check-in may follow 15 s after the last one.
#[test]
fn demo_config_unlocks_on_a_red_incident_at_once() {
    let demo = include_str!("../../../config/model-demo.toml");
    let mut g = Gen::new(0, 203);
    g.walk(60.0, G_POCKET);
    g.fall(G_POCKET, 60.0);
    let mut e = Engine::new(demo, None, 0).unwrap();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 203));
    let down = incidents(&evs, IncidentKind::DownAfterFall);
    assert_eq!(down.len(), 1, "{:?}", kinds(&evs));
    let unlock = first(&evs, is_unlock).expect("a red incident unlocks in demo mode");
    assert_eq!(unlock, down[0].0, "unlock on the same tick as down-after-fall");
    let check = first(&evs, is_check).expect("the possible fall asked first");
    assert!(check < unlock);
    // v1 keeps the check-in deadline: no unlock at the down-after-fall tick
    let mut e = Engine::new(DEFAULT_TOML, None, 0).unwrap();
    let mut g = Gen::new(0, 203);
    g.walk(60.0, G_POCKET);
    g.fall(G_POCKET, 60.0);
    let evs = synth::replay(&mut e, &motion_trace(g.out, 203));
    let down = incidents(&evs, IncidentKind::DownAfterFall);
    assert!(first(&evs, is_unlock).map(|t| t > down[0].0).unwrap_or(true));
}

/// Lone-incident check-ins only cover the serious kinds: a phone dropped on its own (its high-g warning clears when
/// the impact is classified as a drop, ~2.4 s) never asks.
#[test]
fn lone_dropped_phone_does_not_ask() {
    let mut g = Gen::new(0, 202);
    g.walk(60.0, G_HAND);
    g.drop(120.0);
    let mut e = Engine::new(DEFAULT_TOML, None, 0).unwrap();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 202));
    assert!(!incidents(&evs, IncidentKind::HardImpact).is_empty() || !incidents(&evs, IncidentKind::PhoneDrop).is_empty(), "{:?}", kinds(&evs));
    assert!(first(&evs, is_check).is_none(), "a dropped phone must not ask: {:?}", kinds(&evs));
}

/// Milder Watch kinds still need two families: `check_alone` does not change the combination rule.
#[test]
fn lone_mild_incident_does_not_ask_but_two_families_do() {
    let cfg = safety_core::config::Config::from_toml(DEFAULT_TOML).unwrap();
    let alone = cfg.incidents.check_alone_kinds();
    assert_eq!(alone, vec![IncidentKind::PossibleFall, IncidentKind::HardImpact, IncidentKind::ScreamShout]);
    for k in [IncidentKind::SlowedWalk, IncidentKind::Separated, IncidentKind::UnsteadyGait, IncidentKind::StoppedOnWayHome] {
        assert!(!alone.contains(&k), "{k:?} must not ask alone");
    }
    assert!(matches!(
        safety_core::config::Config::from_toml("[incidents]\ncheck_alone = [\"not_a_kind\"]\n"),
        Err(EngineError::Config { .. })
    ));
}

/// Default timing: the high-g warning on the tick that holds the peak, PossibleFall once the impact settles
/// (impact + post window), DownAfterFall 15 s after that.
#[test]
fn default_config_warns_at_the_peak_and_marks_down_15s_after_the_fall() {
    let cfg = Config::default_v1();
    let mut g = Gen::new(0, 13);
    g.walk(30.0, G_POCKET);
    let fall = g.t_ms;
    g.fall(G_POCKET, 30.0);
    let mut e = Engine::new(DEFAULT_TOML, None, 0).unwrap();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 13));
    let tick_of = |t: u64| t / 1000 * 1000 + 1000;
    let warn = incidents(&evs, IncidentKind::HardImpact);
    assert_eq!(warn.len(), 1, "{:?}", kinds(&evs));
    assert!(warn[0].1.summary.starts_with("High-g impact"), "{}", warn[0].1.summary);
    assert!(warn[0].0 <= tick_of(warn[0].1.t_ms), "warning on the peak's own tick: {} vs peak {}", warn[0].0, warn[0].1.t_ms);
    let settle = cfg.impact.impact_window_ms + cfg.impact.post_window_ms;
    let possible = incidents(&evs, IncidentKind::PossibleFall);
    assert_eq!(possible.len(), 1);
    assert!(possible[0].0 <= tick_of(fall + settle + 200), "possible fall at {} (fall {fall})", possible[0].0);
    let down = incidents(&evs, IncidentKind::DownAfterFall);
    assert_eq!(down.len(), 1);
    let down_at = possible[0].0 + (cfg.incidents.down_after_fall_s * 1000.0) as u64;
    assert!(down[0].0 >= down_at && down[0].0 <= down_at + 1000, "down at {} vs possible fall {}", down[0].0, possible[0].0);
}

/// A throw that bounces (hard impact, not a clean fall) and then lies still also goes "down" 15 s after it settles.
#[test]
fn hard_impact_that_then_lies_still_is_down_after_fall() {
    let mut g = Gen::new(0, 14);
    g.walk(30.0, G_POCKET);
    g.fall(G_POCKET, 0.0);
    g.still(2.0, synth::G_LYING, 0.4); // bouncing / tumbling right after the hit
    g.still(30.0, synth::G_LYING, 0.008);
    let mut e = Engine::new(DEFAULT_TOML, None, 0).unwrap();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 14));
    let hard = incidents(&evs, IncidentKind::HardImpact);
    assert_eq!(hard.len(), 1, "{:?}", kinds(&evs));
    assert!(incidents(&evs, IncidentKind::PossibleFall).is_empty(), "{:?}", kinds(&evs));
    assert!(cleared(&evs, IncidentKind::HardImpact).is_empty(), "kept as the hard impact");
    let down = incidents(&evs, IncidentKind::DownAfterFall);
    assert_eq!(down.len(), 1, "{:?}", kinds(&evs));
    assert!(down[0].0 - hard[0].1.t_ms <= 19_000, "down {} ms after the hit", down[0].0 - hard[0].1.t_ms);
    assert!(down[0].1.summary.ends_with("for 15 s"), "{}", down[0].1.summary);
}

#[test]
fn reset_empties_the_log_and_rests_sensing() {
    let tr = synth::trace(Scenario::Fall, 6, 15);
    let mut e = Engine::new(DEFAULT_TOML, None, 0).unwrap();
    e.push_context(Context { t_ms: 0, hour_local: 12, ..night_ctx(0) }); // daytime: only incidents force full rate
    synth::replay(&mut e, &tr);
    let end = tr.motion.last().unwrap().t_ms + 2000;
    assert!(!e.incident_log().is_empty() && e.listening());
    e.reset_incidents(end);
    let evs = e.tick(end + 1000);
    assert!(e.incident_log().is_empty() && e.active_incidents().is_empty());
    assert!(!e.listening());
    assert!(evs.contains(&EngineEvent::AudioListening { on: false }) || !e.listening());
    assert_eq!(e.snapshot().escalation, EscalationLevel::Idle);
    // a new incident gets a fresh id above the old ones and logs normally
    let mut g = Gen::new(end + 2000, 16);
    g.walk(10.0, G_POCKET);
    g.fall(G_POCKET, 10.0);
    e.push_motion(g.out.clone());
    let evs = e.tick(g.t_ms);
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::SignalIncident { record } if record.id > 1)), "{evs:?}");
}

/// Story B: sitting at a table, a fast stand-up, a small stumble, walking on: nothing worth a check.
#[test]
fn story_b_still_acceleration_stumble_walk_never_checks() {
    let tr = synth::trace(Scenario::Still, 15, 2);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    assert!(first(&evs, is_check).is_none(), "{evs:?}");
    // at most a context-level stumble and a high-g warning from the fast stand-up that cleared at once (no tilt)
    assert!(e.active_incidents().iter().all(|r| r.tier == IncidentTier::Context), "{:?}", e.active_incidents());
    for r in e.incident_log().iter().filter(|r| r.kind == IncidentKind::HardImpact) {
        assert!(r.cleared_ms > 0 && r.cleared_ms - r.t_ms < 3_000, "{r:?}");
    }
    assert_eq!(e.snapshot().escalation, EscalationLevel::Idle);
}

#[test]
fn benign_scenarios_never_check() {
    for (sc, seed) in [(Scenario::Walk, 3), (Scenario::Drunk, 4), (Scenario::Dance, 5), (Scenario::Drop, 6)] {
        let tr = synth::trace(sc, 8, seed);
        let mut e = engine();
        let evs = synth::replay(&mut e, &tr);
        assert!(first(&evs, is_check).is_none(), "{sc:?} false alarm: {:?}", kinds(&evs));
        assert!(incidents(&evs, IncidentKind::PossibleFall).is_empty(), "{sc:?}");
        // a high-g warning may flash (the drop's landing) but never stays
        assert_eq!(incidents(&evs, IncidentKind::HardImpact).len(), cleared(&evs, IncidentKind::HardImpact).len(), "{sc:?}");
        match sc {
            Scenario::Walk | Scenario::Dance => assert!(kinds(&evs).iter().all(|k| *k == IncidentKind::HardImpact), "{sc:?}: {:?}", kinds(&evs)),
            // a drunk walk is one family of evidence (gait): logged, full sensing, no check on its own
            Scenario::Drunk => {
                assert_eq!(incidents(&evs, IncidentKind::UnsteadyGait).len(), 1);
                assert!(kinds(&evs).iter().all(|k| k.family() == IncidentFamily::Gait), "{:?}", kinds(&evs));
                assert!(e.snapshot().sensing_full);
            }
            // dropped, lay there 4 min, picked up: one PhoneDrop, cleared at the pickup
            Scenario::Drop => {
                assert_eq!(incidents(&evs, IncidentKind::PhoneDrop).len(), 1, "{:?}", kinds(&evs));
                assert_eq!(cleared(&evs, IncidentKind::PhoneDrop).len(), 1);
            }
            _ => {}
        }
    }
}

#[test]
fn fall_then_walking_again_is_fall_recovered() {
    let mut g = Gen::new(0, 9);
    g.walk(120.0, G_POCKET);
    g.fall(G_POCKET, 45.0);
    g.walk(420.0, G_POCKET);
    let tr = motion_trace(g.out, 9);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    assert!(first(&evs, is_check).is_none(), "{evs:?}");
    assert_eq!(incidents(&evs, IncidentKind::PossibleFall).len(), 1);
    let rec = incidents(&evs, IncidentKind::FallRecovered);
    assert_eq!(rec.len(), 1, "{:?}", kinds(&evs));
    assert!(rec[0].1.tier == IncidentTier::Context && rec[0].1.summary.starts_with("Up and walking"));
    assert_eq!(cleared(&evs, IncidentKind::PossibleFall).len(), 1);
    assert!(incidents(&evs, IncidentKind::DownAfterFall).is_empty());
    assert!(e.active_incidents().is_empty(), "{:?}", e.active_incidents());
    // the recovered fall stays in the log as context (a moment: logged already cleared)
    assert!(e.incident_log().iter().any(|r| r.kind == IncidentKind::FallRecovered && r.cleared_ms == r.t_ms));
}

#[test]
fn fall_alone_then_down_checks_and_unlocks() {
    let mut g = Gen::new(0, 10);
    g.walk(60.0, G_POCKET);
    let fall = g.t_ms;
    g.fall(G_POCKET, 500.0);
    let tr = motion_trace(g.out, 10);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let down = incidents(&evs, IncidentKind::DownAfterFall);
    assert_eq!(down.len(), 1);
    assert_eq!(down[0].1.tier, IncidentTier::Danger);
    let check = first(&evs, is_check).expect("a Danger incident asks on its own");
    assert_eq!(check, down[0].0);
    assert!(check > fall + 120_000, "no check before the person was down for 2 min");
    assert_eq!(first(&evs, is_unlock).unwrap() - check, 240_000);
    let s = summary_of(&evs, |e| if let EngineEvent::UnlockLocation { summary } = e { Some(summary) } else { None });
    assert_eq!(s, "Hard fall, then down for 2 min, then no answer to a check-in");
}

/// Down, check-in missed, heads-up — then the person gets up and walks before the unlock: the episode resolves on
/// its own, the missed check-in clears, no location is released.
#[test]
fn getting_up_after_a_heads_up_resolves_without_unlock() {
    let mut g = Gen::new(0, 12);
    g.walk(60.0, G_POCKET);
    g.fall(G_POCKET, 260.0);
    g.walk(120.0, G_POCKET);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 12));
    let heads = first(&evs, is_heads_up).expect("heads-up");
    let rec = incidents(&evs, IncidentKind::FallRecovered);
    assert_eq!(rec.len(), 1);
    assert!(rec[0].0 > heads);
    assert!(first(&evs, is_unlock).is_none(), "{:?}", kinds(&evs));
    assert_eq!(first(&evs, |e| *e == EngineEvent::Resolved), Some(rec[0].0));
    assert_eq!(cleared(&evs, IncidentKind::CheckInMissed).len(), 1);
    assert!(e.active_incidents().is_empty(), "{:?}", e.active_incidents());
}

#[test]
fn touching_the_phone_after_a_fall_is_not_down() {
    let tr = synth::trace(Scenario::Fall, 12, 81);
    let fall = tr.meta.incident_t_ms.unwrap();
    // the person touches the phone every minute after the fall (keeps it still): never "down", and the fall
    // (gait + fall families) check is the only one
    let mut touched = tr.clone();
    for s in 0..8 {
        let t = fall + 60_000 + s * 60_000;
        touched.context.push(Context { t_ms: t, activity: Activity::Stationary, last_touch_ms: t, ..night_ctx(t) });
    }
    touched.context.sort_by_key(|c| c.t_ms);
    let mut e = engine();
    let evs = synth::replay(&mut e, &touched);
    assert!(incidents(&evs, IncidentKind::DownAfterFall).is_empty(), "{:?}", kinds(&evs));
    // eager: sitting back up without walking or touching the phone still counts as down
    let mut g = Gen::new(0, 82);
    g.walk(60.0, G_POCKET);
    g.fall(G_POCKET, 20.0);
    g.still(300.0, G_POCKET, 0.008);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 82));
    assert_eq!(incidents(&evs, IncidentKind::PossibleFall).len(), 1);
    assert_eq!(incidents(&evs, IncidentKind::DownAfterFall).len(), 1, "{:?}", kinds(&evs));
}

#[test]
fn good_dismiss_acknowledges_and_does_not_ask_again() {
    let tr = synth::trace(Scenario::Fall, 12, 1);
    let mut e = engine();
    e.set_night_mode(true, 0);
    let mut dismissed_at = None;
    let mut t = 1000;
    let mut mi = 0;
    let mut ci = 0;
    while t <= tr.motion.last().unwrap().t_ms {
        let s = mi;
        while mi < tr.motion.len() && tr.motion[mi].t_ms < t {
            mi += 1;
        }
        e.push_motion(tr.motion[s..mi].to_vec());
        while ci < tr.context.len() && tr.context[ci].t_ms < t {
            e.push_context(tr.context[ci]);
            ci += 1;
        }
        for ev in e.tick(t) {
            match ev {
                EngineEvent::CheckRequested { phrase, .. } if dismissed_at.is_none() => {
                    // the user types the phrase correctly at a normal pace
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
                EngineEvent::CheckRequested { .. } => panic!("asked again after an answered check-in"),
                EngineEvent::SignalIncident { record } if record.kind == IncidentKind::DownAfterFall => {
                    panic!("answered after the fall: never 'down'")
                }
                _ => {}
            }
        }
        t += 1000;
    }
    assert!(dismissed_at.is_some());
    let snap = e.snapshot();
    assert!(matches!(snap.escalation, EscalationLevel::Idle | EscalationLevel::Resolved));
    // still full sensing — the fall and the unsteady gait are acknowledged, not gone
    assert!(snap.sensing_full);
    assert!(e.active_incidents().iter().all(|r| r.acknowledged));
}

#[test]
fn wrong_phrase_keeps_the_check_open_and_need_help_unlocks() {
    let mut e = engine();
    let tr = synth::trace(Scenario::Fall, 6, 11);
    let evs = synth::replay(&mut e, &tr);
    let t0 = first(&evs, is_check).expect("check");
    assert!(e.check_deadline_ms().is_some() || first(&evs, is_heads_up).is_some());
    let mut e = engine();
    let mut short = tr.clone();
    short.motion.retain(|s| s.t_ms < t0 + 5_000);
    synth::replay(&mut e, &short);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Check);
    e.push_action(UserAction::DismissWrongPhrase, t0 + 6_000);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Check, "a typo does not escalate or dismiss");
    e.push_action(UserAction::NeedHelp, t0 + 30_000);
    let evs = e.tick(t0 + 31_000);
    assert_eq!(e.snapshot().escalation, EscalationLevel::Unlocked);
    assert!(!evs.iter().any(is_check));
}

#[test]
fn fall_vs_drop_discrimination_and_drop_needs_60s_without_pickup() {
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

    // picked up after 30 s: never logged
    let mut e = engine();
    e.set_night_mode(true, 0);
    let mut g = Gen::new(0, 23);
    g.walk(10.0, G_HAND);
    g.drop(30.0);
    g.pickup();
    g.walk(40.0, G_HAND);
    let evs = synth::replay(&mut e, &motion_trace(g.out, 23));
    assert!(incidents(&evs, IncidentKind::PhoneDrop).is_empty(), "{:?}", kinds(&evs));
    // only the landing's high-g warning, cleared as soon as it classified as a drop
    assert_eq!(kinds(&evs), vec![IncidentKind::HardImpact]);
    assert!(e.active_incidents().is_empty());
    // left lying 3 min: PhoneDrop at 60 s (Watch: full sensing + listening), cleared on pickup
    let mut e = engine();
    let mut g = Gen::new(0, 24);
    g.walk(10.0, G_HAND);
    let t_drop = g.t_ms;
    g.drop(180.0);
    g.pickup();
    g.walk(20.0, G_HAND);
    let evs = synth::replay(&mut e, &motion_trace(g.out, 24));
    let d = incidents(&evs, IncidentKind::PhoneDrop);
    assert_eq!(d.len(), 1);
    assert!(d[0].0 >= t_drop + 60_000 && d[0].0 < t_drop + 64_000, "{} vs {t_drop}", d[0].0);
    assert_eq!(cleared(&evs, IncidentKind::PhoneDrop).len(), 1);
    assert!(evs.iter().any(|(_, e)| *e == EngineEvent::AudioListening { on: true }));
    assert!(first(&evs, is_check).is_none());
}

// ---------------- grab ----------------

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
    assert!(grabs[0].1.watched && grabs[0].1.sequence_id > 0 && grabs[0].1.tier == IncidentTier::Danger, "{:?}", grabs[0].1);
    assert!(incidents(&evs, IncidentKind::PossibleFall).is_empty(), "the wrench out of the hand is not a fall");
    // the yank's high-g warning shows at once and is cleared when the grab confirms
    assert_eq!(incidents(&evs, IncidentKind::HardImpact).len(), cleared(&evs, IncidentKind::HardImpact).len());
    assert_eq!(e.snapshot().escalation, EscalationLevel::Unlocked);
    assert!(e.listening(), "still listening while friends are alerted");
    assert_eq!(summary_of(&evs, |e| if let EngineEvent::HeadsUp { summary } = e { Some(summary) } else { None }), "Phone grabbed");
    assert!(e.listening(), "a grab opens the listening window");

    // owner unlocks the phone 30 s after the grab: no unlock, episode resolved, Grab cleared
    let mut e = engine();
    let mut unlocked_by_owner = tr.clone();
    unlocked_by_owner.actions = vec![synth::TimedAction { t_ms: t_snatch + 30_000, action: UserAction::PhoneUnlocked }];
    let evs = synth::replay(&mut e, &unlocked_by_owner);
    assert!(first(&evs, is_heads_up).is_some());
    assert!(first(&evs, is_unlock).is_none(), "{evs:?}");
    assert!(matches!(e.snapshot().escalation, EscalationLevel::Idle | EscalationLevel::Resolved));
    assert_eq!(cleared(&evs, IncidentKind::Grab).len(), 1);

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

// ---------------- gait ----------------

#[test]
fn unsteady_gait_needs_30s_and_clears_after_2_min_of_normal_walking() {
    // 20 s of drunk walking between steady walks is not an incident
    let mut g = Gen::new(0, 61);
    g.walk(60.0, G_POCKET);
    g.drunk_walk(20.0, G_POCKET);
    g.walk(60.0, G_POCKET);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 61));
    assert!(incidents(&evs, IncidentKind::UnsteadyGait).is_empty(), "{evs:?}");
    // 60 s is, and 3 min of normal walking afterwards clears it
    let mut g = Gen::new(0, 62);
    g.walk(60.0, G_POCKET);
    g.drunk_walk(60.0, G_POCKET);
    let back = g.t_ms;
    g.walk(180.0, G_POCKET);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 62));
    let d = incidents(&evs, IncidentKind::UnsteadyGait);
    assert_eq!(d.len(), 1, "{evs:?}");
    let r = &d[0].1;
    assert!(r.t_ms > 60_000 && r.t_ms < 120_000, "{r:?}");
    assert!(r.summary.starts_with("Unsteady walking") && !r.summary.contains("cadence"), "{}", r.summary);
    assert!(r.raw_json.contains("\"stride_cv\"") && r.raw_json.contains("\"wobble\""), "{}", r.raw_json);
    assert!(!r.watched && r.sequence_id == 0, "no episode");
    let c = cleared(&evs, IncidentKind::UnsteadyGait);
    assert_eq!(c.len(), 1);
    assert!(c[0].0 >= back + 120_000 && c[0].0 < back + 135_000, "cleared at {} vs normal from {back}", c[0].0);
}

#[test]
fn slowed_walk_after_a_minute_well_below_the_usual_cadence() {
    let mut g = Gen::new(0, 63);
    g.walk(30.0, G_POCKET);
    let slow = g.t_ms;
    g.gait(90.0, 80.0, 0.22, 0.03, 0.05, 0.06, 0.03, G_POCKET); // steady but slow: 80 steps/min
    g.walk(60.0, G_POCKET);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 63));
    let s = incidents(&evs, IncidentKind::SlowedWalk);
    assert_eq!(s.len(), 1, "{:?}", kinds(&evs));
    assert!(s[0].0 >= slow + 60_000 && s[0].0 < slow + 72_000, "{} vs {slow}", s[0].0);
    assert!(incidents(&evs, IncidentKind::UnsteadyGait).is_empty(), "slow is not unsteady");
    assert_eq!(cleared(&evs, IncidentKind::SlowedWalk).len(), 1, "cadence back in band clears it");
}

#[test]
fn stumbles_are_single_context_then_repeated_after_three_in_5_min() {
    let mut g = Gen::new(0, 64);
    g.walk(30.0, G_POCKET);
    for _ in 0..3 {
        g.trip(G_POCKET);
        g.walk(25.0, G_POCKET);
    }
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 64));
    let st = incidents(&evs, IncidentKind::Stumble);
    assert_eq!(st.len(), 3, "{:?}", kinds(&evs));
    assert!(st.iter().all(|(_, r)| r.tier == IncidentTier::Context));
    let rep = incidents(&evs, IncidentKind::RepeatedStumbles);
    assert_eq!(rep.len(), 1);
    assert_eq!(rep[0].0, st[2].0);
    assert!(incidents(&evs, IncidentKind::UnsteadyGait).is_empty(), "three trips are not an unsteady gait");
    // steady walking has no stumbles at all
    let mut g = Gen::new(0, 65);
    g.walk(240.0, G_POCKET);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 65));
    assert!(incidents(&evs, IncidentKind::Stumble).is_empty());
    // a single stumble is pruned after 30 quiet minutes
    let mut g = Gen::new(0, 66);
    g.walk(30.0, G_POCKET);
    g.trip(G_POCKET);
    g.walk(20.0, G_POCKET);
    g.still(31.0 * 60.0, synth::G_SITTING, 0.006);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 66));
    assert_eq!(incidents(&evs, IncidentKind::Stumble).len(), 1);
    assert!(e.incident_log().is_empty(), "{:?}", e.incident_log());
}

// ---------------- low-rate mode & sensing control ----------------

#[test]
fn low_rate_mode_ignores_gait_but_keeps_activity_and_coarse_falls() {
    // 10 Hz accel-only walking: no gait metrics, all bands in band, activity from the OS
    let tr = synth::decimate(&synth::trace(Scenario::Walk, 3, 71), 5);
    assert!(tr.motion.windows(2).all(|w| w[1].t_ms - w[0].t_ms == 100) && tr.motion.iter().all(|s| s.rx == 0.0));
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let f = e.last_features().expect("windows still computed");
    assert!(!f.full && !f.is_walking && (f.fs - 10.0).abs() < 0.5 && f.energy_rms > 0.1, "{f:?}");
    let m = e.metrics();
    assert!(!m.sampling_full);
    for b in &m.bands {
        if b.name == "peak_g" {
            assert!(b.value > 1.0 && b.in_band, "{b:?}");
        } else {
            assert!(b.in_band && b.sd_distance == 0.0 && b.value == 0.0 && b.sd > 0.0, "{b:?}");
        }
    }
    assert!(m.evidence.contains("low-rate sampling: gait metrics paused"), "{}", m.evidence);
    assert_eq!(m.activity, Activity::Walking, "falls back to the OS activity");
    assert!(kinds(&evs).is_empty());
    assert!(e.snapshot().baseline_seconds == 0, "nothing is learned at 10 Hz");
    // ... even a 10 Hz drunk walk is not a gait incident
    let tr = synth::decimate(&synth::trace(Scenario::Drunk, 3, 72), 5);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    assert!(kinds(&evs).is_empty(), "{:?}", kinds(&evs));
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
    // coarse impact at 10 Hz: the fall is still a PossibleFall, then down, and it unlocks
    let tr = synth::decimate(&synth::trace(Scenario::Fall, 12, 74), 5);
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let imp = incidents(&evs, IncidentKind::PossibleFall);
    assert_eq!(imp.len(), 1, "{:?}", kinds(&evs));
    assert!(imp[0].1.t_ms.abs_diff(tr.meta.incident_t_ms.unwrap()) < 1500);
    assert!(imp[0].1.raw_json.contains("\"orientation_change_deg\""));
    assert_eq!(incidents(&evs, IncidentKind::DownAfterFall).len(), 1);
    assert!(first(&evs, is_unlock).is_some());
}

#[test]
fn sampling_mode_follows_away_late_watch_incidents_and_learning() {
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
    // night mode at home: a fall turns full sensing on while it is active, and for 30 min after the last incident
    let mut e = engine();
    e.set_night_mode(true, 0);
    e.push_context(Context { t_ms: 1000, hour_local: 1, away_from_home: false, sampling_full: true, ..Context::default() });
    assert_eq!(sampling(&e.tick(1000)), Some((10, false)));
    let mut g = Gen::new(2000, 75);
    g.walk(10.0, G_POCKET);
    g.fall(G_POCKET, 5.0);
    e.push_motion(g.out.clone());
    let evs = e.tick(g.t_ms);
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::SignalIncident { record } if record.kind == IncidentKind::PossibleFall)));
    assert_eq!(sampling(&evs), Some((50, true)));
    // gets up and walks: FallRecovered (context) at ~recovered; PossibleFall cleared, full for 30 more min
    let n0 = g.out.len();
    g.walk(20.0, G_POCKET);
    e.push_motion(g.out[n0..].to_vec());
    let evs = e.tick(g.t_ms);
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::SignalIncident { record } if record.kind == IncidentKind::FallRecovered)), "{evs:?}");
    assert!(e.active_incidents().is_empty());
    assert_eq!(sampling(&e.tick(g.t_ms + 29 * 60_000)), None);
    assert_eq!(sampling(&e.tick(g.t_ms + 31 * 60_000)), Some((10, false)));
    // by day, learning on, OS says walking, baseline untrusted => full so a baseline can be learned
    let mut e = engine();
    e.push_context(Context { t_ms: 1000, hour_local: 12, activity: Activity::Walking, ..Context::default() });
    assert_eq!(sampling(&e.tick(1000)), Some((50, true)));
    e.set_learning(false);
    assert_eq!(sampling(&e.tick(2000)), Some((10, false)));
}

#[test]
fn listening_window_opens_on_a_fall_and_closes_10_min_later() {
    let mut g = Gen::new(0, 76);
    g.walk(30.0, G_POCKET);
    g.fall(G_POCKET, 20.0);
    g.walk(60.0, G_POCKET);
    g.still(12.0 * 60.0, synth::G_SITTING, 0.006);
    let mut e = engine();
    let mut on_ticks = Vec::new();
    let evs = synth::replay_with(&mut e, &motion_trace(g.out, 76), &mut |t, e| {
        if e.listening() {
            on_ticks.push(t);
        }
    });
    let on = first(&evs, |e| *e == EngineEvent::AudioListening { on: true }).expect("listening opened");
    let off = first(&evs, |e| *e == EngineEvent::AudioListening { on: false }).expect("listening closed");
    let fall = incidents(&evs, IncidentKind::PossibleFall)[0].1.t_ms;
    assert_eq!(on, incidents(&evs, IncidentKind::HardImpact)[0].0, "opens with the high-g warning");
    assert!(off > fall + 10 * 60_000 && off <= fall + 10 * 60_000 + 1_000, "off {off} vs fall {fall}");
    assert_eq!(incidents(&evs, IncidentKind::FallRecovered).len(), 1);
    // never listening before night mode / any trigger
    assert!(on_ticks.iter().all(|t| *t >= on));
    // no listening by day, even after a fall
    let mut e = engine();
    let mut g = Gen::new(0, 77);
    g.walk(30.0, G_POCKET);
    g.fall(G_POCKET, 20.0);
    e.push_motion(g.out);
    let evs = e.tick(g.t_ms);
    assert!(!evs.iter().any(|e| matches!(e, EngineEvent::AudioListening { .. })));
}

// ---------------- audio ----------------

fn frames(e: &mut Engine, from_ms: u64, secs: u64, scream: f32, snore: f32, level_db: f32) {
    for i in 0..secs {
        e.push_audio(AudioScores { t_ms: from_ms + i * 1000, scream, shout: 0.0, snore, level_db });
    }
}

#[test]
fn scream_after_a_fall_unless_in_a_loud_venue() {
    let mut g = Gen::new(0, 78);
    g.walk(30.0, G_POCKET);
    g.fall(G_POCKET, 60.0);
    let tr = motion_trace(g.out, 78);
    let mut e = engine();
    synth::replay(&mut e, &tr);
    assert!(e.listening());
    let t = 70_000;
    frames(&mut e, t, 5, 0.0, 0.0, 60.0);
    frames(&mut e, t + 5_000, 3, 0.8, 0.0, 70.0);
    let evs: Vec<(u64, EngineEvent)> = e.tick(t + 9_000).into_iter().map(|ev| (t + 9_000, ev)).collect();
    let s = incidents(&evs, IncidentKind::ScreamShout);
    assert_eq!(s.len(), 1, "{evs:?}");
    assert!(s[0].1.raw_json.contains("\"frames\":3"), "{}", s[0].1.raw_json);
    // fall + scream = two families ⇒ check right away
    assert!(first(&evs, is_check).is_some());
    // the same burst in a loud venue (median level ≥ 80 dB) is ignored
    let mut e = engine();
    synth::replay(&mut e, &tr);
    frames(&mut e, t, 10, 0.0, 0.0, 92.0);
    frames(&mut e, t + 10_000, 3, 0.8, 0.0, 95.0);
    let evs = e.tick(t + 14_000);
    assert!(!evs.iter().any(|e| matches!(e, EngineEvent::SignalIncident { record } if record.kind == IncidentKind::ScreamShout)));
    assert!(e.metrics().context.iter().any(|c| c == "loud venue"), "{:?}", e.metrics().context);
    // not listening (no trigger): frames are ignored
    let mut e = engine();
    e.set_night_mode(true, 0);
    e.tick(1000);
    frames(&mut e, 1000, 5, 0.9, 0.0, 60.0);
    assert!(!e.tick(7000).iter().any(|e| matches!(e, EngineEvent::SignalIncident { .. })));
}

#[test]
fn snoring_while_down_after_a_missed_check_in() {
    let mut g = Gen::new(0, 79);
    g.walk(30.0, G_POCKET);
    g.fall(G_POCKET, 400.0);
    let mut e = engine();
    let evs = synth::replay(&mut e, &motion_trace(g.out, 79));
    let missed = incidents(&evs, IncidentKind::CheckInMissed);
    assert_eq!(missed.len(), 1, "{:?}", kinds(&evs));
    let t = e.last_features().unwrap().t_ms + 2_000;
    frames(&mut e, t, 4, 0.0, 0.7, 45.0);
    let evs: Vec<(u64, EngineEvent)> = e.tick(t + 5_000).into_iter().map(|ev| (t, ev)).collect();
    let s = incidents(&evs, IncidentKind::SnoringWhileDown);
    assert_eq!(s.len(), 1, "{evs:?}");
    assert!(e.sequence_summary().unwrap().ends_with("snoring sounds while down"), "{:?}", e.sequence_summary());
    // answered: snoring and the missed check-in clear
    e.push_action(UserAction::DismissOk, t + 6_000);
    assert!(e.active_incidents().iter().all(|r| !matches!(r.kind, IncidentKind::SnoringWhileDown | IncidentKind::CheckInMissed)));
}

// ---------------- location, stillness, device ----------------

#[test]
fn separated_fires_after_10_min_unless_heading_home_and_clears_when_back() {
    let run = |dist: &dyn Fn(u64) -> f32| {
        let mut e = engine();
        e.set_night_mode(true, 0);
        let out = run_ctx(&mut e, 1, 12 * 60, &|t| Context { separated: true, distance_home_m: dist(t / 1000), ..night_ctx(t) });
        (incidents(&out, IncidentKind::Separated), e)
    };
    let (sep, mut e) = run(&|_| 1200.0);
    assert_eq!(sep.len(), 1, "{sep:?}");
    assert!(sep[0].0 >= 600_000 && sep[0].0 <= 602_000, "fired at {}", sep[0].0);
    assert!(sep[0].1.summary.contains("Separated") && sep[0].1.tier == IncidentTier::Watch);
    assert!(first(&run_ctx(&mut e, 12 * 60 + 1, 5, &|t| Context { separated: true, distance_home_m: 1200.0, ..night_ctx(t) }), is_check).is_none(), "one family: no check");
    let back = run_ctx(&mut e, 13 * 60, 5, &|t| Context { separated: false, distance_home_m: 1200.0, ..night_ctx(t) });
    assert_eq!(cleared(&back, IncidentKind::Separated).len(), 1);
    let (sep, _) = run(&|_| -1.0);
    assert_eq!(sep.len(), 1, "unknown distance: not heading home");
    let (sep, _) = run(&|s| 1200.0 - (s as f32 * 1.3).min(900.0));
    assert!(sep.is_empty(), "walking home: {sep:?}");
    let (sep, _) = run(&|s| 300.0 + s as f32 * 1.3);
    assert_eq!(sep.len(), 1, "moving away");
}

#[test]
fn stopped_on_the_way_home() {
    let mut e = engine();
    e.set_night_mode(true, 0);
    // heading home at 1 m/s for 10 min (1500 m → 900 m), then standing still 900 m from home
    let walk = |t: u64| Context { distance_home_m: 1500.0 - (t / 1000) as f32, speed_mps: 1.3, ..night_ctx(t) };
    let evs = run_ctx(&mut e, 1, 600, &walk);
    assert!(kinds(&evs).is_empty());
    let still = |t: u64| Context { distance_home_m: 900.0, speed_mps: 0.0, activity: Activity::Stationary, ..night_ctx(t) };
    let evs = run_ctx(&mut e, 601, 11 * 60, &still);
    let s = incidents(&evs, IncidentKind::StoppedOnWayHome);
    assert_eq!(s.len(), 1, "{:?}", kinds(&evs));
    assert!(s[0].0 >= 1_200_000 && s[0].0 < 1_203_000, "{}", s[0].0);
    assert!(s[0].1.raw_json.contains("\"approached_m\":599") || s[0].1.raw_json.contains("\"approached_m\":600"), "{}", s[0].1.raw_json);
    // moving again clears it
    let evs = run_ctx(&mut e, 1300, 5, &walk);
    assert_eq!(cleared(&evs, IncidentKind::StoppedOnWayHome).len(), 1);
    // standing still without having headed home is not "on the way home"
    let mut e = engine();
    e.set_night_mode(true, 0);
    let evs = run_ctx(&mut e, 1, 15 * 60, &|t| Context { distance_home_m: 900.0, speed_mps: 0.0, activity: Activity::Stationary, ..night_ctx(t) });
    assert!(incidents(&evs, IncidentKind::StoppedOnWayHome).is_empty());
}

#[test]
fn phone_left_behind_after_20_min_set_down_and_with_separation_asks() {
    let mut g = Gen::new(0, 85);
    g.walk(20.0, G_HAND);
    g.still(25.0 * 60.0, G_FLAT, 0.002);
    let mut tr = motion_trace(g.out, 85);
    tr.context = vec![Context { activity: Activity::Stationary, speed_mps: 0.0, ..night_ctx(0) }];
    let mut e = engine();
    let mut set_down_flag = None;
    let evs = synth::replay_with(&mut e, &tr, &mut |t, e| {
        if set_down_flag.is_none() && e.metrics().context.iter().any(|c| c == "phone set down") {
            set_down_flag = Some(t);
        }
    });
    let lb = incidents(&evs, IncidentKind::PhoneLeftBehind);
    assert_eq!(lb.len(), 1, "{:?}", kinds(&evs));
    assert!(lb[0].0 >= 20 * 60_000 && lb[0].0 < 21 * 60_000 + 20_000, "{}", lb[0].0);
    let sd = set_down_flag.expect("set-down context");
    assert!(sd >= 5 * 60_000 && sd < 6 * 60_000, "{sd}");
    assert!(first(&evs, is_check).is_none(), "left behind alone does not ask");
    // the same phone, separated from the group: phone family + location family ⇒ check
    let mut tr2 = tr.clone();
    tr2.context = vec![Context { activity: Activity::Stationary, speed_mps: 0.0, separated: true, ..night_ctx(0) }];
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr2);
    let check = first(&evs, is_check).expect("check");
    assert_eq!(check, incidents(&evs, IncidentKind::PhoneLeftBehind)[0].0);
    // a touch picks it up again
    let evs = run_ctx(&mut e, 26 * 60, 3, &|t| Context { last_touch_ms: t, screen_on: true, separated: true, ..night_ctx(t) });
    assert_eq!(cleared(&evs, IncidentKind::PhoneLeftBehind).len(), 1);
}

#[test]
fn vehicle_and_battery_are_context_and_clear() {
    let mut e = engine();
    e.set_night_mode(true, 0);
    let evs = run_ctx(&mut e, 1, 30, &|t| Context { activity: Activity::Vehicle, speed_mps: 9.0, ..night_ctx(t) });
    let v = incidents(&evs, IncidentKind::InVehicle);
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].1.tier, IncidentTier::Context);
    assert!(e.metrics().context.iter().any(|c| c == "in a vehicle"));
    let evs = run_ctx(&mut e, 31, 3, &|t| night_ctx(t));
    assert_eq!(cleared(&evs, IncidentKind::InVehicle).len(), 1);
    // battery at 10 % away late: BatteryCritical + BatteryDying once; charging clears
    let evs = run_ctx(&mut e, 40, 5, &|t| Context { battery_pct: 10, ..night_ctx(t) });
    assert_eq!(incidents(&evs, IncidentKind::BatteryCritical).len(), 1);
    assert_eq!(evs.iter().filter(|(_, e)| *e == EngineEvent::BatteryDying).count(), 1);
    let evs = run_ctx(&mut e, 45, 2, &|t| Context { battery_pct: 9, charging: true, ..night_ctx(t) });
    assert_eq!(cleared(&evs, IncidentKind::BatteryCritical).len(), 1);
    assert!(first(&evs, is_check).is_none());
    assert!(e.active_incidents().iter().all(|r| r.tier == IncidentTier::Context), "context only");
}

#[test]
fn unsteady_walk_while_separated_asks_two_families() {
    let mut g = Gen::new(0, 86);
    g.walk(30.0, G_POCKET);
    g.drunk_walk(11.0 * 60.0, G_POCKET);
    let mut tr = motion_trace(g.out, 86);
    tr.context = vec![Context { separated: true, distance_home_m: 2000.0, speed_mps: 0.8, ..night_ctx(0) }];
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr);
    let sep = incidents(&evs, IncidentKind::Separated);
    assert_eq!(sep.len(), 1);
    assert!(first(&evs, is_check).expect("check") == sep[0].0, "gait + location");
}

#[test]
fn night_mode_off_clears_everything_active() {
    let tr = synth::trace(Scenario::Fall, 6, 87);
    let mut e = engine();
    synth::replay(&mut e, &tr);
    assert!(!e.active_incidents().is_empty());
    e.set_night_mode(false, 7 * 60_000);
    let evs = e.tick(7 * 60_000 + 1000);
    assert!(e.active_incidents().is_empty());
    assert_eq!(e.snapshot().escalation, EscalationLevel::Idle);
    assert!(evs.iter().any(|e| *e == EngineEvent::AudioListening { on: false }));
    assert!(e.incident_log().iter().all(|r| r.cleared_ms > 0 || r.tier == IncidentTier::Context));
}

// ---------------- log, call option ----------------

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
    assert_eq!(log.iter().map(|r| r.kind).collect::<Vec<_>>(), vec![IncidentKind::HardImpact, IncidentKind::PossibleFall, IncidentKind::DownAfterFall], "newest last");
    let blob = e.export_baseline();
    let e2 = Engine::new(DEFAULT_TOML, Some(&blob), end + 60_000).unwrap();
    assert_eq!(e2.incident_log(), log);
    let e3 = Engine::new(DEFAULT_TOML, Some(&blob), end + 9 * 3_600_000).unwrap();
    assert!(e3.incident_log().is_empty());
    let mut e4 = Engine::new(DEFAULT_TOML, Some(&blob), end + 60_000).unwrap();
    e4.tick(end + 7 * 3_600_000);
    assert_eq!(e4.incident_log().len(), 3);
    e4.tick(end + 8 * 3_600_000 + 1000);
    assert!(e4.incident_log().is_empty());
    // the blob is still a baseline blob: a v1 blob without a log loads, and an old-format log loads empty
    assert!(Engine::new(DEFAULT_TOML, Some(b"not json"), 0).is_err());
    let v1 = br#"{"version":1,"gait":[],"typing":{"feats":[{"samples":[],"ewma":0,"ewvar":0,"n":0},{"samples":[],"ewma":0,"ewvar":0,"n":0},{"samples":[],"ewma":0,"ewvar":0,"n":0},{"samples":[],"ewma":0,"ewvar":0,"n":0},{"samples":[],"ewma":0,"ewvar":0,"n":0}],"n":0}}"#;
    assert!(Engine::new(DEFAULT_TOML, Some(v1), 0).is_ok());
    let hmm_era = br#"{"version":3,"log":{"records":[{"id":1,"t_ms":5,"kind":"GaitDrift","summary":"x","sd_distance":0,"placement":"Pocket","raw_json":"{}","p_normal":1,"p_impaired":0,"p_incident":0,"p_unresponsive":0,"sequence_id":0,"watched":false}],"next_id":1,"next_seq":0}}"#;
    let e5 = Engine::new(DEFAULT_TOML, Some(hmm_era), 10).unwrap();
    assert!(e5.incident_log().is_empty());
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
    assert_eq!(calls[0], check + 600_000);
    assert!(calls[0] > unlock);
    let s = summary_of(&evs, |e| if let EngineEvent::CallOptionAvailable { summary } = e { Some(summary) } else { None });
    assert!(s.contains("no response for 10 min"), "{s}");
    // FriendMarkedSafe before 600 s: no call option
    let mut tr2 = tr.clone();
    tr2.actions.push(synth::TimedAction { t_ms: unlock + 30_000, action: UserAction::FriendMarkedSafe });
    let mut e = engine();
    let evs = synth::replay(&mut e, &tr2);
    assert!(!evs.iter().any(|(_, e)| matches!(e, EngineEvent::CallOptionAvailable { .. })), "{evs:?}");
}

// ---------------- baselines ----------------

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
    walk_day(&mut e, 5, 60.0);
    assert!((e.metrics().baseline_walk_days - 6.0).abs() < 1e-3);
    walk_day(&mut e, 6, 60.0);
    let m = e.metrics();
    assert!(m.baseline_trusted && (m.baseline_walk_days - 7.0).abs() < 1e-3, "{m:?}");
    let cad = m.bands.iter().find(|b| b.name == "cadence").unwrap();
    assert!((cad.mean - 112.0).abs() < 3.0, "{cad:?}");
    assert!(cad.in_band && cad.sd_distance.abs() < 2.5);
    for d in 20..24 {
        walk_day(&mut e, d, 60.0);
    }
    let m = e.metrics();
    assert!(!m.baseline_trusted && (m.baseline_walk_days - 4.0).abs() < 1e-3, "{m:?}");
    let blob = e.export_baseline();
    let e2 = Engine::new(DEFAULT_TOML, Some(&blob), 24 * DAY).unwrap();
    assert_eq!(e2.baseline().walk_days(Placement::Pocket), 4);

    // night sessions: walking during a night with a Watch incident is dropped, a quiet night is kept
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
    let mut g = Gen::new(0, 43);
    g.still(8.0, synth::G_SITTING, 0.006);
    let still = compute_features(&cfg.gait, &g.out[100..400], true);
    assert!(!still.is_walking && still.energy_rms < cfg.gait.still_rms_g);
    assert!(still.energy_rms > cfg.incidents.set_down_rms_g, "sitting is on-body micro-motion, not set down");
    let mut g = Gen::new(0, 44);
    g.dance(8.0);
    let dance = compute_features(&cfg.gait, &g.out[100..400], true);
    assert!(dance.agitation > 0.0 && !dance.is_walking, "{dance:?}");
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
fn location_interval_is_5_min_then_1_min_once_friends_are_alerted() {
    let mut e = engine();
    e.set_night_mode(true, 0);
    let evs = e.tick(1000);
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::LocationIntervalChanged { seconds: 300 })));
    assert!(evs.iter().any(|e| matches!(e, EngineEvent::SamplingRateChanged { .. })), "sampling mode announced at the first tick");
    // an incident alone does not change it
    let evs = run_ctx(&mut e, 2, 11 * 60, &|t| Context { separated: true, distance_home_m: 900.0, ..night_ctx(t) });
    assert!(!evs.iter().any(|(_, e)| matches!(e, EngineEvent::LocationIntervalChanged { .. })));
    // SOS: friends alerted ⇒ every minute
    e.push_action(UserAction::ManualSos, 700_000);
    let evs = e.tick(701_000);
    assert!(evs.iter().any(|e| *e == EngineEvent::LocationIntervalChanged { seconds: 60 }), "{evs:?}");
}

#[test]
fn typing_far_off_baseline_logs_typing_off_and_heads_up() {
    let mut e = engine();
    let tr = synth::trace(Scenario::Fall, 6, 131);
    let all = synth::replay(&mut engine(), &tr);
    let t0 = first(&all, is_check).expect("check");
    let mut short = tr.clone();
    short.motion.retain(|s| s.t_ms < t0 + 3_000);
    synth::replay(&mut e, &short);
    let phrase = e.check_phrase().to_string();
    let n = phrase.len() as u64;
    let slow = TypingSample { phrase: phrase.clone(), typed: phrase, key_times_ms: (0..n).map(|i| i * 900).collect(), backspaces: 6, duration_ms: n * 900 };
    let v = e.push_typing(slow, t0 + 20_000);
    assert!(!v.accepted && v.reason.contains("far off"), "{v:?}");
    let log = e.incident_log();
    let off = log.iter().find(|r| r.kind == IncidentKind::TypingOff).expect("typing off logged");
    assert!(off.sd_distance > 2.5 && off.raw_json.contains("\"z\""), "{off:?}");
    assert_eq!(e.snapshot().escalation, EscalationLevel::HeadsUp, "friends hear now, not at the deadline");
}

// ---------------- live metrics (dashboard) ----------------

#[test]
fn live_metrics_update_every_second_and_are_never_stale() {
    let cfg = Config::default_v1();
    assert!((cfg.gait.hop_s - 1.0).abs() < 1e-6);
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
    assert!(at(2_000).1 == 0.0 && at(2_000).2 == Activity::Walking, "{:?}", at(2_000));
    assert!(at(10_000).1 > 100.0 && at(10_000).2 == Activity::Walking, "{:?}", at(10_000));
    assert!(at(28_000).1 == 0.0 && at(28_000).2 == Activity::Stationary, "{:?}", at(28_000));
    assert!(at(48_000).1 > 100.0 && at(48_000).2 == Activity::Walking, "{:?}", at(48_000));
    let walking: Vec<f32> = cad.iter().filter(|(t, _, _)| *t >= 8_000 && *t <= 18_000).map(|(_, c, _)| *c).collect();
    assert!(walking.windows(2).filter(|w| w[0] != w[1]).count() >= walking.len() / 2, "{walking:?}");
    let e = engine();
    let m = e.metrics();
    assert_eq!(m.bands.len(), 8);
    assert!(m.bands.iter().all(|b| b.in_band && b.sd > 0.0 && b.value == 0.0));
    assert!(!m.listening && m.context.is_empty());
}

#[test]
fn spike_metrics_show_within_a_second_and_hold_for_spike_hold_s() {
    let cfg = Config::default_v1();
    let hold = cfg.signals.spike_hold_s as u64;
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
    for n in ["jerk", "rotation", "peak_g"] {
        assert!(band(first_tick - 1000, n).in_band, "{:?}", band(first_tick - 1000, n));
    }
    let j = band(first_tick, "jerk");
    let r = band(first_tick, "rotation");
    let p = band(first_tick, "peak_g");
    assert!(!j.in_band && j.value > cfg.grab.jerk_g_per_s && j.sd_distance > cfg.signals.band_sd_untrusted, "{j:?}");
    assert!(!r.in_band && r.value > cfg.grab.rotation_deg_per_s, "{r:?}");
    assert!(!p.in_band && p.value > 2.5, "{p:?}");
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
    assert!(incidents(&evs, IncidentKind::Grab).is_empty(), "{evs:?}");
}

#[test]
fn unsteady_gait_builds_visibly_in_metrics_before_the_incident_opens() {
    let mut g = Gen::new(0, 171);
    g.walk(30.0, G_POCKET);
    let drunk_t = g.t_ms;
    g.drunk_walk(60.0, G_POCKET);
    let tr = motion_trace(g.out, 171);
    let mut e = engine();
    let mut seen: Vec<(u64, String, bool, Vec<u32>)> = Vec::new();
    let evs = synth::replay_with(&mut e, &tr, &mut |t, e| {
        let m = e.metrics();
        let oob = m.bands.iter().any(|b| !b.in_band);
        seen.push((t, m.evidence.clone(), oob, e.active_incidents().iter().map(|r| r.id).collect()));
    });
    let drift = incidents(&evs, IncidentKind::UnsteadyGait);
    assert_eq!(drift.len(), 1, "{evs:?}");
    let fire_t = drift[0].0;
    assert!(fire_t >= drunk_t + 30_000 && fire_t <= drunk_t + 45_000, "opened at {fire_t}, drunk from {drunk_t}");
    let building: Vec<&(u64, String, bool, Vec<u32>)> = seen.iter().filter(|(t, _, _, _)| *t > drunk_t + 10_000 && *t < fire_t).collect();
    assert!(building.iter().filter(|(_, _, oob, _)| *oob).count() >= building.len() * 2 / 3, "{building:?}");
    let with_text: Vec<&&(u64, String, bool, Vec<u32>)> = building.iter().filter(|(_, ev, _, _)| ev.contains("out of band for")).collect();
    assert!(with_text.len() >= building.len() / 2, "{building:?}");
    let secs = |ev: &str| ev.split("out of band for ").nth(1).and_then(|r| r.split(' ').next()).and_then(|n| n.parse::<f32>().ok());
    let a = secs(&with_text[0].1).unwrap();
    let b = secs(&with_text[with_text.len() - 1].1).unwrap();
    assert!(b > a + 5.0 && b < 45.0, "{a} -> {b}");
    // once open, the "building" note stops (the incident is in the log instead)
    let after = seen.iter().find(|(t, _, _, _)| *t == fire_t).unwrap();
    assert!(after.3.contains(&drift[0].1.id) && !after.1.contains("out of band for"), "{after:?}");
    assert!(drift[0].1.summary.contains("for 30 s") || drift[0].1.summary.contains("for 31 s"), "{}", drift[0].1.summary);
}
