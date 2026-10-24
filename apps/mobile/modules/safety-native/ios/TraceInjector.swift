import Foundation

/// Debug-only: replays recorded `MotionSample[]` / `Context[]` / `AudioScores[]` through the engine
/// with a virtual clock, at wall-clock speed or faster (`speed` multiplier). Used by Maestro E2E flows
/// on the simulator where CoreMotion is unavailable.
///
/// JSON: { "speed": 10, "motion": [{tMs,ax,ay,az,gx,gy,gz,rx?,ry?,rz?}], "context": [{tMs,awayFromHome,separated,
///         hourLocal,screenOn,activity,batteryPct,speedMps,lastTouchMs?,distanceHomeM?,samplingFull?}],
///         "audio": [{tMs,scream,shout,glass}] }. Missing gyro → 0 (low-rate trace); missing `samplingFull`
///         is inferred from whether the trace carries gyro data.
final class TraceInjector {
    private struct M: Decodable { var tMs: UInt64; var ax, ay, az, gx, gy, gz: Float; var rx, ry, rz: Float? }
    private struct C: Decodable {
        var tMs: UInt64; var awayFromHome: Bool?; var separated: Bool?; var hourLocal: UInt8?
        var screenOn: Bool?; var activity: String?; var batteryPct: UInt8?; var speedMps: Float?
        var lastTouchMs: UInt64?; var distanceHomeM: Float?; var samplingFull: Bool?
    }
    private struct A: Decodable { var tMs: UInt64; var scream, shout, glass: Float }
    private struct Trace: Decodable { var speed: Double?; var motion: [M]?; var context: [C]?; var audio: [A]? }
    private enum Ev { case motion([MotionSample]), context(Context), audio(AudioScores) }

    func replay(json: String, into c: SensingCoordinator) async throws {
        #if !DEBUG
        throw SafeError("injectTrace is only available in debug builds")
        #else
        let t = try JSONDecoder().decode(Trace.self, from: Data(json.utf8))
        var events: [(UInt64, Ev)] = []
        let motion = (t.motion ?? []).sorted { $0.tMs < $1.tMs }
        let hasGyro = motion.contains { $0.rx != nil || $0.ry != nil || $0.rz != nil }
        var i = 0
        while i < motion.count {   // ~1 s batches, like MotionSampler
            let chunk = motion[i..<min(i + 50, motion.count)]
            events.append((chunk.first!.tMs, .motion(chunk.map {
                MotionSample(tMs: $0.tMs, ax: $0.ax, ay: $0.ay, az: $0.az, gx: $0.gx, gy: $0.gy, gz: $0.gz,
                             rx: $0.rx ?? 0, ry: $0.ry ?? 0, rz: $0.rz ?? 0) })))
            i += 50
        }
        for x in t.context ?? [] {
            events.append((x.tMs, .context(Context(
                tMs: x.tMs, awayFromHome: x.awayFromHome ?? true, separated: x.separated ?? false,
                hourLocal: x.hourLocal ?? 23, screenOn: x.screenOn ?? false, activity: Self.activity(x.activity),
                batteryPct: x.batteryPct ?? 80, speedMps: x.speedMps ?? -1,
                lastTouchMs: x.lastTouchMs ?? 0, distanceHomeM: x.distanceHomeM ?? -1, samplingFull: x.samplingFull ?? hasGyro))))
        }
        for a in t.audio ?? [] { events.append((a.tMs, .audio(AudioScores(tMs: a.tMs, scream: a.scream, shout: a.shout, glass: a.glass)))) }
        events.sort { $0.0 < $1.0 }
        guard let first = events.first else { return }
        let speed = max(0.01, t.speed ?? 1)

        c.setVirtualClock(first.0)
        c.forceSession(true)
        defer { c.setVirtualClock(nil); c.forceSession(false) }
        var last = first.0, lastTick = first.0
        for (tMs, ev) in events {
            if tMs > last { try await Task.sleep(nanoseconds: UInt64(Double(tMs - last) * 1_000_000 / speed)) }
            last = tMs
            c.setVirtualClock(tMs)
            switch ev {
            case .motion(let s): c.engine?.pushMotion(samples: s)
            case .context(let ctx): c.engine?.pushContext(ctx: ctx)
            case .audio(let a): c.engine?.pushAudio(s: a)
            }
            if tMs - lastTick >= 1000 { lastTick = tMs; c.tickNow() }
        }
        c.tickNow()
        #endif
    }

    private static func activity(_ s: String?) -> Activity {
        switch s?.lowercased() {
        case "stationary": return .stationary
        case "walking": return .walking
        case "running": return .running
        case "vehicle", "automotive": return .vehicle
        default: return .unknown
        }
    }
}
