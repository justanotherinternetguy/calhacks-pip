import CoreLocation
import Foundation
#if canImport(safety)
import safety
#endif

/// `PATCH devices` every 2 min in night mode: last_heartbeat, night_mode, battery_pct, risk_band, status_level. No location.
final class HeartbeatUploader {
    private unowned let c: SensingCoordinator
    private var timer: DispatchSourceTimer?
    private(set) var lastSentMs: UInt64?

    init(_ c: SensingCoordinator) { self.c = c }

    func start() {
        timer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: c.q)
        t.schedule(deadline: .now(), repeating: 120, leeway: .seconds(10))
        t.setEventHandler { [weak self] in self?.sendNow() }
        t.resume()
        timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
        sendNow(nightMode: false)   // final heartbeat tells the watchdog we left night mode on purpose
    }

    /// Runs on `c.q`.
    func sendNow(nightMode: Bool? = nil) {
        guard let cfg = c.config, c.rest.isConfigured else { return }
        let snap = c.engine?.snapshot()
        let body: [String: Any] = [
            "last_heartbeat": SafeClock.iso8601(),
            "night_mode": nightMode ?? c.sessionActive,
            "battery_pct": Int(c.device.batteryPct),
            "risk_band": Int(snap?.riskBand ?? 0),
            "status_level": snap?.escalation.key ?? "idle",
        ]
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.c.rest.patch("devices", query: ["id": "eq.\(cfg.deviceId)"], body)
                self.c.q.async { self.lastSentMs = SafeClock.nowMs() }
            } catch { NSLog("[safe] heartbeat failed: \(error)") }
        }
    }
}

/// Encrypted location blobs every 1–5 min (engine-adaptive) under the current hour key.
final class LocationUploader {
    private unowned let c: SensingCoordinator
    private var lastUploadAt: Date?
    var interval: TimeInterval = 300 { didSet { interval = max(30, min(600, interval)) } }

    init(_ c: SensingCoordinator) { self.c = c }

    /// Runs on `c.q`.
    func onLocation(_ loc: CLLocation) {
        guard c.sessionActive else { return }
        if let last = lastUploadAt, Date().timeIntervalSince(last) < interval { return }
        upload(loc)
    }

    func forceUpload() { if let loc = c.lastLocation { upload(loc) } }

    private func upload(_ loc: CLLocation) {
        guard let cfg = c.config, c.rest.isConfigured, let epoch = c.escrow.activeEpoch else { return }
        // seq = wall-clock ms: unique per epoch without persisting a counter; AAD = "{user}|{epoch}|{seq}".
        let seq = SafeClock.nowMs()
        let hourIndex = SafeClock.hourIndex(ms: seq)
        guard let key = c.escrow.hourKey(index: hourIndex) else { return }
        lastUploadAt = Date()
        let l = Location(lat: loc.coordinate.latitude, lng: loc.coordinate.longitude,
                         accuracyM: Float(loc.horizontalAccuracy), tMs: UInt64(loc.timestamp.timeIntervalSince1970 * 1000))
        do {
            let ct = try encryptLocation(hourKey: key, userId: cfg.userId, epochId: epoch.id, seq: seq, loc: l)
            let row: [String: Any] = ["user_id": cfg.userId, "epoch_id": epoch.id, "hour_index": Int(hourIndex),
                                      "seq": seq, "ciphertext": ct.b64]
            Task { [c = self.c] in
                do { try await c.rest.insert("location_blobs", row) } catch { NSLog("[safe] location upload failed: \(error)") }
            }
        } catch { NSLog("[safe] encryptLocation failed: \(error)") }
    }
}

/// Proximity tokens every 2 min (own geohash7 cell + 8 neighbours, HMAC'd), then read back `presence.together`.
final class ProximityUploader {
    private unowned let c: SensingCoordinator
    private var timer: DispatchSourceTimer?
    private(set) var separated = false

    init(_ c: SensingCoordinator) { self.c = c }

    func start() {
        timer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: c.q)
        t.schedule(deadline: .now() + 5, repeating: 120, leeway: .seconds(10))
        t.setEventHandler { [weak self] in self?.sendNow() }
        t.resume()
        timer = t
    }

    func stop() { timer?.cancel(); timer = nil; separated = false }

    /// Runs on `c.q`.
    func sendNow() {
        guard let cfg = c.config, c.rest.isConfigured, let g = c.group, let loc = c.lastLocation else { return }
        let key = c.escrow.groupEpochKey(for: g)
        let tokens = proximityTokens(groupEpochKey: key, lat: loc.coordinate.latitude, lng: loc.coordinate.longitude).map(\.b64)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.c.rest.insert("proximity_tokens", ["user_id": cfg.userId, "group_id": g.groupId, "tokens": tokens])
                let rows = try await self.c.rest.select("presence", query: [
                    "group_id": "eq.\(g.groupId)", "user_id": "eq.\(cfg.userId)", "select": "together"])
                if let together = rows.first?["together"] as? Bool {
                    self.c.q.async { self.separated = !together }
                }
            } catch { NSLog("[safe] proximity failed: \(error)") }
        }
    }
}
