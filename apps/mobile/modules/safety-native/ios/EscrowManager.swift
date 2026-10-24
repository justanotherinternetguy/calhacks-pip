import CryptoKit
import Foundation

// The uniffi bindings (Generated/safety.swift) are compiled into this same module: no import needed.

struct GroupMember: Codable {
    var userId: String
    var deviceId: String
    var x25519Pub: String   // base64
    var ed25519Pub: String  // base64
}

struct GroupConfig: Codable {
    var groupId: String
    var thresholdK: Int
    var members: [GroupMember]
}

private struct StoredIdentity: Codable {
    var x25519Secret: String, x25519Public: String, ed25519Secret: String, ed25519Public: String
}

struct ActiveEpoch: Codable {
    var id: String
    var groupId: String?
    var day: String       // local day the key belongs to
    var dayKey: String    // base64 K_day (Keychain-resident)
    var k: Int
    var n: Int
}

/// Location escrow (PLAN §5): device identity, daily K_day + Shamir shares sealed to friends,
/// hourly K_h derivation, normal unlock (release K_h), and the friend-side caches for decryption
/// and the fallback unlock.
///
/// All byte strings are `Data` (uniffi's mapping of Rust `Vec<u8>`).
///
/// AAD conventions (CONTRACTS §5; must match Android byte-for-byte, friends may be on either platform):
///   share    : "share|{epochId}|{recipientUserId}"
///   release  : "hour|{epochId}|{hourIndex}"
///   approval : "approval|{subjectUserId}|{epochId}"   (re-sealed share = [index as u8] ++ shareBytes)
final class EscrowManager {
    private let lock = NSLock()
    private(set) var identity: Identity
    private(set) var activeEpoch: ActiveEpoch? = Keychain.getJSON("epoch")
    private var hourKeyCache: [String: Data] = [:]   // "subject|epoch|hour" → K_h (friend side)
    private var dayKeyCache: [String: Data] = [:]    // "subject|epoch" → K_day (after fallback recovery)
    private var rotating = false

    init() {
        if let s: StoredIdentity = Keychain.getJSON("identity"),
           let xs = Data(b64: s.x25519Secret), let xp = Data(b64: s.x25519Public),
           let es = Data(b64: s.ed25519Secret), let ep = Data(b64: s.ed25519Public) {
            identity = Identity(x25519Secret: xs, x25519Public: xp, ed25519Secret: es, ed25519Public: ep)
        } else {
            let id = generateIdentity()
            Keychain.setJSON(StoredIdentity(x25519Secret: id.x25519Secret.b64, x25519Public: id.x25519Public.b64,
                                            ed25519Secret: id.ed25519Secret.b64, ed25519Public: id.ed25519Public.b64), for: "identity")
            identity = id
        }
    }

    func fingerprintString(userId: String) -> String {
        fingerprint(userId: userId, x25519Public: identity.x25519Public, ed25519Public: identity.ed25519Public)
    }

    static func shareAad(_ epochId: String, _ recipientUserId: String) -> Data { Data("share|\(epochId)|\(recipientUserId)".utf8) }
    static func releaseAad(_ epochId: String, _ hourIndex: UInt32) -> Data { Data("hour|\(epochId)|\(hourIndex)".utf8) }
    static func approvalAad(_ subjectUserId: String, _ epochId: String) -> Data { Data("approval|\(subjectUserId)|\(epochId)".utf8) }

    // MARK: subject side

    /// Rotate at local midnight or when the group changed. Idempotent / re-entrancy safe.
    func ensureEpoch(cfg: NativeConfig, group: GroupConfig?, rest: SupabaseRest) async {
        let today = SafeClock.localDay()
        lock.lock()
        let needs = activeEpoch == nil || activeEpoch?.day != today || activeEpoch?.groupId != group?.groupId
        let busy = rotating
        if needs && !busy { rotating = true }
        lock.unlock()
        guard needs, !busy else { return }
        defer { lock.lock(); rotating = false; lock.unlock() }
        try? await rotate(cfg: cfg, group: group, rest: rest)
    }

    /// New K_day → epochs row → k-of-n Shamir shares sealed to each other member → key_shares rows.
    func rotate(cfg: NativeConfig, group: GroupConfig?, rest: SupabaseRest) async throws {
        var dayKey: Data = newDayKey()
        defer { dayKey.zeroize() }
        let today = SafeClock.localDay()
        let others = group?.members.filter { $0.userId != cfg.userId } ?? []
        let n = others.count
        // CONTRACTS §5: k = clamp(max(2, threshold_k), 2, n); n < 2 → no shares, fallback unlock disabled.
        // n < 2 → k = 0 (no shares; DB check: (k = 0 and n < 2) or (k >= 2 and n >= k)).
        let sharesEnabled = n >= 2
        let k = sharesEnabled ? min(max(2, group?.thresholdK ?? 2), n) : 0

        var row: [String: Any] = ["user_id": cfg.userId, "day": today, "k": k, "n": n, "active": true]
        row["group_id"] = group?.groupId.map { $0 as Any } ?? NSNull()
        let rows = try await rest.insert("epochs", row, returning: true)
        guard let epochId = rows.first?["id"] as? String else { throw SafeError("epochs insert returned no id") }

        if sharesEnabled {
            guard n <= 255 else { throw SafeError("too many members for Shamir split (\(n))") }
            let shares: [Share] = try splitDayKey(dayKey: dayKey, k: UInt8(k), n: UInt8(n))
            var shareRows: [[String: Any]] = []
            for (m, s) in zip(others, shares) {
                let sealed: Data = try sealTo(recipientX25519Public: try bytes(m.x25519Pub, "member x25519"),
                                              senderEd25519Secret: identity.ed25519Secret,
                                              plaintext: s.data, aad: Self.shareAad(epochId, m.userId))
                shareRows.append(["epoch_id": epochId, "recipient_user_id": m.userId, "share_index": Int(s.index),
                                  "sealed": sealed.b64, "sender_ed25519_pub": identity.ed25519Public.b64])
            }
            try await rest.insert("key_shares", shareRows)
        }

        lock.lock()
        let old = activeEpoch
        activeEpoch = ActiveEpoch(id: epochId, groupId: group?.groupId, day: today, dayKey: dayKey.b64, k: k, n: n)
        Keychain.setJSON(activeEpoch, for: "epoch")
        // Zeroize what we can of the previous day key; the Keychain copy was just overwritten.
        var oldKey = old.flatMap { Data(b64: $0.dayKey) } ?? Data()
        oldKey.zeroize()
        hourKeyCache.removeAll()
        lock.unlock()

        if let old { try? await rest.patch("epochs", query: ["id": "eq.\(old.id)"], ["active": false]) }
    }

    /// Current `K_h = HKDF(K_day, hourIndex)` for the subject's own active epoch.
    func hourKey(index: UInt32) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard let e = activeEpoch, var dk = Data(b64: e.dayKey) else { return nil }
        defer { dk.zeroize() }
        return deriveHourKey(dayKey: dk, hourIndex: index)
    }

    /// Normal unlock: seal current + next hour keys to every other member → `released_keys`.
    func releaseHourKeys(incidentId: String, cfg: NativeConfig, group: GroupConfig, rest: SupabaseRest) async throws {
        guard let e = activeEpoch else { throw SafeError("no active epoch") }
        let h = SafeClock.hourIndex(ms: SafeClock.nowMs())
        var rows: [[String: Any]] = []
        for hi in [h, h + 1] {
            guard let key = hourKey(index: hi) else { continue }
            for m in group.members where m.userId != cfg.userId {
                let sealed: Data = try sealTo(recipientX25519Public: try bytes(m.x25519Pub, "member x25519"),
                                              senderEd25519Secret: identity.ed25519Secret,
                                              plaintext: key, aad: Self.releaseAad(e.id, hi))
                rows.append(["incident_id": incidentId, "subject_user_id": cfg.userId, "recipient_user_id": m.userId,
                             "epoch_id": e.id, "hour_index": Int(hi), "sealed": sealed.b64,
                             "sender_ed25519_pub": identity.ed25519Public.b64])
            }
        }
        if !rows.isEmpty { try await rest.insert("released_keys", rows) }
    }

    /// Group epoch key for proximity tokens (CONTRACTS §5, v1):
    /// `SHA-256("safe/proximity|{groupId}|{YYYY-MM-DD UTC}")`. Accepted weakness: the server knows both
    /// inputs and can brute-force cells on its own; a sealed per-group key is planned for v1.1.
    func groupEpochKey(for group: GroupConfig) -> Data {
        let material = "safe/proximity|\(group.groupId)|\(SafeClock.utcDay())"
        return Data(SHA256.hash(data: Data(material.utf8)))
    }

    // MARK: friend side

    func openReleasedKey(subjectUserId: String, epochId: String, hourIndex: Int, sealedB64: String, senderEd25519Pub: String) throws {
        guard hourIndex >= 0, hourIndex <= Int(UInt32.max) else { throw SafeError("hourIndex out of range") }
        let key: Data = try openSealed(recipientX25519Secret: identity.x25519Secret,
                                       senderEd25519Public: try bytes(senderEd25519Pub, "sender ed25519"),
                                       sealedBlob: try bytes(sealedB64, "sealed"),
                                       aad: Self.releaseAad(epochId, UInt32(hourIndex)))   // hourIndex = released_keys.hour_index
        lock.lock(); hourKeyCache["\(subjectUserId)|\(epochId)|\(hourIndex)"] = key; lock.unlock()
    }

    struct BlobRef { var epochId: String; var seq: UInt64; var hourIndex: Int; var ciphertextB64: String }

    func decryptLocations(subjectUserId: String, blobs: [BlobRef]) -> [Location] {
        lock.lock(); let hours = hourKeyCache, days = dayKeyCache; lock.unlock()
        var out: [Location] = []
        for b in blobs {
            guard b.hourIndex >= 0, b.hourIndex <= Int(UInt32.max) else { continue }
            let key: Data? = hours["\(subjectUserId)|\(b.epochId)|\(b.hourIndex)"]
                ?? days["\(subjectUserId)|\(b.epochId)"].map { deriveHourKey(dayKey: $0, hourIndex: UInt32(b.hourIndex)) }
            guard let key, let ct = Data(b64: b.ciphertextB64) else { continue }
            if let loc = try? decryptLocation(hourKey: key, userId: subjectUserId, epochId: b.epochId, seq: b.seq, blob: ct) {
                out.append(loc)
            }
        }
        return out
    }

    /// Fallback unlock, approver side: fetch my sealed share for the epoch, open it, re-seal to the requester.
    func approveUnlock(requestId: String, subjectUserId: String, epochId: String, requesterX25519Pub: String,
                       expectedSubjectEd25519Pub: String?, myUserId: String, rest: SupabaseRest) async throws -> String {
        let rows = try await rest.select("key_shares", query: [
            "epoch_id": "eq.\(epochId)", "recipient_user_id": "eq.\(myUserId)",
            "select": "share_index,sealed,sender_ed25519_pub", "limit": "1"])
        guard let row = rows.first, let idx = row["share_index"] as? Int,
              let sealed = row["sealed"] as? String, let senderPub = row["sender_ed25519_pub"] as? String else {
            throw SafeError("no key share for epoch \(epochId)")
        }
        guard idx >= 0, idx <= 255 else { throw SafeError("share_index out of range (\(idx))") }
        if let expected = expectedSubjectEd25519Pub, expected != senderPub { throw SafeError("share signer mismatch") }
        let share: Data = try openSealed(recipientX25519Secret: identity.x25519Secret,
                                         senderEd25519Public: try bytes(senderPub, "sender ed25519"),
                                         sealedBlob: try bytes(sealed, "sealed share"), aad: Self.shareAad(epochId, myUserId))
        var plaintext = Data([UInt8(idx)])   // [index as u8] ++ share (CONTRACTS §5)
        plaintext.append(share)
        let resealed: Data = try sealTo(recipientX25519Public: try bytes(requesterX25519Pub, "requester x25519"),
                                        senderEd25519Secret: identity.ed25519Secret,
                                        plaintext: plaintext, aad: Self.approvalAad(subjectUserId, epochId))
        return resealed.b64
    }

    /// Fallback unlock, requester side: open ≥k re-sealed shares, rebuild K_day, cache it for decryptLocations.
    func recoverFromShares(subjectUserId: String, epochId: String, sealedShares: [(sealedB64: String, approverEd25519Pub: String)]) throws -> Bool {
        var shares: [Share] = []
        for s in sealedShares {
            let pt: Data = try openSealed(recipientX25519Secret: identity.x25519Secret,
                                          senderEd25519Public: try bytes(s.approverEd25519Pub, "approver ed25519"),
                                          sealedBlob: try bytes(s.sealedB64, "sealed share"), aad: Self.approvalAad(subjectUserId, epochId))
            guard pt.count > 1 else { continue }
            // `Data` indices are not guaranteed to start at 0: index via startIndex and rebase the slice.
            shares.append(Share(index: pt[pt.startIndex], data: Data(pt.dropFirst())))
        }
        let dayKey: Data = try combineShares(shares: shares)
        lock.lock(); dayKeyCache["\(subjectUserId)|\(epochId)"] = dayKey; lock.unlock()
        return true
    }

    /// Drop friend-side material (call at the end of an incident / day).
    func clearFriendCaches() {
        lock.lock()
        for k in hourKeyCache.keys { hourKeyCache[k]?.zeroize() }
        for k in dayKeyCache.keys { dayKeyCache[k]?.zeroize() }
        hourKeyCache.removeAll(); dayKeyCache.removeAll()
        lock.unlock()
    }
}
