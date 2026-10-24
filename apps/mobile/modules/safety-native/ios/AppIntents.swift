import AppIntents
import Foundation

/// Manual SOS via Action Button, Siri ("Send SOS with <app>"), Shortcuts and the lock-screen widget.
/// Runs in the app process (`openAppWhenRun = false` keeps it silent), so it reaches the coordinator directly.
/// The same file is compiled into the widget extension (see Widget/SosWidget.swift), where
/// `SAFE_WIDGET_EXTENSION` makes it open the app instead because the coordinator lives only in the app.
@available(iOS 16.0, *)
struct TriggerSosIntent: AppIntent {
    static var title: LocalizedStringResource = "Send SOS"
    static var description = IntentDescription("Alerts your friends that you need help and shares your encrypted location with them.")
    #if SAFE_WIDGET_EXTENSION
    static var openAppWhenRun: Bool = true
    #else
    static var openAppWhenRun: Bool = false
    #endif

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        #if !SAFE_WIDGET_EXTENSION
        SensingCoordinator.shared.triggerSos()
        #endif
        return .result(dialog: "SOS sent. Your friends have been alerted.")
    }
}

@available(iOS 16.0, *)
struct SafetyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: TriggerSosIntent(),
                    phrases: ["Send SOS with \(.applicationName)", "I need help in \(.applicationName)"])
    }
}
