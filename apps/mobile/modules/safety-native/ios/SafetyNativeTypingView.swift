import ExpoModulesCore
import UIKit

/// UITextField that reports backspaces even when the field is empty.
final class KeyTimingTextField: UITextField {
    var onBackspace: (() -> Void)?
    override func deleteBackward() {
        onBackspace?()
        super.deleteBackward()
    }
}

/// Native check-in input. Records per-key timestamps (ms since first key) and backspaces, emitting
/// `onKey` after every edit and `onSubmit` on return: `{ phrase, typed, keyTimesMs, backspaces, durationMs }`.
/// Autocorrect / smart punctuation are off so the typing features reflect the user, not the keyboard.
final class SafetyNativeTypingView: ExpoView, UITextFieldDelegate {
    let onKey = EventDispatcher()
    let onSubmit = EventDispatcher()

    var phrase: String = "" { didSet { field.placeholder = phrase } }
    var autoFocus = false { didSet { if autoFocus { DispatchQueue.main.async { self.field.becomeFirstResponder() } } } }

    private let field = KeyTimingTextField()
    private var keyTimes: [Double] = []
    private var backspaces = 0
    private var startedAt: Date?
    private var pendingBackspace = false

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        field.delegate = self
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.autocapitalizationType = .none
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.keyboardType = .asciiCapable
        field.returnKeyType = .done
        field.borderStyle = .roundedRect
        field.font = .preferredFont(forTextStyle: .title2)
        field.adjustsFontForContentSizeCategory = true
        field.onBackspace = { [weak self] in self?.pendingBackspace = true }
        field.addTarget(self, action: #selector(editingChanged), for: .editingChanged)
        addSubview(field)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        field.frame = bounds
    }

    // MARK: recording

    @objc private func editingChanged() {
        TouchTracker.shared.recordTouch()   // system keyboard touches are invisible to TouchTracker's window recognisers
        let now = Date()
        if startedAt == nil { startedAt = now }
        let t = now.timeIntervalSince(startedAt ?? now) * 1000
        keyTimes.append(t)
        if pendingBackspace { backspaces += 1; pendingBackspace = false }
        onKey(payload(durationMs: t))
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        submit()
        return true
    }

    func submit() {
        let duration = startedAt.map { Date().timeIntervalSince($0) * 1000 } ?? 0
        onSubmit(payload(durationMs: duration))
        field.resignFirstResponder()
    }

    func reset() {
        field.text = ""
        keyTimes = []
        backspaces = 0
        startedAt = nil
        pendingBackspace = false
    }

    func focus() { field.becomeFirstResponder() }

    private func payload(durationMs: Double) -> [String: Any] {
        ["phrase": phrase, "typed": field.text ?? "", "keyTimesMs": keyTimes, "backspaces": backspaces, "durationMs": durationMs]
    }
}
