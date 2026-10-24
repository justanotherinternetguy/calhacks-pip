import CoreMotion
import Foundation
import UIKit

/// Two sampling modes (CONTRACTS §6 `SamplingRateChanged`), batched into ~1 s of `MotionSample` per `pushMotion`:
///
/// - **LOW** (default): raw accelerometer at ~10 Hz (`accelerometerUpdateInterval = 0.1`), gyro off. Gravity is
///   a first-order low-pass of the raw vector (τ ≈ 1 s); user acceleration = raw − gravity; `rx..rz = 0`.
/// - **FULL**: `CMDeviceMotion` at 50 Hz with the fused gravity / user-acceleration split plus rotation rate
///   (`rx..rz`, rad/s, device frame).
///
/// The sampler keeps running in LOW mode whenever the coordinator has an engine and the process is alive, not
/// only during night sessions: without the continuous-location session iOS suspends the process a few seconds
/// after it leaves the foreground, so idle sampling effectively covers foreground use + the background grace
/// period and resumes when the app comes back. Also runs CMPedometer (diagnostics / activity fallback).
final class MotionSampler {
    enum Mode: Equatable {
        case low    // ~10 Hz accelerometer, no gyro
        case full   // 50 Hz device motion + gyro
        var hz: Double { self == .full ? MotionSampler.fullHz : MotionSampler.lowHz }
        var isFull: Bool { self == .full }
    }

    static let fullHz = 50.0
    static let lowHz = 10.0
    /// Low-pass time constant for the LOW-mode gravity estimate (seconds).
    private static let gravityTau = 1.0

    private let motion = CMMotionManager()
    private let pedometer = CMPedometer()
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        q.name = "app.safe.motion"
        return q
    }()
    private var buffer: [MotionSample] = []
    private var push: (([MotionSample]) -> Void)?
    /// LOW-mode gravity low-pass state (device frame, g). nil until the first accelerometer sample.
    private var gravityLP: (x: Double, y: Double, z: Double)?
    /// Wall-clock epoch (ms) of system boot; CMDeviceMotion / CMAccelerometerData.timestamp is seconds since boot.
    private let bootEpochMs = (Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime) * 1000
    private(set) var running = false
    /// The mode currently being delivered (`Context.samplingFull`).
    private(set) var mode: Mode = .low
    private(set) var steps = 0
    private(set) var lastStepAt: Date?

    var available: Bool { motion.isDeviceMotionAvailable || motion.isAccelerometerAvailable }
    var isFull: Bool { running && mode.isFull }

    /// Map an engine `SamplingRateChanged { hz, gyro }` onto a mode: gyro or ≥ 25 Hz → FULL, else LOW.
    static func modeFor(hz: UInt32, gyro: Bool) -> Mode { (gyro || hz >= 25) ? .full : .low }

    func start(mode: Mode = .low, _ push: @escaping ([MotionSample]) -> Void) {
        self.push = push
        if running {
            setMode(mode)
            return
        }
        guard available else { return }
        running = true
        buffer.reserveCapacity(Int(Self.fullHz) + 8)
        startUpdates(mode)
        if CMPedometer.isStepCountingAvailable() {
            steps = 0
            pedometer.startUpdates(from: Date()) { [weak self] data, _ in
                guard let self, let data else { return }
                let n = data.numberOfSteps.intValue
                if n != self.steps { self.lastStepAt = Date() }
                self.steps = n
            }
        }
    }

    /// Switch modes in place (no-op if unchanged or not running). Called on `.samplingRateChanged`.
    func setMode(_ m: Mode) {
        guard running, m != mode else { return }
        stopUpdates()
        startUpdates(m)
    }

    func stop() {
        guard running else { return }
        running = false
        stopUpdates()
        pedometer.stopUpdates()
        push = nil
    }

    // MARK: internals

    private func startUpdates(_ m: Mode) {
        // FULL needs device motion; fall back to LOW on hardware without it (gyro-less devices).
        let effective: Mode = (m == .full && !motion.isDeviceMotionAvailable) ? .low : m
        mode = effective
        gravityLP = nil
        switch effective {
        case .full:
            motion.deviceMotionUpdateInterval = 1.0 / Self.fullHz
            motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: queue) { [weak self] dm, _ in
                guard let self, let dm else { return }
                // ax..az = user acceleration (g, gravity removed); gx..gz = gravity unit vector; rx..rz = rotation rate (rad/s).
                self.append(MotionSample(
                    tMs: UInt64(max(0, self.bootEpochMs + dm.timestamp * 1000)),
                    ax: Float(dm.userAcceleration.x), ay: Float(dm.userAcceleration.y), az: Float(dm.userAcceleration.z),
                    gx: Float(dm.gravity.x), gy: Float(dm.gravity.y), gz: Float(dm.gravity.z),
                    rx: Float(dm.rotationRate.x), ry: Float(dm.rotationRate.y), rz: Float(dm.rotationRate.z)), batch: Int(Self.fullHz))
            }
        case .low:
            guard motion.isAccelerometerAvailable else { return }
            motion.accelerometerUpdateInterval = 1.0 / Self.lowHz
            let alpha = (1.0 / Self.lowHz) / (Self.gravityTau + 1.0 / Self.lowHz)
            motion.startAccelerometerUpdates(to: queue) { [weak self] data, _ in
                guard let self, let data else { return }
                let a = data.acceleration   // total acceleration incl. gravity (g), device frame; same frame/sign as CMDeviceMotion.gravity
                let g: (x: Double, y: Double, z: Double)
                if let prev = self.gravityLP {
                    g = (prev.x + alpha * (a.x - prev.x), prev.y + alpha * (a.y - prev.y), prev.z + alpha * (a.z - prev.z))
                } else {
                    g = (a.x, a.y, a.z)   // seed with the first sample so the first second is not a transient
                }
                self.gravityLP = g
                let norm = max(1e-6, (g.x * g.x + g.y * g.y + g.z * g.z).squareRoot())
                self.append(MotionSample(
                    tMs: UInt64(max(0, self.bootEpochMs + data.timestamp * 1000)),
                    ax: Float(a.x - g.x), ay: Float(a.y - g.y), az: Float(a.z - g.z),
                    gx: Float(g.x / norm), gy: Float(g.y / norm), gz: Float(g.z / norm),
                    rx: 0, ry: 0, rz: 0), batch: Int(Self.lowHz))
            }
        }
    }

    private func stopUpdates() {
        motion.stopDeviceMotionUpdates()
        motion.stopAccelerometerUpdates()
        queue.addOperation { [weak self] in self?.buffer.removeAll(keepingCapacity: true) }
    }

    /// Runs on `queue`. Flushes a batch every ~1 s (`batch` samples at the current rate).
    private func append(_ s: MotionSample, batch: Int) {
        buffer.append(s)
        if buffer.count >= batch {
            let out = buffer
            buffer.removeAll(keepingCapacity: true)
            push?(out)
        }
    }
}

/// CMMotionActivityManager → `Activity`. Also used to request the motion permission (first query prompts).
final class ActivityTracker {
    private let manager = CMMotionActivityManager()
    private let queue = OperationQueue()
    private(set) var current: Activity = .unknown

    func start() {
        guard CMMotionActivityManager.isActivityAvailable() else { return }
        manager.startActivityUpdates(to: queue) { [weak self] a in
            guard let a else { return }
            self?.current = ActivityTracker.map(a)
        }
    }

    func stop() { manager.stopActivityUpdates(); current = .unknown }

    static func map(_ a: CMMotionActivity) -> Activity {
        if a.automotive || a.cycling { return .vehicle }
        if a.running { return .running }
        if a.walking { return .walking }
        if a.stationary { return .stationary }
        return .unknown
    }

    static var authorization: String {
        switch CMMotionActivityManager.authorizationStatus() {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        default: return "undetermined"
        }
    }

    func requestPermission(_ done: @escaping (String) -> Void) {
        guard CMMotionActivityManager.isActivityAvailable() else { done("denied"); return }
        manager.queryActivityStarting(from: Date().addingTimeInterval(-60), to: Date(), to: queue) { _, _ in
            done(ActivityTracker.authorization)
        }
    }
}

/// Screen / unlock state (via protected-data availability + app lifecycle) and battery level.
final class DeviceState {
    private(set) var screenOn = true
    private(set) var lastUnlockAt: Date?
    private var observers: [NSObjectProtocol] = []

    var batteryPct: UInt8 {
        let l = UIDevice.current.batteryLevel
        return l < 0 ? 100 : UInt8(max(0, min(100, (l * 100).rounded())))
    }

    func start(_ onChange: @escaping () -> Void) {
        DispatchQueue.main.async {
            UIDevice.current.isBatteryMonitoringEnabled = true
            self.screenOn = UIApplication.shared.applicationState == .active || UIApplication.shared.isProtectedDataAvailable
            let nc = NotificationCenter.default
            func observe(_ name: Notification.Name, _ f: @escaping () -> Void) {
                self.observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { _ in f(); onChange() })
            }
            observe(UIApplication.protectedDataDidBecomeAvailableNotification) { self.screenOn = true; self.lastUnlockAt = Date() }
            observe(UIApplication.protectedDataWillBecomeUnavailableNotification) { self.screenOn = false }
            observe(UIApplication.didBecomeActiveNotification) { self.screenOn = true; self.lastUnlockAt = Date() }
            observe(UIDevice.batteryLevelDidChangeNotification) {}
        }
    }
}
