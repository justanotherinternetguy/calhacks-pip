import AVFoundation
import Foundation
import UIKit
import UserNotifications

/// Local notifications (check-in with "I'm fine" / "I need help", mic nudge, SOS confirmation) and
/// the loud alarm friends can trigger remotely. Time-sensitive interruption level; no critical alerts.
final class AlertManager: NSObject, UNUserNotificationCenterDelegate {
    static let checkCategory = "CHECKIN", micCategory = "MIC_NUDGE"
    static let actionFine = "IM_FINE", actionHelp = "NEED_HELP", actionEnableMic = "ENABLE_MIC"

    private let center = UNUserNotificationCenter.current()
    private var player: AVAudioPlayer?
    private var alarmStop: DispatchWorkItem?
    private(set) var notificationPermission = "undetermined"
    weak var coordinator: SensingCoordinator?

    func install(coordinator: SensingCoordinator) {
        self.coordinator = coordinator
        center.delegate = self   // NOTE: replaces expo-notifications' delegate; see README
        let fine = UNNotificationAction(identifier: Self.actionFine, title: "I'm fine", options: [.authenticationRequired, .foreground])
        let help = UNNotificationAction(identifier: Self.actionHelp, title: "I need help", options: [.foreground, .destructive])
        let mic = UNNotificationAction(identifier: Self.actionEnableMic, title: "Enable sound detection", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.checkCategory, actions: [fine, help], intentIdentifiers: [], options: [.customDismissAction]),
            UNNotificationCategory(identifier: Self.micCategory, actions: [mic], intentIdentifiers: [], options: []),
        ])
        refreshPermission()
    }

    func refreshPermission() {
        center.getNotificationSettings { [weak self] s in
            switch s.authorizationStatus {
            case .authorized, .provisional, .ephemeral: self?.notificationPermission = "granted"
            case .denied: self?.notificationPermission = "denied"
            default: self?.notificationPermission = "undetermined"
            }
        }
    }

    func requestPermission(_ done: @escaping (String) -> Void) {
        center.requestAuthorization(options: [.alert, .sound, .badge, .timeSensitive]) { [weak self] ok, _ in
            self?.notificationPermission = ok ? "granted" : "denied"
            done(ok ? "granted" : "denied")
        }
    }

    // MARK: notifications

    func postCheckIn(phrase: String, deadlineMs: UInt64) {
        let c = UNMutableNotificationContent()
        c.title = "You okay?"
        c.body = "Unlock and type your phrase so we know you're fine."
        c.sound = .default
        c.categoryIdentifier = Self.checkCategory
        c.threadIdentifier = "checkin"
        c.interruptionLevel = .timeSensitive
        c.userInfo = ["phrase": phrase, "deadlineMs": deadlineMs]
        center.add(UNNotificationRequest(identifier: "checkin", content: c, trigger: nil))
    }

    func clearCheckIn() {
        center.removeDeliveredNotifications(withIdentifiers: ["checkin"])
        center.removePendingNotificationRequests(withIdentifiers: ["checkin"])
    }

    func postMicNudge() {
        post(id: "mic", title: "Enable sound detection", body: "Tap to let the app listen for shouting or breaking glass tonight.",
             category: Self.micCategory, level: .active)
    }

    func post(id: String, title: String, body: String, category: String? = nil, level: UNNotificationInterruptionLevel = .timeSensitive) {
        let c = UNMutableNotificationContent()
        c.title = title
        c.body = body
        c.sound = .default
        c.interruptionLevel = level
        if let category { c.categoryIdentifier = category }
        center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
    }

    // MARK: UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let category = response.notification.request.content.categoryIdentifier
        switch (category, response.actionIdentifier) {
        case (Self.checkCategory, Self.actionHelp):
            coordinator?.needHelp()
        case (Self.checkCategory, Self.actionFine), (Self.checkCategory, UNNotificationDefaultActionIdentifier):
            coordinator?.reemitCheck()   // app is foregrounded; JS opens the typing screen
        case (Self.micCategory, _):
            coordinator?.retryAudio()
        default: break
        }
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // MARK: alarm

    /// Loud looping alarm. `.playback` (or the live `.playAndRecord` session when the mic is running)
    /// ignores the silent switch; `.defaultToSpeaker` routes playAndRecord to the loudspeaker.
    func ringAlarm(seconds: Double, keepRecording: Bool) {
        stopAlarm()
        let session = AVAudioSession.sharedInstance()
        do {
            if keepRecording {
                try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
            } else {
                try session.setCategory(.playback, mode: .default, options: [])
            }
            try session.setActive(true)
            let p = try AVAudioPlayer(data: Self.alarmSound())
            p.numberOfLoops = -1
            p.volume = 1
            p.prepareToPlay()
            p.play()
            player = p
            let stop = DispatchWorkItem { [weak self] in self?.stopAlarm() }
            alarmStop = stop
            DispatchQueue.main.asyncAfter(deadline: .now() + max(1, seconds), execute: stop)
        } catch { /* audio unavailable; notification was still posted by the caller */ }
    }

    func stopAlarm() {
        alarmStop?.cancel()
        alarmStop = nil
        player?.stop()
        player = nil
    }

    /// `alarm.caf`/`alarm.wav` from the bundle, else a generated 1 s two-tone siren (16-bit PCM WAV).
    static func alarmSound() -> Data {
        for ext in ["caf", "wav"] {
            if let url = Bundle.main.url(forResource: "alarm", withExtension: ext), let d = try? Data(contentsOf: url) { return d }
        }
        let rate = 22_050, n = rate
        var pcm = [Int16](repeating: 0, count: n)
        for i in 0..<n {
            let f: Double = (i / (rate / 8)) % 2 == 0 ? 880 : 1760
            pcm[i] = Int16(sin(2 * .pi * f * Double(i) / Double(rate)) * 32_000)
        }
        var d = Data()
        func u32(_ v: UInt32) { var le = v.littleEndian; d.append(Data(bytes: &le, count: 4)) }
        func u16(_ v: UInt16) { var le = v.littleEndian; d.append(Data(bytes: &le, count: 2)) }
        d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + n * 2)); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(n * 2))
        pcm.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
        return d
    }
}
