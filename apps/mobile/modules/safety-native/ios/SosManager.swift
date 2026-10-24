import Foundation
import LocalAuthentication
#if canImport(safety)
import safety
#endif

/// Manual SOS (in-app hold button, App Intent, widget). Counts as consent: the engine skips the bar and
/// emits `UnlockLocation` on the next tick. Cancelling requires the owner's biometric / passcode.
final class SosManager {
    private unowned let c: SensingCoordinator
    private(set) var active = false

    init(_ c: SensingCoordinator) { self.c = c }

    func trigger() {
        c.q.async {
            guard let engine = self.c.engine else { return }
            self.active = true
            engine.pushAction(a: .manualSos, nowMs: self.c.nowMs())
            self.c.forceSessionLocked(true)
            self.c.audio.boost(seconds: 600)
            self.c.emit?("sos", ["active": true])
            self.c.alerts.post(id: "sos", title: "SOS sent",
                               body: "Your friends have been alerted and can see your location. Unlock the app to cancel.")
            self.c.tickNow(onQueue: true)
        }
    }

    /// Returns false when the biometric / passcode prompt fails or is unavailable.
    func cancel() async -> Bool {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Not now"
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { return false }
        let ok = (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Confirm you're safe to cancel the SOS")) ?? false
        guard ok else { return false }
        c.q.async {
            guard let engine = self.c.engine else { return }
            engine.pushAction(a: .biometricDismiss, nowMs: self.c.nowMs())
            self.active = false
            self.c.forceSessionLocked(false)
            self.c.emit?("sos", ["active": false])
            self.c.tickNow(onQueue: true)
        }
        return true
    }

    func markResolved() { active = false }
}
