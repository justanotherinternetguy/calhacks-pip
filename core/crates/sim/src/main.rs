//! sim: replay / synthesize / batch-evaluate traces through safety_core::Engine.
use safety_core::synth::{self, Expect, Scenario, Trace};
use safety_core::{Engine, EngineEvent};
use std::path::{Path, PathBuf};
use std::process::exit;

fn usage() -> ! {
    eprintln!(
        "usage:\n  sim replay [--lowrate] <file.json|dir>\n  sim synth --scenario walk|drunk|fall|drop|still|dance|snatch --minutes N --out file.json [--seed S]\n  sim batch <dir>\n\nSIM_DEBUG=1 prints the escalation level and active incidents every 30 s during replay."
    );
    exit(2)
}

fn mmss(t_ms: u64) -> String {
    format!("{:02}:{:02}", t_ms / 60_000, (t_ms / 1000) % 60)
}

fn load(path: &Path) -> Trace {
    let s = std::fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("read {}: {e}", path.display());
        exit(1)
    });
    serde_json::from_str(&s).unwrap_or_else(|e| {
        eprintln!("parse {}: {e}", path.display());
        exit(1)
    })
}

/// Accept paths relative to the cwd, the workspace root (`core/`) or the repo root (`core/traces`).
fn resolve(p: &Path) -> PathBuf {
    if p.exists() {
        return p.to_path_buf();
    }
    let ws = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cand = ws.join(p);
    if cand.exists() {
        return cand;
    }
    if let Ok(stripped) = p.strip_prefix("core") {
        let cand = ws.join(stripped);
        if cand.exists() {
            return cand;
        }
    }
    p.to_path_buf()
}

fn json_files(p: &Path) -> Vec<PathBuf> {
    let p = &resolve(p);
    if p.is_dir() {
        let mut v: Vec<PathBuf> = std::fs::read_dir(p)
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().map(|x| x == "json").unwrap_or(false)).collect())
            .unwrap_or_default();
        v.sort();
        v
    } else {
        vec![p.to_path_buf()]
    }
}

struct Result_ {
    name: String,
    scenario: String,
    expect: Expect,
    check_t: Option<u64>,
    unlock_t: Option<u64>,
    snatch_t: Option<u64>,
    incidents: usize,
    sequence: Option<String>,
    incident_t: Option<u64>,
    hour: u8,
    minutes: f32,
    pass: bool,
}

fn run(path: &Path, verbose: bool, lowrate: bool) -> Result_ {
    let tr = load(path);
    let tr = if lowrate { synth::decimate(&tr, 5) } else { tr };
    // traces carry escalation expectations (unlock / quiet / snatch): replay with automatic escalation on
    let mut e = Engine::new("[thresholds]\nauto_escalate = true\n", None, 0).expect("config");
    let debug = verbose && std::env::var_os("SIM_DEBUG").is_some();
    let evs = synth::replay_with(&mut e, &tr, &mut |t, e| {
        if debug && t % 30_000 == 0 {
            let s = e.snapshot();
            println!("  [{}] {:?} listening={} active={:?}", mmss(t), s.escalation, s.listening, s.evidence);
        }
    });
    let find = |f: &dyn Fn(&EngineEvent) -> bool| evs.iter().find(|(_, e)| f(e)).map(|(t, _)| *t);
    let check_t = find(&|e| matches!(e, EngineEvent::CheckRequested { .. }));
    let unlock_t = find(&|e| matches!(e, EngineEvent::UnlockLocation { .. }));
    let snatch_t = find(&|e| matches!(e, EngineEvent::SnatchDetected { .. }));
    let pass = match tr.meta.expect {
        Expect::Unlock => unlock_t.is_some(),
        Expect::Quiet => check_t.is_none() && unlock_t.is_none() && snatch_t.is_none(),
        Expect::Snatch => snatch_t.is_some(),
    };
    let log = e.incident_log();
    if verbose {
        println!("== {} ({}, expect {:?}{})", path.display(), tr.meta.scenario, tr.meta.expect, if lowrate { ", 10 Hz accel-only" } else { "" });
        for (t, ev) in &evs {
            match ev {
                EngineEvent::SignalIncident { record } => {
                    println!("  [{}] SignalIncident #{} {:?} ({:?}): {}", mmss(*t), record.id, record.kind, record.tier, record.summary)
                }
                EngineEvent::IncidentCleared { record } => println!("  [{}] IncidentCleared #{} {:?}", mmss(*t), record.id, record.kind),
                _ => println!("  [{}] {:?}", mmss(*t), ev),
            }
        }
        println!("  final snapshot: {:#?}", e.snapshot());
        let m = e.metrics();
        println!(
            "  live metrics @{} placement={:?} activity={:?} full={} trusted={} walk_days={:.0} listening={} context={:?} evidence={:?}",
            mmss(m.t_ms), m.placement, m.activity, m.sampling_full, m.baseline_trusted, m.baseline_walk_days, m.listening, m.context, m.evidence
        );
        println!("  {:<10} {:>9} {:>9} {:>8} {:>7} band", "metric", "value", "mean", "sd", "sd_dist");
        for b in &m.bands {
            println!("  {:<10} {:>9.3} {:>9.3} {:>8.3} {:>+7.2} {}", b.name, b.value, b.mean, b.sd, b.sd_distance, if b.in_band { "in" } else { "OUT" });
        }
        println!("  incident log ({} records):", log.len());
        for r in &log {
            let state = if r.cleared_ms == 0 { "active".to_string() } else { format!("cleared {}", mmss(r.cleared_ms)) };
            println!(
                "    #{} [{}] {:?} {:?} {state}{} seq={} sd={:+.1} {} raw={}",
                r.id, mmss(r.t_ms), r.kind, r.tier, if r.acknowledged { " ack" } else { "" }, r.sequence_id, r.sd_distance, r.summary, r.raw_json
            );
        }
        if let Some(s) = e.sequence_summary() {
            println!("  sequence summary: {s}");
        }
    }
    let minutes = tr.motion.last().map(|s| s.t_ms as f32 / 60_000.0).unwrap_or(0.0);
    Result_ {
        name: path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        scenario: tr.meta.scenario.clone(),
        expect: tr.meta.expect,
        check_t,
        unlock_t,
        snatch_t,
        incidents: log.len(),
        sequence: e.sequence_summary(),
        incident_t: tr.meta.incident_t_ms,
        hour: tr.meta.hour_local,
        minutes,
        pass,
    }
}

fn opt(t: Option<u64>) -> String {
    t.map(mmss).unwrap_or_else(|| "-".into())
}

fn summary(results: &[Result_]) {
    println!("\n{:<28} {:<8} {:<7} {:>6} {:>7} {:>7} {:>7} {:>4} {:<5} {}", "trace", "scenario", "expect", "check", "unlock", "snatch", "delay", "inc", "ok", "sequence");
    for r in results {
        let delay = match (r.incident_t, r.unlock_t.or(r.snatch_t)) {
            (Some(i), Some(u)) if u >= i => format!("{}s", (u - i) / 1000),
            _ => "-".into(),
        };
        println!(
            "{:<28} {:<8} {:<7} {:>6} {:>7} {:>7} {:>7} {:>4} {:<5} {}",
            r.name,
            r.scenario,
            format!("{:?}", r.expect).to_lowercase(),
            opt(r.check_t),
            opt(r.unlock_t),
            opt(r.snatch_t),
            delay,
            r.incidents,
            if r.pass { "PASS" } else { "FAIL" },
            r.sequence.clone().unwrap_or_default()
        );
    }
}

fn batch(dir: &Path) -> i32 {
    let files = json_files(dir);
    if files.is_empty() {
        eprintln!("no traces in {}", dir.display());
        return 1;
    }
    let results: Vec<Result_> = files.iter().map(|f| run(f, false, false)).collect();
    summary(&results);
    // false alarms per night-hour (quiet traces only), detection delay per scenario
    let mut hours: std::collections::BTreeMap<u8, (f32, u32)> = Default::default();
    for r in results.iter().filter(|r| r.expect == Expect::Quiet) {
        let h = hours.entry(r.hour).or_default();
        h.0 += r.minutes / 60.0;
        if r.check_t.is_some() {
            h.1 += 1;
        }
    }
    println!("\nfalse alarms per night-hour (quiet traces):");
    for (h, (hrs, fa)) in &hours {
        println!("  {:02}:00  {:>5.2} h simulated  {} alarms  rate {:.2}/h", h, hrs, fa, if *hrs > 0.0 { *fa as f32 / hrs } else { 0.0 });
    }
    println!("\ndetection delay per scenario:");
    let mut by: std::collections::BTreeMap<String, Vec<u64>> = Default::default();
    for r in results.iter().filter(|r| r.expect != Expect::Quiet) {
        if let (Some(i), Some(u)) = (r.incident_t, r.unlock_t.or(r.snatch_t)) {
            by.entry(r.scenario.clone()).or_default().push(u.saturating_sub(i) / 1000);
        }
    }
    for (sc, d) in &by {
        let mean = d.iter().sum::<u64>() as f32 / d.len() as f32;
        println!("  {:<8} n={} mean {:.0}s max {}s", sc, d.len(), mean, d.iter().max().unwrap());
    }
    let failed = results.iter().filter(|r| !r.pass).count();
    println!("\n{} traces, {} failed", results.len(), failed);
    if failed > 0 { 1 } else { 0 }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        Some("replay") => {
            let lowrate = args.iter().any(|a| a == "--lowrate");
            let p = args.iter().skip(1).find(|a| !a.starts_with("--")).map(PathBuf::from).unwrap_or_else(|| usage());
            let results: Vec<Result_> = json_files(&p).iter().map(|f| run(f, true, lowrate)).collect();
            summary(&results);
        }
        Some("synth") => {
            let (mut sc, mut minutes, mut out, mut seed) = (None, 10u32, None, 1u64);
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--scenario" => sc = Scenario::parse(args.get(i + 1).unwrap_or_else(|| usage())),
                    "--minutes" => minutes = args.get(i + 1).and_then(|m| m.parse().ok()).unwrap_or_else(|| usage()),
                    "--out" => out = args.get(i + 1).cloned(),
                    "--seed" => seed = args.get(i + 1).and_then(|m| m.parse().ok()).unwrap_or_else(|| usage()),
                    _ => usage(),
                }
                i += 2;
            }
            let sc = sc.unwrap_or_else(|| usage());
            let out = out.unwrap_or_else(|| usage());
            let tr = synth::trace(sc, minutes, seed);
            std::fs::write(&out, serde_json::to_string(&tr).unwrap()).unwrap_or_else(|e| {
                eprintln!("write {out}: {e}");
                exit(1)
            });
            println!("wrote {out}: {} samples, {} min, expect {:?}", tr.motion.len(), minutes, tr.meta.expect);
        }
        Some("batch") => {
            let p = args.get(1).map(PathBuf::from).unwrap_or_else(|| usage());
            exit(batch(&p));
        }
        _ => usage(),
    }
}
