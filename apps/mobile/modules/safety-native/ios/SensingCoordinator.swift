import CoreLocation
import Foundation
import UIKit
#if canImport(safety)
import safety
#endif

struct NativeConfig: Codable {
    var supabaseUrl: String
    var supabaseAnonKey: String
    var userId: String
    var deviceId: String
    var modelConfigToml: String
}

extension HmmState {
    var key: String {
        switch self {
        case .normal: return "normal"
        case .impaired: return "impaired"
        case .incident: return "incident"
        case .unresponsive: return "unresponsive"
        }
    }
}

extension EscalationLevel {
    var key: String {
        switch self {
        case .idle: return "idle"
        case .check: return "check"
        case .headsUp: return "heads_up"
        case .unlocked: return "unlocked"
        case .snatch: return "snatch"
        case .resolved: return "resolved"
        }
    }
}

extension Placement {
    var key: String {
        switch self {
        case .unknown: return "unknown"
        case .pocket: return "pocket"
        case .hand: return "hand"
        case .bag: return "bag"
        }
    }
}

/// Process-wide singleton that owns the Rust `SafetyEngine` and wires sensors → engine → actions.
/// All mutable state is touched on `q`; components call back onto `q`.
final class SensingCoordinator {
    static let shared = SensingCoordinator()
    let q = DispatchQueue(label: "app.safe.coordinator", qos: .userInitiated)

    let rest = SupabaseRest()
    let nightMode = NightModeController()
    let alerts = AlertManager()
    let escrow = EscrowManager()
    let audio = AudioMonitor()
    let motion = MotionSampler()
    let activity = ActivityTracker()
    let device = DeviceState()
    private(set) lazy var sos = SosManager(self)
    private(set) lazy var heartbeat = HeartbeatUploader(self)
    private(set) lazy var locations = LocationUploader(self)
    private(set) lazy var proximity = ProximityUploader(self)
    private let injector = TraceInjector()

    private(set) var config: NativeConfig? = Store.loadJSON("config.json")
    private(set) var group: GroupConfig? = Store.loadJSON("group.json")
    private(set) var engine: SafetyEngine?
    private(set) var sessionActive = false
    private var sessionForced = false
    private(set) var lastLocation: CLLocation?
    private(set) var currentIncidentId: String?
    private var tickTimer: DispatchSourceTimer?
    private var tickCount = 0
    private var pendingCheck: (phrase: String, deadlineMs: UInt64)?
    private var baselineWalkStart: Date?
    private var booted = false
    private var virtualNowMs: UInt64?

    /// Set by the Expo module: forwards (eventName, payload) to JS.
    var emit: ((String, [String: Any]) -> Void)?

    private init() {}

    func nowMs() -> UInt64 { virtualNowMs ?? SafeClock.nowMs() }

    // MARK: bootstrap (app launch, including background launches by CoreLocation)

    func bootstrap() {
        q.async {
            guard !self.booted else { return }
            self.booted = true
            if let c = self.config {
                self.rest.configure(url: c.supabaseUrl, anonKey: c.supabaseAnonKey, accessToken: Keychain.getString("accessToken") ?? "")
                try? self.makeEngine(c)
            }
            self.alerts.install(coordinator: self)
            self.device.start { [weak self] in self?.q.async { self?.emitStatus() } }
            self.audio.onScores = { [weak self] s in self?.engine?.pushAudio(s: s) }
            self.nightMode.onChange = { [weak self] active, _ in self?.q.async { self?.nightModeChanged(active) } }
            self.nightMode.onLocation = { [weak self] loc in self?.q.async { self?.lastLocation = loc; self?.locations.onLocation(loc) } }
            self.nightMode.start()
        }
    }

    private func makeEngine(_ c: NativeConfig) throws {
        let blob = Store.read("baseline.bin").map { [UInt8]($0) }
        let e = try SafetyEngine(configToml: c.modelConfigToml, baselineBlob: blob, nowMs: nowMs())
        e.setLearning(enabled: UserDefaults.standard.object(forKey: "safe.learning") as? Bool ?? true)
        engine = e
    }

    private func saveBaseline() {
        guard let engine else { return }
        Store.write(Data(engine.exportBaseline()), "baseline.bin")
    }

    // MARK: configuration (called from the Expo module)

    func configure(_ c: NativeConfig, accessToken: String) throws {
        try q.sync {
            Store.saveJSON(c, "config.json")
            Keychain.setString(accessToken, for: "accessToken")
            config = c
            rest.configure(url: c.supabaseUrl, anonKey: c.supabaseAnonKey, accessToken: accessToken)
            try makeEngine(c)
            let id = escrow.identity
            Task { [rest = self.rest] in
                try? await rest.insert("devices", ["id": c.deviceId, "user_id": c.userId, "platform": "ios",
                                                   "x25519_pub": id.x25519Public.b64, "ed25519_pub": id.ed25519Public.b64], upsert: true)
            }
            if nightMode.active { startSession() }
        }
        nightMode.evaluate()
    }

    func setAccessToken(_ token: String) {
        Keychain.setString(token, for: "accessToken")
        rest.setAccessToken(token)
    }

    func setGroup(_ g: GroupConfig) async throws {
        q.sync { group = g; Store.saveJSON(g, "group.json") }
        guard let c = config, rest.isConfigured else { throw SafeError("configure() first") }
        try await escrow.rotate(cfg: c, group: g, rest: rest)   // PLAN §5: membership change → immediate rotation
    }

    func identity() -> [String: Any] {
        let id = escrow.identity
        let uid = config?.userId ?? ""
        return ["userId": uid, "x25519Pub": id.x25519Public.b64, "ed25519Pub": id.ed25519Public.b64,
                "fingerprint": escrow.fingerprintString(userId: uid)]
    }

    // MARK: permissions

    func requestPermission(_ kind: String) async -> String {
        await withCheckedContinuation { cont in
            switch kind {
            case "locationAlways": nightMode.requestAlways { cont.resume(returning: $0) }
            case "motion": activity.requestPermission { cont.resume(returning: $0) }
            case "microphone": AudioMonitor.requestPermission { cont.resume(returning: $0) }
            case "notifications": alerts.requestPermission { cont.resume(returning: $0) }
            default: cont.resume(returning: "denied")
            }
        }
    }

    private func permissions() -> [String: Any] {
        alerts.refreshPermission()
        return ["locationAlways": nightMode.authorization, "motion": ActivityTracker.authorization,
                "microphone": AudioMonitor.permission, "notifications": alerts.notificationPermission]
    }

    // MARK: night session

    private func nightModeChanged(_ active: Bool) {
        if active { startSession() } else if !sessionForced { stopSession() }
        emitStatus()
    }

    /// SOS / needHelp / trace replay keep sensing alive regardless of the night-mode decision.
    func forceSessionLocked(_ on: Bool) {
        sessionForced = on
        if on { startSession() } else if !nightMode.active { stopSession() }
    }
    func forceSession(_ on: Bool) { q.async { self.forceSessionLocked(on) } }

    private func startSession() {
        guard !sessionActive, let engine else { return }
        sessionActive = true
        engine.setNightMode(active: true, nowMs: nowMs())
        nightMode.startContinuousLocation()
        motion.start { [weak self] batch in self?.engine?.pushMotion(samples: batch) }
        activity.start()
        heartbeat.start()
        proximity.start()
        startAudio()
        if let c = config { Task { await self.escrow.ensureEpoch(cfg: c, group: self.group, rest: self.rest) } }
        startTicker()
        emitStatus()
    }

    private func stopSession() {
        guard sessionActive else { return }
        sessionActive = false
        if baselineWalkStart == nil { stopTicker(); motion.stop(); activity.stop() }
        audio.stop()
        heartbeat.stop()
        proximity.stop()
        nightMode.stopContinuousLocation()
        engine?.setNightMode(active: false, nowMs: nowMs())
        saveBaseline()
        emitStatus()
    }

    private func startAudio() {
        guard audio.available, !audio.running else { return }
        do { try audio.start() } catch {
            NSLog("[safe] mic start failed: \(error)")
            DispatchQueue.main.async {   // background start refused → one-tap nudge (PLAN §2)
                if UIApplication.shared.applicationState != .active { self.alerts.postMicNudge() }
            }
        }
    }

    func retryAudio() { q.async { if self.sessionActive { self.startAudio() } } }

    private func startTicker() {
        guard tickTimer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        tickTimer = t
    }

    private func stopTicker() { tickTimer?.cancel(); tickTimer = nil }

    // MARK: 1 s tick

    func tickNow(onQueue: Bool = false) { onQueue ? tick() : q.async { self.tick() } }

    private func tick() {
        guard let engine, sessionActive || baselineWalkStart != nil else { return }
        let now = nowMs()
        tickCount += 1
        if virtualNowMs == nil { engine.pushContext(ctx: currentContext(now)) }   // trace replay supplies its own
        for ev in engine.tick(nowMs: now) { handle(ev) }
        if let pc = pendingCheck, now >= pc.deadlineMs {
            pendingCheck = nil
            engine.pushAction(a: .checkTimeout, nowMs: now)
        }
        guard sessionActive else { return }
        let snap = engine.snapshot()
        if snap.riskBand > 0 || snap.hmmState != .normal { audio.boost(seconds: 120) }
        audio.schedule()
        if tickCount % 60 == 0 {
            saveBaseline()
            if let c = config { Task { await self.escrow.ensureEpoch(cfg: c, group: self.group, rest: self.rest) } }   // midnight rotation
        }
        if tickCount % 5 == 0 { emitStatus(snap) }
    }

    private func currentContext(_ now: UInt64) -> Context {
        var act = activity.current
        if act == .unknown, let t = motion.lastStepAt, Date().timeIntervalSince(t) < 10 { act = .walking }
        let speed: Float = lastLocation.map { $0.speed >= 0 ? Float($0.speed) : -1 } ?? -1
        return Context(tMs: now, awayFromHome: nightMode.awayFromHome, separated: proximity.separated,
                       hourLocal: SafeClock.hourLocal(), screenOn: device.screenOn, activity: act,
                       batteryPct: device.batteryPct, speedMps: speed)
    }

    private func handle(_ ev: EngineEvent) {
        switch ev {
        case .checkRequested(let phrase, let deadlineMs):
            pendingCheck = (phrase, deadlineMs)
            alerts.postCheckIn(phrase: phrase, deadlineMs: deadlineMs)
            emit?("checkRequested", ["phrase": phrase, "deadlineMs": deadlineMs])
            audio.boost(seconds: 120)
        case .headsUp(let summary):
            escalate(level: "heads_up", summary: summary, eventKind: "heads_up", title: "Your friend might not be okay", critical: false, releaseKeys: false)
        case .unlockLocation(let summary):
            escalate(level: sos.active ? "sos" : "unlocked", summary: summary, eventKind: "release",
                     title: "Your friend needs help", critical: true, releaseKeys: true)
            locations.forceUpload()
        case .snatchDetected(let summary):
            var body: [String: Any] = ["summary": summary]
            if let l = lastLocation { body["lat"] = l.coordinate.latitude; body["lng"] = l.coordinate.longitude }
            emit?("snatch", body)
            escalate(level: "snatch", summary: summary, eventKind: "release",
                     title: "Your friend's phone may have been snatched", critical: true, releaseKeys: true)
            locations.forceUpload()
        case .resolved:
            pendingCheck = nil
            alerts.clearCheckIn()
            alerts.stopAlarm()
            sos.markResolved()
            resolveIncident()
            emit?("escalation", ["level": "resolved", "summary": ""])
        case .riskBandChanged:
            heartbeat.sendNow()
            emitStatus()
        case .batteryDying:
            locations.forceUpload()
            escalate(level: "battery_dying", summary: "battery dying", eventKind: "battery_dying",
                     title: "Your friend's phone is about to die", critical: false, releaseKeys: false)
        case .locationIntervalChanged(let seconds):
            locations.interval = TimeInterval(seconds)
        }
    }

    // MARK: incidents (rows + push fan-out)

    private func escalate(level: String, summary: String, eventKind: String, title: String, critical: Bool, releaseKeys: Bool) {
        emit?("escalation", ["level": level == "sos" ? "unlocked" : level, "summary": summary])
        guard let c = config, rest.isConfigured else { return }
        let g = group, existing = currentIncidentId
        Task { [weak self] in
            guard let self else { return }
            var incidentId = existing
            if let id = incidentId {
                if level != "battery_dying" { try? await self.rest.patch("incidents", query: ["id": "eq.\(id)"], ["level": level, "summary": summary]) }
            } else {
                var row: [String: Any] = ["user_id": c.userId, "level": level, "summary": summary]
                row["group_id"] = g?.groupId.map { $0 as Any } ?? NSNull()
                incidentId = (try? await self.rest.insert("incidents", row, returning: true))?.first?["id"] as? String
                if let id = incidentId { self.q.async { self.currentIncidentId = id } }
            }
            guard let incidentId else { return }
            var payload: [String: Any] = ["summary": summary]
            if releaseKeys, let g {
                do { try await self.escrow.releaseHourKeys(incidentId: incidentId, cfg: c, group: g, rest: self.rest); payload["released"] = true }
                catch { payload["release_error"] = "\(error)" }
            }
            try? await self.rest.insert("incident_events", ["incident_id": incidentId, "actor_id": c.userId, "kind": eventKind, "payload": payload])
            try? await self.rest.function("push", ["incidentId": incidentId, "kind": level, "title": title, "body": summary, "critical": critical])
        }
    }

    private func resolveIncident() {
        guard let id = currentIncidentId, let c = config else { return }
        currentIncidentId = nil
        Task { [rest = self.rest] in
            try? await rest.patch("incidents", query: ["id": "eq.\(id)"], ["level": "resolved", "resolved_at": SafeClock.iso8601()])
            try? await rest.insert("incident_events", ["incident_id": id, "actor_id": c.userId, "kind": "resolved", "payload": [:]])
        }
    }

    // MARK: user actions

    func submitCheckIn(phrase: String, typed: String, keyTimesMs: [UInt64], backspaces: UInt32, durationMs: UInt64) throws -> [String: Any] {
        try q.sync {
            guard let engine else { throw SafeError("configure() first") }
            let now = nowMs()
            let v = engine.pushTyping(s: TypingSample(phrase: phrase, typed: typed, keyTimesMs: keyTimesMs, backspaces: backspaces, durationMs: durationMs), nowMs: now)
            engine.pushAction(a: v.accepted ? .dismissOk : .dismissWrongPhrase, nowMs: now)
            if v.accepted { pendingCheck = nil; alerts.clearCheckIn() }
            tick()
            return ["accepted": v.accepted, "zScore": v.zScore, "reason": v.reason]
        }
    }

    /// Typing practice during onboarding. DEVIATION: the FFI has no dedicated practice entry point, so we
    /// feed `pushTyping` while escalation is Idle and let the engine's learning path absorb it.
    func recordTypingPractice(phrase: String, typed: String, keyTimesMs: [UInt64], backspaces: UInt32, durationMs: UInt64) {
        q.async {
            _ = self.engine?.pushTyping(s: TypingSample(phrase: phrase, typed: typed, keyTimesMs: keyTimesMs, backspaces: backspaces, durationMs: durationMs), nowMs: self.nowMs())
            self.saveBaseline()
        }
    }

    func needHelp() {
        q.async {
            guard let engine = self.engine else { return }
            self.pendingCheck = nil
            self.alerts.clearCheckIn()
            engine.pushAction(a: .needHelp, nowMs: self.nowMs())
            self.forceSessionLocked(true)
            self.tick()
        }
    }

    /// Notification tap brought the app forward: re-send the pending check so JS opens the typing screen.
    func reemitCheck() {
        q.async { if let pc = self.pendingCheck { self.emit?("checkRequested", ["phrase": pc.phrase, "deadlineMs": pc.deadlineMs]) } }
    }

    func triggerSos() { sos.trigger() }
    func cancelSos() async -> Bool { await sos.cancel() }

    func startBaselineWalk() {
        q.async {
            guard let engine = self.engine else { return }
            engine.setLearning(enabled: true)
            UserDefaults.standard.set(true, forKey: "safe.learning")
            self.baselineWalkStart = Date()
            self.motion.start { [weak self] batch in self?.engine?.pushMotion(samples: batch) }
            self.activity.start()
            self.startTicker()
        }
    }

    func stopBaselineWalk() -> Int {
        q.sync {
            let seconds = baselineWalkStart.map { Int(Date().timeIntervalSince($0)) } ?? 0
            baselineWalkStart = nil
            if !sessionActive { stopTicker(); motion.stop(); activity.stop() }
            saveBaseline()
            return seconds
        }
    }

    func ringAlarm(seconds: Double) {
        alerts.post(id: "ring", title: "A friend is ringing your phone", body: "Tap to let them know you're okay.")
        alerts.ringAlarm(seconds: seconds, keepRecording: audio.running)
    }

    func stopAlarm() { alerts.stopAlarm() }

    func injectTrace(json: String) async throws { try await injector.replay(json: json, into: self) }
    func setVirtualClock(_ ms: UInt64?) { q.sync { virtualNowMs = ms } }

    // MARK: status

    func status() -> [String: Any] { q.sync { statusLocked(engine?.snapshot()) } }

    private func emitStatus(_ snap: Snapshot? = nil) {
        guard let emit else { return }
        emit("statusChanged", statusLocked(snap ?? engine?.snapshot()))
    }

    private func statusLocked(_ s: Snapshot?) -> [String: Any] {
        var nm: [String: Any] = ["active": nightMode.active, "reason": nightMode.reason]
        if let since = nightMode.since { nm["since"] = UInt64(since.timeIntervalSince1970 * 1000) }
        var st: [String: Any] = [
            "nightMode": nm,
            "engine": snapshotDict(s),
            "permissions": permissions(),
            "batteryPct": Int(device.batteryPct),
            "serviceRunning": sessionActive,
        ]
        if let hb = heartbeat.lastSentMs { st["lastHeartbeatMs"] = hb }
        return st
    }

    private func snapshotDict(_ s: Snapshot?) -> [String: Any] {
        guard let s else {
            return ["pDanger": 0, "hmmState": "normal", "escalation": "idle", "riskBand": 0, "evidence": "",
                    "baselineSeconds": 0, "placement": "unknown", "nightMode": false]
        }
        return ["pDanger": s.pDanger, "hmmState": s.hmmState.key, "escalation": s.escalation.key, "riskBand": Int(s.riskBand),
                "evidence": s.evidence, "baselineSeconds": Int(s.baselineSeconds), "placement": s.placement.key, "nightMode": s.nightMode]
    }
}
