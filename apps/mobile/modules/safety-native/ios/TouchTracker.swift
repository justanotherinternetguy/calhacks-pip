import Foundation
import UIKit
import UIKit.UIGestureRecognizerSubclass   // required to override touchesBegan in a UIGestureRecognizer subclass

/// Tracks `Context.lastTouchMs` (CONTRACTS §6) and reports owner unlocks.
///
/// Sources, all on the main thread:
/// - **In-app touches:** a transparent `UIGestureRecognizer` (`cancelsTouchesInView = false`, recognises
///   simultaneously with everything, fails immediately) attached to every window of the app. Windows are
///   picked up from the connected scenes at install time and whenever a window becomes key / visible, so
///   RN's root window, modals and alerts are covered. The system keyboard, notification banners and other
///   apps are outside our windows and are *not* seen (see README "Touch tracking").
/// - **Interactive unlock:** `protectedDataDidBecomeAvailableNotification` (device unlocked while we are
///   alive, foreground or background) and `didBecomeActiveNotification` (the app was brought forward, which
///   implies the owner is holding and using the phone). Both bump `lastTouchMs` and fire `onUnlock`, which the
///   coordinator maps to `UserAction.phoneUnlocked`.
/// - `SafetyNativeTypingView` calls `recordTouch()` on every key, since keyboard touches never reach our windows.
final class TouchTracker: NSObject, UIGestureRecognizerDelegate {
    static let shared = TouchTracker()

    private let lock = NSLock()
    private var _lastTouchMs: UInt64 = 0
    private var lastUnlockSignalMs: UInt64 = 0
    private var observers: [NSObjectProtocol] = []
    private var installed = false

    /// Called on the main thread when the owner unlocked / foregrounded the phone (coalesced to once per 2 s).
    var onUnlock: (() -> Void)?

    /// Wall-clock ms of the last touch or interactive unlock; 0 = never seen in this process.
    var lastTouchMs: UInt64 {
        lock.lock(); defer { lock.unlock() }
        return _lastTouchMs
    }

    private override init() { super.init() }

    /// Idempotent. Safe to call from any thread; work happens on main.
    func install() {
        DispatchQueue.main.async {
            guard !self.installed else { return }
            self.installed = true
            let nc = NotificationCenter.default
            func observe(_ name: Notification.Name, _ f: @escaping (Notification) -> Void) {
                self.observers.append(nc.addObserver(forName: name, object: nil, queue: .main, using: f))
            }
            observe(UIApplication.protectedDataDidBecomeAvailableNotification) { _ in self.unlockSignal() }
            observe(UIApplication.didBecomeActiveNotification) { _ in
                self.unlockSignal()
                self.attachToAllWindows()
            }
            observe(UIWindow.didBecomeKeyNotification) { n in (n.object as? UIWindow).map(self.attach) }
            observe(UIWindow.didBecomeVisibleNotification) { n in (n.object as? UIWindow).map(self.attach) }
            self.attachToAllWindows()
            // Already unlocked and active at install time → the owner is here now.
            if UIApplication.shared.applicationState == .active { self.recordTouch() }
        }
    }

    /// Record a touch (any thread).
    func recordTouch() {
        lock.lock()
        _lastTouchMs = SafeClock.nowMs()
        lock.unlock()
    }

    // MARK: internals (main thread)

    private func unlockSignal() {
        recordTouch()
        let now = SafeClock.nowMs()
        // protectedData + didBecomeActive arrive back-to-back → coalesce to one signal per 2 s. Wall clock may step
        // backwards (NTP / time-zone fix), so never subtract UInt64s that could underflow.
        guard now < lastUnlockSignalMs || now - lastUnlockSignalMs >= 2000 else { return }
        lastUnlockSignalMs = now
        onUnlock?()
    }

    private func attachToAllWindows() {
        var windows: [UIWindow] = []
        if #available(iOS 13.0, *) {
            for scene in UIApplication.shared.connectedScenes {
                if let ws = scene as? UIWindowScene { windows.append(contentsOf: ws.windows) }
            }
        }
        if windows.isEmpty { windows = UIApplication.shared.windows }
        windows.forEach(attach)
    }

    private func attach(_ window: UIWindow) {
        if window.gestureRecognizers?.contains(where: { $0 is TouchObserverRecognizer }) == true { return }
        let gr = TouchObserverRecognizer(target: nil, action: nil)
        gr.tracker = self
        gr.cancelsTouchesInView = false
        gr.delaysTouchesBegan = false
        gr.delaysTouchesEnded = false
        gr.delegate = self
        window.addGestureRecognizer(gr)
    }

    // MARK: UIGestureRecognizerDelegate — never block or be blocked by other recognisers

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool { false }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRequireFailureOf other: UIGestureRecognizer) -> Bool { false }
}

/// Observes `touchesBegan` on its window, records the time and fails at once so it never claims the touch.
final class TouchObserverRecognizer: UIGestureRecognizer {
    weak var tracker: TouchTracker?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        tracker?.recordTouch()
        state = .failed   // resets to .possible for the next touch; the touch continues to its real target untouched
    }
}
