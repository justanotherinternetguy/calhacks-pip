//! Calibration probe: classify every impact in a trace file (e.g. core/traces/recorded/*.json) with a given config.
//!   cargo run -q -p safety-core --example impacts -- <trace.json> [config.toml]
use safety_core::config::Config;
use safety_core::signal::impact::ImpactDetector;
use safety_core::synth::Trace;

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let tr: Trace = serde_json::from_str(&std::fs::read_to_string(&a[0]).unwrap()).unwrap();
    let cfg = Config::from_toml(&a.get(1).map(|p| std::fs::read_to_string(p).unwrap()).unwrap_or_default()).unwrap();
    let mut d = ImpactDetector::new(&cfg.impact);
    for s in &tr.motion {
        if let Some(ev) = d.push(s) {
            println!("{:6.1}s {:?} peak {:.1} g ff {} ms tilt {:.0}° post {:.3} lik {:.2} incident={}",
                ev.t_ms as f32 / 1000.0, ev.kind, ev.peak_g, ev.free_fall_ms, ev.orientation_change_deg, ev.post_motion_rms, ev.fall_likelihood, ev.is_incident(&cfg.impact));
        }
    }
}
