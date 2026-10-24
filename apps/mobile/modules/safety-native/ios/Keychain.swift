import Foundation
import Security

/// Minimal generic-password Keychain wrapper. Everything is stored with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` so the sensing service can read identity /
/// day keys while the phone is locked in the middle of the night, but items never leave the device.
enum Keychain {
    private static let service = "app.safe.native"

    private static func base(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    @discardableResult
    static func set(_ data: Data, for key: String) -> Bool {
        SecItemDelete(base(key) as CFDictionary)
        var add = base(key)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func get(_ key: String) -> Data? {
        var query = base(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    static func delete(_ key: String) { SecItemDelete(base(key) as CFDictionary) }

    static func setString(_ s: String, for key: String) { set(Data(s.utf8), for: key) }
    static func getString(_ key: String) -> String? { get(key).flatMap { String(data: $0, encoding: .utf8) } }

    static func setJSON<T: Encodable>(_ value: T, for key: String) {
        if let d = try? JSONEncoder().encode(value) { set(d, for: key) }
    }
    static func getJSON<T: Decodable>(_ key: String) -> T? {
        get(key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }
}

/// On-disk store for non-secret but private state (config, home places, baseline blob). Files use
/// `completeUntilFirstUserAuthentication` so they are readable while locked after the first unlock.
enum Store {
    static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("safe", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: base, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        return base
    }()

    static func write(_ data: Data, _ name: String) {
        try? data.write(to: dir.appendingPathComponent(name),
                        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func read(_ name: String) -> Data? { try? Data(contentsOf: dir.appendingPathComponent(name)) }
    static func remove(_ name: String) { try? FileManager.default.removeItem(at: dir.appendingPathComponent(name)) }

    static func saveJSON<T: Encodable>(_ value: T, _ name: String) {
        if let d = try? JSONEncoder().encode(value) { write(d, name) }
    }
    static func loadJSON<T: Decodable>(_ name: String) -> T? {
        read(name).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }
}
