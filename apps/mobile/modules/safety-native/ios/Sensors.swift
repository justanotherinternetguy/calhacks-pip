import CoreMotion
import Foundation
import UIKit

/// CMMotionManager device motion at 50 Hz on a serial background OperationQueue, batched into ~1 s
/// of `MotionSample` per `pushMotion`. Also runs CMPedometer (diagnostics / activity fallback).
final class MotionSampler {
    static let hz = 50.0
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
    /// Wall-clock epoch (ms) of system boot; CMDeviceMotion.timestamp is seconds since boot.
    private let bootEpochMs = (Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime) * 1000
    private(set) var running = false
    private(set) var steps = 0
    private(set) var lastStepAt: Date?

    var available: Bool { motion.isDeviceMotionAvailable }

    func start(_ push: @escaping ([MotionSample]) -> Void) {
        guard !running, motion.isDeviceMotionAvailable else { return }
        running = true
        buffer.reserveCapacity(64)
        motion.deviceMotionUpdateInterval = 1.0 / Self.hz
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: queue) { [weak self] dm, _ in
            guard let self, let dm else { return }
            // ax..az = user acceleration (g, gravity removed); gx..gz = gravity unit vector. Device frame.
            self.buffer.append(MotionSample(
                tMs: UInt64(max(0, self.bootEpochMs + dm.timestamp * 1000)),
                ax: Float(dm.userAcceleration.x), ay: Float(dm.userAcceleration.y), az: Float(dm.userAcceleration.z),
                gx: Float(dm.gravity.x), gy: Float(dm.gravity.y), gz: Float(dm.gravity.z)))
            if self.buffer.count >= Int(Self.hz) {
                let batch = self.buffer
                self.buffer.removeAll(keepingCapacity: true)
                push(batch)
            }
        }
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

    func stop() {
        guard running else { return }
        running = false
        motion.stopDeviceMotionUpdates()
        pedometer.stopUpdates()
        queue.addOperation { [weak self] in self?.buffer.removeAll() }
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
