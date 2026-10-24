import Foundation

// uniffi maps Rust `Vec<u8>` to Swift `[UInt8]`; everything crossing the JS bridge is base64.

extension Array where Element == UInt8 {
    var b64: String { Data(self).base64EncodedString() }

    init?(b64: String) {
        guard let d = Data(base64Encoded: b64, options: [.ignoreUnknownCharacters]) else { return nil }
        self = [UInt8](d)
    }

    /// Best-effort zeroization of key material before the buffer is released.
    mutating func zeroize() {
        for i in indices { self[i] = 0 }
        removeAll()
    }
}

/// Decodes base64 or throws a readable error (used for every key that arrives from JS / the server).
func bytes(_ b64: String, _ what: String = "value") throws -> [UInt8] {
    guard let b = [UInt8](b64: b64) else { throw SafeError("\(what): invalid base64") }
    return b
}

struct SafeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum SafeClock {
    static func nowMs() -> UInt64 { UInt64(Date().timeIntervalSince1970 * 1000) }

    /// Absolute hour index (hours since the Unix epoch, UTC). Used as `hour_index` everywhere so
    /// subject and friends derive the same `K_h` regardless of time zone.
    static func hourIndex(ms: UInt64) -> UInt32 { UInt32(ms / 3_600_000) }

    static func hourLocal(_ d: Date = Date()) -> UInt8 { UInt8(Calendar.current.component(.hour, from: d)) }

    /// Local calendar day, e.g. "2026-10-24". Day keys rotate when this changes.
    static func localDay(_ d: Date = Date()) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f.string(from: d)
    }

    /// UTC calendar day, e.g. "2026-10-24", fixed Gregorian/POSIX so every platform produces the same
    /// bytes. Used for the group proximity key (CONTRACTS §5).
    static func utcDay(_ d: Date = Date()) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        return f.string(from: d)
    }

    static func iso8601(_ d: Date = Date()) -> String { ISO8601DateFormatter().string(from: d) }
}
