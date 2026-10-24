import ExpoModulesCore
import UIKit

// MARK: - Records (JS argument shapes, CONTRACTS §2)

struct ConfigureOptions: Record {
    @Field var supabaseUrl: String = ""
    @Field var supabaseAnonKey: String = ""
    @Field var accessToken: String = ""
    @Field var userId: String = ""
    @Field var deviceId: String = ""
    @Field var modelConfigToml: String = ""
}

struct HomePlaceRecord: Record {
    @Field var id: String = ""
    @Field var label: String = ""
    @Field var lat: Double = 0
    @Field var lng: Double = 0
    @Field var radiusM: Double = 150
}

struct TypingRecord: Record {
    @Field var phrase: String = ""
    @Field var typed: String = ""
    @Field var keyTimesMs: [Double] = []
    @Field var backspaces: Int = 0
    @Field var durationMs: Double = 0
}

struct MemberRecord: Record {
    @Field var userId: String = ""
    @Field var deviceId: String = ""
    @Field var x25519Pub: String = ""
    @Field var ed25519Pub: String = ""
}

struct GroupRecord: Record {
    @Field var groupId: String = ""
    @Field var thresholdK: Int = 2
    @Field var members: [MemberRecord] = []
}

struct ReleasedKeyRecord: Record {
    @Field var subjectUserId: String = ""
    @Field var epochId: String = ""
    @Field var hourIndex: Int = 0
    @Field var sealedB64: String = ""
    @Field var senderEd25519Pub: String = ""
}

struct BlobRecord: Record {
    @Field var epochId: String = ""
    @Field var seq: Double = 0        // bigint arrives as a JS number (ms timestamps fit in 2^53)
    @Field var hourIndex: Int = 0
    @Field var ciphertextB64: String = ""
}

struct ApproveRecord: Record {
    @Field var requestId: String = ""
    @Field var subjectUserId: String = ""
    @Field var epochId: String = ""
    @Field var requesterX25519Pub: String = ""
}

struct SealedShareRecord: Record {
    @Field var sealedB64: String = ""
    @Field var approverEd25519Pub: String = ""
}

struct RecoverRecord: Record {
    @Field var subjectUserId: String = ""
    @Field var epochId: String = ""
    @Field var sealedShares: [SealedShareRecord] = []
}

// MARK: - Module

public class SafetyNativeModule: Module {
    private var c: SensingCoordinator { SensingCoordinator.shared }

    public func definition() -> ModuleDefinition {
        Name("SafetyNative")

        Events("statusChanged", "checkRequested", "escalation", "snatch", "sos", "dashboard", "signalIncident", "callOption")

        OnCreate {
            SensingCoordinator.shared.emit = { [weak self] name, body in self?.sendEvent(name, body) }
            SensingCoordinator.shared.bootstrap()
        }

        OnDestroy {
            SensingCoordinator.shared.setDashboardStreaming(false)
            SensingCoordinator.shared.emit = nil
        }

        // Setup

        AsyncFunction("configure") { (opts: ConfigureOptions) throws in
            try self.c.configure(NativeConfig(supabaseUrl: opts.supabaseUrl, supabaseAnonKey: opts.supabaseAnonKey, userId: opts.userId,
                                              deviceId: opts.deviceId, modelConfigToml: opts.modelConfigToml), accessToken: opts.accessToken)
        }

        AsyncFunction("setAccessToken") { (token: String) in self.c.setAccessToken(token) }

        AsyncFunction("requestPermission") { (kind: String) async -> String in await self.c.requestPermission(kind) }

        AsyncFunction("setHomePlaces") { (places: [HomePlaceRecord]) in
            self.c.nightMode.setHomes(places.map { HomePlace(id: $0.id, label: $0.label, lat: $0.lat, lng: $0.lng, radiusM: $0.radiusM) })
        }

        AsyncFunction("setEveningWindow") { (startHour: Int, endHour: Int) in self.c.nightMode.setWindow(start: startHour, end: endHour) }

        AsyncFunction("setNightMode") { (mode: String) throws in
            guard let m = NightModeController.Mode(rawValue: mode) else { throw SafeError("unknown night mode '\(mode)'") }
            self.c.nightMode.setMode(m)
        }

        AsyncFunction("getStatus") { () -> [String: Any] in self.c.status() }

        // Dashboard (CONTRACTS §6)

        AsyncFunction("getDashboard") { () -> [String: Any] in self.c.dashboard() }
        AsyncFunction("setDashboardStreaming") { (on: Bool) in self.c.setDashboardStreaming(on) }

        // Check-in / SOS

        AsyncFunction("submitCheckIn") { (r: TypingRecord) throws -> [String: Any] in
            try self.c.submitCheckIn(phrase: r.phrase, typed: r.typed, keyTimesMs: r.keyTimesMs.map { UInt64(max(0, $0)) },
                                     backspaces: UInt32(max(0, r.backspaces)), durationMs: UInt64(max(0, r.durationMs)))
        }

        AsyncFunction("needHelp") { self.c.needHelp() }
        AsyncFunction("triggerSos") { self.c.triggerSos() }
        AsyncFunction("cancelSos") { () async -> Bool in await self.c.cancelSos() }

        // Baselines

        AsyncFunction("startBaselineWalk") { self.c.startBaselineWalk() }
        AsyncFunction("stopBaselineWalk") { () -> [String: Any] in ["seconds": self.c.stopBaselineWalk()] }

        AsyncFunction("recordTypingPractice") { (r: TypingRecord) in
            self.c.recordTypingPractice(phrase: r.phrase, typed: r.typed, keyTimesMs: r.keyTimesMs.map { UInt64(max(0, $0)) },
                                        backspaces: UInt32(max(0, r.backspaces)), durationMs: UInt64(max(0, r.durationMs)))
        }

        // Escrow (subject side)

        AsyncFunction("getIdentity") { () -> [String: Any] in self.c.identity() }

        AsyncFunction("setGroup") { (g: GroupRecord) async throws in
            try await self.c.setGroup(GroupConfig(groupId: g.groupId, thresholdK: g.thresholdK, members: g.members.map {
                GroupMember(userId: $0.userId, deviceId: $0.deviceId, x25519Pub: $0.x25519Pub, ed25519Pub: $0.ed25519Pub) }))
        }

        // Escrow (friend side)

        AsyncFunction("openReleasedKey") { (r: ReleasedKeyRecord) throws in
            try self.c.escrow.openReleasedKey(subjectUserId: r.subjectUserId, epochId: r.epochId, hourIndex: r.hourIndex,
                                              sealedB64: r.sealedB64, senderEd25519Pub: r.senderEd25519Pub)
        }

        AsyncFunction("decryptLocations") { (subjectUserId: String, blobs: [BlobRecord]) -> [[String: Any]] in
            let refs = blobs.map { EscrowManager.BlobRef(epochId: $0.epochId, seq: UInt64(max(0, $0.seq)), hourIndex: $0.hourIndex, ciphertextB64: $0.ciphertextB64) }
            return self.c.escrow.decryptLocations(subjectUserId: subjectUserId, blobs: refs).map {
                ["lat": $0.lat, "lng": $0.lng, "accuracyM": Double($0.accuracyM), "tMs": $0.tMs]   // accuracyM is Float in the FFI
            }
        }

        AsyncFunction("approveUnlock") { (r: ApproveRecord) async throws -> [String: Any] in
            let subjectEd = self.c.group?.members.first { $0.userId == r.subjectUserId }?.ed25519Pub
            let sealed = try await self.c.escrow.approveUnlock(requestId: r.requestId, subjectUserId: r.subjectUserId, epochId: r.epochId,
                                                                requesterX25519Pub: r.requesterX25519Pub, expectedSubjectEd25519Pub: subjectEd,
                                                                myUserId: self.c.config?.userId ?? "", rest: self.c.rest)
            return ["sealedShareB64": sealed]
        }

        AsyncFunction("recoverFromShares") { (r: RecoverRecord) throws -> [String: Any] in
            let ok = try self.c.escrow.recoverFromShares(subjectUserId: r.subjectUserId, epochId: r.epochId,
                                                         sealedShares: r.sealedShares.map { (sealedB64: $0.sealedB64, approverEd25519Pub: $0.approverEd25519Pub) })
            return ["ok": ok]
        }

        // Alarm / debug

        AsyncFunction("ringAlarm") { (seconds: Double) in self.c.ringAlarm(seconds: seconds) }
        AsyncFunction("stopAlarm") { self.c.stopAlarm() }
        AsyncFunction("injectTrace") { (json: String) async throws in try await self.c.injectTrace(json: json) }

        // Native typing view

        View(SafetyNativeTypingView.self) {
            Events("onKey", "onSubmit")
            Prop("phrase") { (view: SafetyNativeTypingView, phrase: String) in view.phrase = phrase }
            Prop("autoFocus") { (view: SafetyNativeTypingView, on: Bool) in view.autoFocus = on }
            AsyncFunction("reset") { (view: SafetyNativeTypingView) in view.reset() }.runOnQueue(.main)
            AsyncFunction("focus") { (view: SafetyNativeTypingView) in view.focus() }.runOnQueue(.main)
            AsyncFunction("submit") { (view: SafetyNativeTypingView) in view.submit() }.runOnQueue(.main)
        }
    }
}

/// Boots the coordinator on *every* launch, including background relaunches by CoreLocation (geofence
/// exit / significant change) where JS may never start. Register in expo-module.config.json:
/// `"ios": { "modules": ["SafetyNativeModule"], "appDelegateSubscribers": ["SafetyNativeAppDelegate"] }`.
public class SafetyNativeAppDelegate: ExpoAppDelegateSubscriber {
    public func application(_ application: UIApplication,
                            didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        SensingCoordinator.shared.bootstrap()
        return true
    }
}
