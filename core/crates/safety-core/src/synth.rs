//! Synthetic 50 Hz motion generators (walk / drunk walk / fall / drop / still / dance / snatch)
//! with gyro (rotation rate implied by the gravity trajectory + yaw jitter / grab spin), whole-night
//! trace composition and a low-rate decimator. Shared by tests and the `sim` CLI.
use crate::types::{Activity, AudioScores, Context, MotionSample, UserAction};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;

pub const FS: f32 = 50.0;
pub const DT_MS: u64 = 20;

pub const G_POCKET: [f32; 3] = [0.05, -0.99, 0.1];
pub const G_HAND: [f32; 3] = [0.05, -0.6, 0.8];
pub const G_FLAT: [f32; 3] = [0.0, 0.0, 1.0];
pub const G_SITTING: [f32; 3] = [0.1, -0.7, 0.7];
pub const G_LYING: [f32; 3] = [0.3, -0.2, 0.93];

fn unit(v: [f32; 3]) -> [f32; 3] {
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-6);
    [v[0] / n, v[1] / n, v[2] / n]
}
fn q(x: f32) -> f32 {
    (x * 1000.0).round() / 1000.0
}
fn sample(t_ms: u64, a: [f32; 3], g: [f32; 3], w: [f32; 3]) -> MotionSample {
    let g = unit(g);
    MotionSample { t_ms, ax: q(a[0]), ay: q(a[1]), az: q(a[2]), gx: q(g[0]), gy: q(g[1]), gz: q(g[2]), rx: q(w[0]), ry: q(w[1]), rz: q(w[2]) }
}
fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
/// Unit vector perpendicular to g (lateral axis).
fn lateral(g: [f32; 3]) -> [f32; 3] {
    let c = [g[1] * 1.0 - g[2] * 0.0, g[2] * 0.0 - g[0] * 1.0, g[0] * 0.0 - g[1] * 0.0];
    let c = if c.iter().map(|x| x.abs()).sum::<f32>() < 1e-3 { [1.0, 0.0, 0.0] } else { c };
    unit(c)
}

pub struct Gen {
    pub rng: StdRng,
    pub t_ms: u64,
    pub out: Vec<MotionSample>,
    prev_g: Option<[f32; 3]>,
}

impl Gen {
    pub fn new(start_ms: u64, seed: u64) -> Self {
        Gen { rng: StdRng::seed_from_u64(seed), t_ms: start_ms, out: Vec::new(), prev_g: None }
    }
    fn n(&mut self, sd: f32) -> f32 {
        // cheap approx normal
        let u: f32 = (0..3).map(|_| self.rng.gen::<f32>()).sum::<f32>() - 1.5;
        u * sd * 1.41
    }
    fn n3(&mut self, sd: f32) -> [f32; 3] {
        [self.n(sd), self.n(sd), self.n(sd)]
    }
    fn push(&mut self, a: [f32; 3], g: [f32; 3]) {
        self.push_w(a, g, [0.0; 3]);
    }
    /// Push a sample; the gyro is the rotation rate implied by the gravity change plus `w_extra`
    /// (rotation about gravity is invisible to the accelerometer).
    fn push_w(&mut self, a: [f32; 3], g: [f32; 3], w_extra: [f32; 3]) {
        let gu = unit(g);
        let dt = DT_MS as f32 / 1000.0;
        let mut w = match self.prev_g {
            Some(p) => {
                let c = cross(p, gu);
                [c[0] / dt, c[1] / dt, c[2] / dt]
            }
            None => [0.0; 3],
        };
        for k in 0..3 {
            w[k] += w_extra[k];
        }
        self.prev_g = Some(gu);
        self.out.push(sample(self.t_ms, a, gu, w));
        self.t_ms += DT_MS;
    }

    /// Generic periodic gait. `jitter` = per-step period jitter fraction, `asym` = stride-frequency component.
    pub fn gait(&mut self, secs: f32, cadence_spm: f32, amp: f32, jitter: f32, asym: f32, sway: f32, wobble: f32, g0: [f32; 3]) {
        let n = (secs * FS) as usize;
        let mut phase = 0.0f32;
        let mut f = cadence_spm / 60.0;
        let mut step_amp = amp;
        let mut sway_phase = 0.0f32;
        let mut sway_drift = 0.0f32;
        let lat = lateral(g0);
        let up = [-g0[0], -g0[1], -g0[2]];
        for _ in 0..n {
            let prev = phase;
            phase += 2.0 * PI * f / FS;
            if (prev % (2.0 * PI)) > (phase % (2.0 * PI)) {
                // new step: redraw period and amplitude
                f = cadence_spm / 60.0 * (1.0 + self.n(jitter));
                if jitter > 0.15 && self.rng.gen::<f32>() < 0.15 {
                    f *= 0.55; // stagger: a long, slow step
                }
                step_amp = amp * (1.0 + self.n(jitter * 2.0));
            }
            sway_phase += 2.0 * PI * f / 2.0 / FS;
            sway_drift = 0.95 * sway_drift + self.n(sway * 0.3);
            let v = step_amp * phase.sin() + 0.3 * step_amp * (2.0 * phase).sin() + asym * amp * (phase / 2.0).sin();
            let h = sway * sway_phase.sin() + sway_drift;
            let noise = [self.n(0.02), self.n(0.02), self.n(0.02)];
            let a = [
                up[0] * v + lat[0] * h + noise[0],
                up[1] * v + lat[1] * h + noise[1],
                up[2] * v + lat[2] * h + noise[2],
            ];
            let wob = [wobble * (sway_phase * 0.7).sin(), wobble * (phase * 0.5).cos() * 0.5, wobble * (sway_phase * 1.3).sin()];
            let yaw = self.n(wobble * 3.0);
            self.push_w(a, [g0[0] + wob[0], g0[1] + wob[1], g0[2] + wob[2]], [g0[0] * yaw, g0[1] * yaw, g0[2] * yaw]);
        }
    }
    pub fn walk(&mut self, secs: f32, g0: [f32; 3]) {
        self.gait(secs, 112.0, 0.25, 0.03, 0.05, 0.06, 0.03, g0);
    }
    pub fn run(&mut self, secs: f32, g0: [f32; 3]) {
        self.gait(secs, 175.0, 0.7, 0.03, 0.05, 0.1, 0.05, g0);
    }
    pub fn drunk_walk(&mut self, secs: f32, g0: [f32; 3]) {
        self.gait(secs, 92.0, 0.22, 0.2, 0.6, 0.35, 0.15, g0);
    }
    pub fn still(&mut self, secs: f32, g0: [f32; 3], noise: f32) {
        let n = (secs * FS) as usize;
        for _ in 0..n {
            let a = self.n3(noise);
            self.push(a, g0);
        }
    }
    pub fn dance(&mut self, secs: f32) {
        let n = (secs * FS) as usize;
        let mut f = [1.2f32, 2.3, 3.1];
        let mut ph = [0.0f32; 3];
        let mut g = G_POCKET;
        for i in 0..n {
            if i % 40 == 0 {
                for k in 0..3 {
                    f[k] = self.rng.gen_range(0.8..4.0);
                }
                g = [G_POCKET[0] + self.n(0.3), G_POCKET[1], G_POCKET[2] + self.n(0.3)];
            }
            for k in 0..3 {
                ph[k] += 2.0 * PI * f[k] / FS;
            }
            let a = [0.45 * ph[0].sin() + self.n(0.1), 0.5 * ph[1].sin() + self.n(0.1), 0.4 * ph[2].sin() + self.n(0.1)];
            self.push(a, g);
        }
    }
    /// Body fall: short free fall, hard impact, orientation change, lying still afterwards.
    pub fn fall(&mut self, g_before: [f32; 3], still_secs: f32) {
        let gb = unit(g_before);
        for _ in 0..10 {
            // 0.2 s free fall: total accel ≈ 0 → user accel = -g
            let nz = self.n3(0.03);
            self.push([-gb[0] + nz[0], -gb[1] + nz[1], -gb[2] + nz[2]], gb);
        }
        // ~200 ms impact: any 10 Hz decimation phase still sees a sample above 2.5 g
        for k in [1.6f32, 2.0, 2.8, 4.6, 3.8, 3.2, 2.9, 2.6, 2.0, 1.5] {
            self.push([k * 0.3, k * 0.5, k * 0.8], gb);
        }
        let ga = unit(G_LYING);
        for i in 0..25 {
            let d = 0.4 * (-(i as f32) / 6.0).exp();
            let a = self.n3(d);
            self.push(a, ga);
        }
        self.still(still_secs, ga, 0.008);
    }
    /// Stumble: brief 2.5 g jolt without free fall; walking continues.
    pub fn stumble(&mut self, g0: [f32; 3]) {
        for i in 0..8 {
            let k = if i == 3 { 2.4 } else { 0.9 };
            let nz = self.n3(0.1);
            self.push([k * 0.2 + nz[0], -k * 0.9 + nz[1], k * 0.3], g0);
        }
    }
    /// Phone dropped alone: long free fall, lands flat, dead still afterwards.
    pub fn drop(&mut self, still_secs: f32) {
        let gh = unit(G_HAND);
        for _ in 0..23 {
            // 0.46 s free fall
            let nz = self.n3(0.02);
            self.push([-gh[0] + nz[0], -gh[1] + nz[1], -gh[2] + nz[2]], gh);
        }
        for i in 0..3 {
            let k = if i == 1 { 5.2 } else { 1.5 };
            self.push([0.0, 0.0, k], gh);
        }
        for i in 0..15 {
            let d = 0.3 * (-(i as f32) / 3.0).exp();
            let a = self.n3(d);
            self.push(a, G_FLAT);
        }
        self.still(still_secs, G_FLAT, 0.002);
    }
    /// Pick up the phone from flat into the hand.
    pub fn pickup(&mut self) {
        for i in 0..100 {
            let k = i as f32 / 100.0;
            let g = [G_FLAT[0] + k * (G_HAND[0] - G_FLAT[0]), k * G_HAND[1], 1.0 + k * (G_HAND[2] - 1.0)];
            let a = self.n3(0.25);
            self.push(a, g);
        }
    }
    /// Snatch: jerk + rotation out of the hand, then a thief running.
    pub fn snatch(&mut self, run_secs: f32) {
        let mut g = unit(G_HAND);
        for i in 0..6 {
            let k = if i < 3 { 2.5 } else { 1.0 };
            g = unit([g[0] + 0.25, g[1] + 0.2, g[2] - 0.3]);
            // wrenched out of the hand: ~700 deg/s spin about the long axis on top of the tilt
            self.push_w([k, k * 0.5, -k * 0.6], g, [0.0, 12.0, 0.0]);
        }
        self.run(run_secs, G_POCKET);
    }
}

// ---------- trace composition ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scenario {
    Walk,
    Drunk,
    /// story A: walk → gait drift → fall → stillness ⇒ must unlock
    Fall,
    /// phone dropped alone, picked up later ⇒ quiet
    Drop,
    /// story B: still at table → acceleration → stumble → walking ⇒ quiet
    Still,
    Dance,
    Snatch,
}

impl Scenario {
    pub fn parse(s: &str) -> Option<Scenario> {
        Some(match s.to_lowercase().as_str() {
            "walk" => Scenario::Walk,
            "drunk" => Scenario::Drunk,
            "fall" | "story_a" | "a" => Scenario::Fall,
            "drop" => Scenario::Drop,
            "still" | "story_b" | "b" => Scenario::Still,
            "dance" => Scenario::Dance,
            "snatch" => Scenario::Snatch,
            _ => return None,
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Scenario::Walk => "walk",
            Scenario::Drunk => "drunk",
            Scenario::Fall => "fall",
            Scenario::Drop => "drop",
            Scenario::Still => "still",
            Scenario::Dance => "dance",
            Scenario::Snatch => "snatch",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Expect {
    /// must reach UnlockLocation
    Unlock,
    /// must never emit CheckRequested
    Quiet,
    Snatch,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TraceMeta {
    pub scenario: String,
    pub expect: Expect,
    pub night_mode: bool,
    pub hour_local: u8,
    /// time of the incident, for detection-delay reporting
    pub incident_t_ms: Option<u64>,
    pub seed: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TimedAction {
    pub t_ms: u64,
    pub action: UserAction,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Trace {
    pub meta: TraceMeta,
    pub motion: Vec<MotionSample>,
    pub context: Vec<Context>,
    pub audio: Vec<AudioScores>,
    pub actions: Vec<TimedAction>,
}

fn ctx(t_ms: u64, hour: u8, activity: Activity, screen_on: bool, speed: f32) -> Context {
    Context {
        t_ms,
        away_from_home: true,
        separated: false,
        hour_local: hour,
        screen_on,
        activity,
        battery_pct: 55,
        speed_mps: speed,
        last_touch_ms: if screen_on { t_ms } else { 0 },
        distance_home_m: -1.0,
        sampling_full: true,
    }
}

/// Compose a full trace for a scenario. `minutes` is the total length.
pub fn trace(sc: Scenario, minutes: u32, seed: u64) -> Trace {
    let total = (minutes.max(2) as f32) * 60.0;
    let hour = 1u8;
    let mut g = Gen::new(0, seed);
    let mut context = Vec::new();
    let mut incident = None;
    let mut expect = Expect::Quiet;
    let mut actions = Vec::new();
    let act = |t: f32, a: Activity, screen: bool, speed: f32, context: &mut Vec<Context>| {
        context.push(ctx((t * 1000.0) as u64, hour, a, screen, speed));
    };
    match sc {
        Scenario::Walk => {
            act(0.0, Activity::Walking, false, 1.3, &mut context);
            g.walk(total, G_POCKET);
        }
        Scenario::Drunk => {
            act(0.0, Activity::Walking, false, 1.0, &mut context);
            g.walk((total * 0.25).min(120.0), G_POCKET);
            let t = g.t_ms as f32 / 1000.0;
            g.drunk_walk(total - t, G_POCKET);
        }
        Scenario::Fall => {
            expect = Expect::Unlock;
            let walk = (total * 0.2).clamp(60.0, 150.0);
            let drunk = (total * 0.2).clamp(60.0, 150.0);
            act(0.0, Activity::Walking, false, 1.3, &mut context);
            g.walk(walk, G_POCKET);
            g.drunk_walk(drunk, G_POCKET);
            incident = Some(g.t_ms);
            let t = g.t_ms as f32 / 1000.0;
            g.fall(G_POCKET, total - t - 1.0);
            act(t + 5.0, Activity::Stationary, false, 0.0, &mut context);
        }
        Scenario::Drop => {
            act(0.0, Activity::Walking, true, 1.3, &mut context);
            g.walk(60.0, G_HAND);
            incident = Some(g.t_ms);
            g.drop((total * 0.5).min(240.0));
            act(61.0, Activity::Stationary, false, 0.0, &mut context);
            g.pickup();
            let t = g.t_ms as f32 / 1000.0;
            act(t, Activity::Walking, true, 1.3, &mut context);
            g.walk(total - t, G_HAND);
        }
        Scenario::Still => {
            // story B: sitting at a table, then stand up fast, stumble, walk on
            act(0.0, Activity::Stationary, false, 0.0, &mut context);
            let sit = (total * 0.6).max(60.0);
            g.still(sit, G_SITTING, 0.006);
            incident = Some(g.t_ms);
            g.gait(2.0, 130.0, 0.6, 0.1, 0.1, 0.15, 0.1, G_POCKET); // acceleration burst
            g.walk(3.0, G_POCKET);
            g.stumble(G_POCKET);
            let t = g.t_ms as f32 / 1000.0;
            act(t, Activity::Walking, false, 1.2, &mut context);
            g.walk(total - t, G_POCKET);
        }
        Scenario::Dance => {
            act(0.0, Activity::Stationary, false, 0.0, &mut context);
            g.still(30.0, G_SITTING, 0.006);
            g.dance((total - 60.0).max(30.0));
            let t = g.t_ms as f32 / 1000.0;
            g.still(total - t, G_SITTING, 0.006);
        }
        Scenario::Snatch => {
            expect = Expect::Snatch;
            act(0.0, Activity::Walking, true, 1.3, &mut context);
            g.walk(30.0, G_HAND);
            incident = Some(g.t_ms);
            g.snatch(20.0);
            act(32.0, Activity::Running, true, 4.5, &mut context);
            act(40.0, Activity::Running, true, 4.5, &mut context);
            let t = g.t_ms as f32 / 1000.0;
            g.run(total - t, G_POCKET);
            actions.push(TimedAction { t_ms: ((total - 1.0) * 1000.0) as u64, action: UserAction::BiometricDismiss });
        }
    }
    Trace {
        meta: TraceMeta { scenario: sc.name().into(), expect, night_mode: true, hour_local: hour, incident_t_ms: incident, seed },
        motion: g.out,
        context,
        audio: Vec::new(),
        actions,
    }
}

/// Low-rate view of a trace: keep every `factor`-th sample, zero the gyro, mark contexts `sampling_full = false`.
pub fn decimate(tr: &Trace, factor: usize) -> Trace {
    let mut out = tr.clone();
    out.motion = tr
        .motion
        .iter()
        .step_by(factor.max(1))
        .map(|s| MotionSample { rx: 0.0, ry: 0.0, rz: 0.0, ..*s })
        .collect();
    for c in &mut out.context {
        c.sampling_full = false;
    }
    out
}

/// Replay a trace through an engine at full speed with 1 s ticks. Returns (t_ms, event) pairs.
pub fn replay(engine: &mut crate::Engine, tr: &Trace) -> Vec<(u64, crate::EngineEvent)> {
    replay_with(engine, tr, &mut |_, _| {})
}

/// Like `replay`, calling `on_tick(t_ms, engine)` after every 1 s tick.
pub fn replay_with(engine: &mut crate::Engine, tr: &Trace, on_tick: &mut dyn FnMut(u64, &crate::Engine)) -> Vec<(u64, crate::EngineEvent)> {
    let end = tr.motion.last().map(|s| s.t_ms).unwrap_or(0).max(tr.context.last().map(|c| c.t_ms).unwrap_or(0)) + 1000;
    engine.set_night_mode(tr.meta.night_mode, 0);
    let (mut mi, mut ci, mut ai, mut xi) = (0, 0, 0, 0);
    let mut out = Vec::new();
    let mut t = 1000u64;
    while t <= end {
        let start = mi;
        while mi < tr.motion.len() && tr.motion[mi].t_ms < t {
            mi += 1;
        }
        if mi > start {
            engine.push_motion(tr.motion[start..mi].to_vec());
        }
        while ci < tr.context.len() && tr.context[ci].t_ms < t {
            engine.push_context(tr.context[ci]);
            ci += 1;
        }
        while ai < tr.audio.len() && tr.audio[ai].t_ms < t {
            engine.push_audio(tr.audio[ai]);
            ai += 1;
        }
        while xi < tr.actions.len() && tr.actions[xi].t_ms < t {
            engine.push_action(tr.actions[xi].action, tr.actions[xi].t_ms);
            xi += 1;
        }
        for ev in engine.tick(t) {
            out.push((t, ev));
        }
        on_tick(t, engine);
        t += 1000;
    }
    out
}
