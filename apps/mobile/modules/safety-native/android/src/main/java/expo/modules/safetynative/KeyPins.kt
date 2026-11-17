package expo.modules.safetynative

import org.json.JSONObject

/** A friend's public keys as this phone first saw them. `verified` = matched in person (QR scan). */
data class KeyPin(val userId: String, val x25519Pub: String, val ed25519Pub: String, val verified: Boolean, val pinnedAtMs: Long) {
  fun toMap(): Map<String, Any?> = mapOf(
    "userId" to userId, "x25519Pub" to x25519Pub, "ed25519Pub" to ed25519Pub, "verified" to verified, "pinnedAtMs" to pinnedAtMs,
  )
}

/**
 * Key pinning (CONTRACTS.md §6). The server hands out friends' public keys, so a malicious or compromised server
 * could swap a key and receive our escrow shares or live location. Pins stop that: the first key seen for a
 * friend is pinned (trust on first use), a key scanned from their QR in person is pinned as verified, and a
 * different key later is never used until it is re-verified by a scan. Stored in EncryptedSharedPreferences.
 */
class KeyPins(private val prefs: Prefs) {
  companion object {
    private const val KEY = "key_pins"
    /** X25519 / Ed25519 public keys are 32 bytes. Anything else (mock / web placeholders) is never pinned or used. */
    fun validKey(b64Key: String): Boolean = runCatching { unb64(b64Key).size == 32 }.getOrDefault(false)
  }

  enum class Status { NEW, SAME, CHANGED, INVALID }

  @Synchronized
  private fun load(): JSONObject = prefs.getString(KEY)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()

  @Synchronized
  private fun save(o: JSONObject) = prefs.putString(KEY, o.toString())

  @Synchronized
  fun get(userId: String): KeyPin? = load().optJSONObject(userId)?.let {
    KeyPin(userId, it.getString("x"), it.getString("e"), it.optBoolean("v", false), it.optLong("t", 0L))
  }

  @Synchronized
  fun all(): List<KeyPin> {
    val o = load()
    return o.keys().asSequence().mapNotNull { get(it) }.toList()
  }

  /** What [pin] would do, without storing anything. */
  @Synchronized
  fun check(userId: String, x: String, e: String): Status {
    if (!validKey(x) || !validKey(e)) return Status.INVALID
    val p = get(userId) ?: return Status.NEW
    return if (p.x25519Pub == x && p.ed25519Pub == e) Status.SAME else Status.CHANGED
  }

  /**
   * NEW → pinned (verified as given). SAME → upgraded to verified if [verified]. CHANGED → left alone unless
   * [replace] (the user just re-verified the new key in person), then replaced as verified.
   */
  @Synchronized
  fun pin(userId: String, x: String, e: String, verified: Boolean, replace: Boolean = false): Pair<Status, KeyPin?> {
    val st = check(userId, x, e)
    val o = load()
    fun put(v: Boolean) = o.put(userId, JSONObject().put("x", x).put("e", e).put("v", v).put("t", System.currentTimeMillis()))
    when (st) {
      Status.INVALID -> return st to get(userId)
      Status.NEW -> put(verified)
      Status.SAME -> if (verified && get(userId)?.verified != true) put(true) else return st to get(userId)
      Status.CHANGED -> if (replace && verified) put(true) else return st to get(userId)
    }
    save(o)
    return st to get(userId)
  }

  /** The pinned Ed25519 key to verify [userId]'s signatures with. A row's own key is used only while unpinned. */
  fun signerKey(userId: String, rowKeyB64: String): ByteArray {
    val p = get(userId) ?: return unb64(rowKeyB64)
    if (p.ed25519Pub != rowKeyB64) throw SecurityException("signing key for ${userId.take(8)} does not match the pinned key")
    return unb64(p.ed25519Pub)
  }
}
