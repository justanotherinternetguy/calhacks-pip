import CoreLocation
import Foundation
import UIKit

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

extension Activity {
    var key: String {
        switch self {
        case .unknown: return "unknown"
        case .stationary: return "stationary"
        case .walking: return "walking"
        case .running: return "running"
        case .vehicle: return "vehicle"
        }
    }
}

extension IncidentKind {
    /// lowercase snake, as the JS dashboard expects (CONTRACTS §6).
    var key: String {
        switch self {
        case .gaitDrift: return "gait_drift"
        case .impact: return "impact"
        case .grab: return "grab"
        case .stillness: return "stillness"
        case .separated: return "separated"
        case .typingOff: return "typing_off"
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
    private var tickInterval: TimeInterval = 0
    private var tickCount = 0
    /// Wall-clock ms of the last `tick()` (0 before the first); `dashboard()` ticks first when this is > 1 s old.
    private var lastTickMs: UInt64 = 0
    /// `setDashboardStreaming(true)`: forces FULL sampling + the 1 s tick and emits `dashboard` after every tick.
    private var dashboardStreaming = false
    /// Last `SamplingRateChanged` request from the engine; LOW until it asks for more (CONTRACTS §6).
    private var requestedMode: MotionSampler.Mode = .low
    /// Native-side ring of the last 64 `SignalIncident` records (dedupes re-emits; the engine owns the real log).
    private(set) var signalRing: [IncidentRecord] = []
    private var lastBaselineSaveMs: UInt64 = 0
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
            TouchTracker.shared.onUnlock = { [weak self] in self?.phoneUnlocked() }
            TouchTracker.shared.install()
            self.audio.onScores = { [weak self] s in self?.engine?.pushAudio(s: s) }
            self.nightMode.onChange = { [weak self] active, _ in self?.q.async { self?.nightModeChanged(active) } }
            self.nightMode.onLocation = { [weak self] loc in self?.q.async { self?.lastLocation = loc; self?.locations.onLocation(loc) } }
            self.nightMode.start()
        }
    }

    private func makeEngine(_ c: NativeConfig) throws {
        let blob: Data? = Store.read("baseline.bin")
        let e = try SafetyEngine(configToml: c.modelConfigToml, baselineBlob: blob, nowMs: nowMs())
        e.setLearning(enabled: UserDefaults.standard.object(forKey: "safe.learning") as? Bool ?? true)
        engine = e
        lastBaselineSaveMs = SafeClock.nowMs()
        startMotion()
    }

    /// Engine blob (baselines + incident log, CONTRACTS §6). Written every 5 min from the tick and at session stop.
    private func saveBaseline() {
        guard let engine else { return }
        Store.write(engine.exportBaseline(), "baseline.bin")
        lastBaselineSaveMs = SafeClock.nowMs()
    }

    // MARK: motion sampling (runs whenever an engine exists, not only in night sessions)

    /// FULL during a baseline walk or while the dashboard is streaming (CONTRACTS §6: the personal dashboard shows
    /// the full-rate metrics), otherwise whatever the engine last asked for.
    private var effectiveMode: MotionSampler.Mode { (baselineWalkStart != nil || dashboardStreaming) ? .full : requestedMode }

    /// Starts (or re-modes) the sampler and makes sure the ticker runs. Outside the continuous-location session
    /// iOS suspends the process shortly after backgrounding, so idle sampling only covers foreground use and
    /// resumes with the app; the pedometer / activity manager are left alone until Motion & Fitness is granted.
    private func startMotion() {
        guard engine != nil else { return }
        motion.start(mode: effectiveMode) { [weak self] batch in self?.engine?.pushMotion(samples: batch) }
        if ActivityTracker.authorization == "granted" { activity.start() }
        scheduleTicker()
    }

    /// Owner unlocked / foregrounded the phone (TouchTracker): clears a grab inside its 2-minute window.
    private func phoneUnlocked() {
        q.async {
            guard let engine = self.engine else { return }
            engine.pushAction(a: .phoneUnlocked, nowMs: self.nowMs())
            if self.sessionActive { self.tick() }
        }
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
        startMotion()
        activity.start()   // may prompt for Motion & Fitness if onboarding never did
        heartbeat.start()
        proximity.start()
        startAudio()
        if let c = config { Task { await self.escrow.ensureEpoch(cfg: c, group: self.group, rest: self.rest) } }
        scheduleTicker()
        emitStatus()
    }

    private func stopSession() {
        guard sessionActive else { return }
        sessionActive = false
        audio.stop()
        heartbeat.stop()
        proximity.stop()
        nightMode.stopContinuousLocation()
        engine?.setNightMode(active: false, nowMs: nowMs())
        saveBaseline()
        // Motion keeps sampling in the engine-requested mode; the ticker drops to the idle cadence.
        if baselineWalkStart == nil, ActivityTracker.authorization != "granted" { activity.stop() }
        scheduleTicker()
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

    private var wantsFastTick: Bool { sessionActive || baselineWalkStart != nil || dashboardStreaming }

    /// 1 s during a night session / baseline walk / dashboard streaming; 5 s idle, so the engine still sees
    /// `Context` (and can ask for FULL sampling or learn from daytime walks) while only the low-rate sampler runs.
    /// Reschedules in place when the cadence changes; stops when there is nothing to feed.
    private func scheduleTicker() {
        let interval: TimeInterval = wantsFastTick ? 1 : 5
        guard engine != nil, wantsFastTick || motion.running else { stopTicker(); return }
        guard tickTimer == nil || interval != tickInterval else { return }
        stopTicker()
        tickInterval = interval
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(100))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        tickTimer = t
    }

    private func stopTicker() { tickTimer?.cancel(); tickTimer = nil; tickInterval = 0 }

    // MARK: tick (1 s in session / baseline walk / dashboard streaming, 5 s idle)

    func tickNow(onQueue: Bool = false) { onQueue ? tick() : q.async { self.tick() } }

    /// Pushes a fresh `Context` (so `samplingFull` / `lastTouchMs` / `distanceHomeM` are current on every tick,
    /// including each 1 s dashboard frame), ticks the engine, dispatches its events, then — while streaming —
    /// emits `dashboard` from the state that tick just produced (no separate timer racing the tick).
    private func tick() {
        guard let engine else { return }
        let now = nowMs()
        tickCount += 1
        lastTickMs = SafeClock.nowMs()
        if virtualNowMs == nil { engine.pushContext(ctx: currentContext(now)) }   // trace replay supplies its own
        for ev in engine.tick(nowMs: now) { handle(ev) }
        if let pc = pendingCheck, now >= pc.deadlineMs {
            pendingCheck = nil
            engine.pushAction(a: .checkTimeout, nowMs: now)
        }
        if SafeClock.nowMs() &- lastBaselineSaveMs >= 300_000 { saveBaseline() }   // every 5 min, idle or not
        if dashboardStreaming { emitDashboard() }
        guard sessionActive else { return }
        let snap = engine.snapshot()
        if snap.riskBand > 0 || snap.hmmState != .normal { audio.boost(seconds: 120) }
        audio.schedule()
        if tickCount % 60 == 0, let c = config {
            Task { await self.escrow.ensureEpoch(cfg: c, group: self.group, rest: self.rest) }   // midnight rotation
        }
        if tickCount % 5 == 0 { emitStatus(snap) }
    }

    private func currentContext(_ now: UInt64) -> Context {
        var act = activity.current
        if act == .unknown, let t = motion.lastStepAt, Date().timeIntervalSince(t) < 10 { act = .walking }
        let loc = lastLocation ?? nightMode.lastKnownLocation
        let speed: Float = loc.map { $0.speed >= 0 ? Float($0.speed) : -1 } ?? -1
        let distanceHome: Float = loc.flatMap { nightMode.distanceToNearestHome(from: $0) }.map { Float($0) } ?? -1
        return Context(tMs: now, awayFromHome: nightMode.awayFromHome, separated: proximity.separated,
                       hourLocal: SafeClock.hourLocal(), screenOn: device.screenOn, activity: act,
                       batteryPct: device.batteryPct, speedMps: speed,
                       lastTouchMs: TouchTracker.shared.lastTouchMs, distanceHomeM: distanceHome, samplingFull: motion.isFull)
    }

    private func handle(_ ev: EngineEvent) {
        switch ev {
        case .checkRequested(let phrase, let deadlineMs):
            pendingCheck = (phrase, deadlineMs)
            alerts.postCheckIn(phrase: phrase, deadlineMs: deadlineMs)
            emit?("checkRequested", ["phrase": phrase, "deadlineMs": deadlineMs])
            audio.boost(seconds: 120)
        case .headsUp(let summary):
            // Also emitted immediately on a grab (CONTRACTS §6): friends are told, but no keys are released
            // until `.unlockLocation` follows (2 min later unless the owner unlocks / biometric-dismisses).
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
        case .samplingRateChanged(let hz, let gyro):
            requestedMode = MotionSampler.modeFor(hz: hz, gyro: gyro)
            if motion.running { motion.setMode(effectiveMode) } else { startMotion() }
        case .signalIncident(let record):
            guard !signalRing.contains(where: { $0.id == record.id }) else { return }
            signalRing.append(record)
            if signalRing.count > 64 { signalRing.removeFirst(signalRing.count - 64) }
            if sessionActive { audio.boost(seconds: 120) }   // listen harder for 2 min after any motion signal
            emit?("signalIncident", incidentDict(record))
        case .callOptionAvailable(let summary):
            emit?("callOption", ["summary": summary])
            postCallOption(summary)
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

    /// 10 min with no response (CONTRACTS §6): friends get the one-tap campus-safety / 911 option. The engine
    /// only emits this after an unlock, so the `incidents` row already exists; without one we just emit to JS.
    private func postCallOption(_ summary: String) {
        guard let c = config, rest.isConfigured, let incidentId = currentIncidentId else { return }
        Task { [rest = self.rest] in
            try? await rest.insert("incident_events", ["incident_id": incidentId, "actor_id": c.userId, "kind": "call_option",
                                                       "payload": ["summary": summary]])
            try? await rest.function("push", ["incidentId": incidentId, "kind": "call_option", "title": "Your friend still hasn't responded",
                                              "body": summary, "critical": true])
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
            return ["accepted": v.accepted, "zScore": num(v.zScore), "reason": v.reason]
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
            self.startMotion()   // effectiveMode is FULL for the walk
            self.activity.start()
            self.scheduleTicker()
        }
    }

    func stopBaselineWalk() -> Int {
        q.sync {
            let seconds = baselineWalkStart.map { Int(Date().timeIntervalSince($0)) } ?? 0
            baselineWalkStart = nil
            motion.setMode(effectiveMode)   // back to the engine-requested mode
            if !sessionActive, ActivityTracker.authorization != "granted" { activity.stop() }
            scheduleTicker()
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
        return ["pDanger": num(s.pDanger), "hmmState": s.hmmState.key, "escalation": s.escalation.key, "riskBand": Int(s.riskBand),
                "evidence": s.evidence, "baselineSeconds": Int(s.baselineSeconds), "placement": s.placement.key, "nightMode": s.nightMode]
    }

    // MARK: dashboard (CONTRACTS §6)

    /// `getDashboard()`: ticks the engine first when the last tick is more than 1 s old (idle 5 s cadence, or no
    /// ticker at all), so a one-shot read never returns stale metrics.
    func dashboard() -> [String: Any] {
        q.sync {
            if SafeClock.nowMs() &- lastTickMs > 1_000 { tick() }
            return dashboardLocked()
        }
    }

    /// While on, FULL sampling is forced (`effectiveMode`), the engine ticks every 1 s (`scheduleTicker`) and
    /// `dashboard` (metrics + the engine's incident log) is emitted right after each tick. Idempotent; `false`
    /// (or module teardown) returns the sampler to the engine-requested mode and the ticker to its normal cadence.
    func setDashboardStreaming(_ on: Bool) {
        q.async {
            guard on != self.dashboardStreaming else { return }
            self.dashboardStreaming = on
            if self.motion.running { self.motion.setMode(self.effectiveMode) } else { self.startMotion() }
            self.scheduleTicker()
            let sampling = self.motion.running ? self.motion.mode.label : "off"
            let cadence = self.tickInterval > 0 ? "\(Int(self.tickInterval)) s" : "off"
            NSLog("[safe] dashboard streaming \(on ? "on" : "off"): sampling \(sampling), engine requested \(self.requestedMode.label), tick \(cadence)")
            if on {
                // First frame now rather than after the first 1 s interval; with no engine yet, the neutral payload.
                if self.engine != nil { self.tick() } else { self.emitDashboard() }
            }
        }
    }

    private func emitDashboard() { emit?("dashboard", dashboardLocked()) }

    private func dashboardLocked() -> [String: Any] {
        guard let engine else { return ["metrics": metricsDict(nil), "incidents": [[String: Any]]()] }
        return ["metrics": metricsDict(engine.metrics()), "incidents": engine.incidentLog().map(incidentDict)]
    }

    /// Floats as JS numbers; NaN / ±inf (possible before a baseline exists) become 0 so JSON encoding never throws.
    private func num(_ f: Float) -> Double { f.isFinite ? Double(f) : 0 }

    private func metricsDict(_ m: LiveMetrics?) -> [String: Any] {
        guard let m else {
            return ["tMs": 0, "placement": "unknown", "samplingFull": motion.isFull, "activity": "unknown", "bands": [[String: Any]](),
                    "pNormal": 1, "pImpaired": 0, "pIncident": 0, "pUnresponsive": 0,
                    "baselineTrusted": false, "baselineWalkDays": 0, "evidence": ""]
        }
        return ["tMs": m.tMs, "placement": m.placement.key, "samplingFull": m.samplingFull, "activity": m.activity.key,
                "bands": m.bands.map(bandDict),
                "pNormal": num(m.pNormal), "pImpaired": num(m.pImpaired), "pIncident": num(m.pIncident), "pUnresponsive": num(m.pUnresponsive),
                "baselineTrusted": m.baselineTrusted, "baselineWalkDays": num(m.baselineWalkDays), "evidence": m.evidence]
    }

    private func bandDict(_ b: MetricBand) -> [String: Any] {
        ["name": b.name, "value": num(b.value), "mean": num(b.mean), "sd": num(b.sd), "sdDistance": num(b.sdDistance), "inBand": b.inBand]
    }

    private func incidentDict(_ r: IncidentRecord) -> [String: Any] {
        ["id": Int(r.id), "tMs": r.tMs, "kind": r.kind.key, "summary": r.summary, "sdDistance": num(r.sdDistance),
         "placement": r.placement.key, "rawJson": r.rawJson,
         "pNormal": num(r.pNormal), "pImpaired": num(r.pImpaired), "pIncident": num(r.pIncident), "pUnresponsive": num(r.pUnresponsive),
         "sequenceId": Int(r.sequenceId), "watched": r.watched]
    }
}
