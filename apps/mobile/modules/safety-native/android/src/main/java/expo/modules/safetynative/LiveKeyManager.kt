package expo.modules.safetynative

import android.util.Log
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import uniffi.safety.Location
import uniffi.safety.decryptLocation
import uniffi.safety.encryptLocation
import uniffi.safety.newDayKey
import uniffi.safety.openSealed
import uniffi.safety.sealTo
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Encrypted live location for the friends' map (CONTRACTS.md §7, migration 0020).
 *
 * Own side: a random 32-byte live key with a 16-hex `kid`, sealed to every pinned friend in every group
 * (`live_keys` rows, aad "live|{ownerId}|{kid}"). Telemetry carries `locEnc {kid, seq, ct}` where
 * ct = encrypt_location(liveKey, ownerId, "live:{kid}", seq, loc). The key rotates every local day and whenever a
 * friend drops out of the set; a new friend just gets the current key sealed to them.
 *
 * Friend side: [open] verifies a sealed key against the owner's PINNED Ed25519 key and keeps it in memory;
 * [decrypt] turns a tick's `locEnc` back into a position.
 */
class LiveKeyManager(private val rt: SafetyRuntime) {
  companion object { private const val TAG = "LiveKeys" }
  private val prefs get() = rt.prefs
  private val lock = Mutex()
  private val seq = AtomicLong(System.currentTimeMillis())
  private val friendKeys = ConcurrentHashMap<String, ByteArray>()

  private fun aad(ownerId: String, kid: String) = "live|$ownerId|$kid".toByteArray(Charsets.UTF_8)
  private fun newKid(): String = ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

  private fun ownKid(): String? = prefs.getString("live_kid")
  private fun ownKey(): ByteArray? = prefs.getString("live_key")?.let { unb64(it) }
  private fun sealedTo(): Set<String> = prefs.getString("live_recipients")?.split(',')?.filter { it.isNotBlank() }?.toSet() ?: emptySet()

  /**
   * [friends]: userId → X25519 public key (b64), already filtered to pinned, matching keys by [EscrowManager.setGroups].
   * Rotates when the day changed or someone left; otherwise seals the current key to newcomers only.
   */
  suspend fun sync(friends: Map<String, String>) = lock.withLock {
    val cfg = prefs.serverConfig ?: return@withLock
    rt.io {
      runCatching {
        val day = rt.escrow.today()
        val had = sealedTo()
        val removed = had - friends.keys
        val needRotate = ownKey() == null || prefs.getString("live_day") != day || removed.isNotEmpty()
        val me = rt.escrow.identity()
        if (needRotate) {
          val kid = newKid()
          val key = newDayKey()
          val rows = JSONArray()
          for ((uid, x) in friends) rows.put(row(cfg.userId, kid, uid, b64(sealTo(unb64(x), me.ed25519Secret, key, aad(cfg.userId, kid)))))
          if (rows.length() > 0) rt.supabase.insertMany("live_keys", rows)
          // Old keys go: ex-friends must not keep receiving a key they could use on future frames.
          runCatching { rt.supabase.delete("live_keys", "owner_id=eq.${cfg.userId}&key_id=neq.$kid") }
          prefs.putString("live_key", b64(key)); prefs.putString("live_kid", kid); prefs.putString("live_day", day)
          prefs.putString("live_recipients", friends.keys.joinToString(","))
          key.fill(0)
          Log.i(TAG, "rotated live key kid=$kid friends=${friends.size} (removed ${removed.size})")
        } else {
          val added = friends.keys - had
          if (added.isNotEmpty()) {
            val kid = ownKid()!!
            val key = ownKey()!!
            val rows = JSONArray()
            for (uid in added) rows.put(row(cfg.userId, kid, uid, b64(sealTo(unb64(friends.getValue(uid)), me.ed25519Secret, key, aad(cfg.userId, kid)))))
            rt.supabase.insertMany("live_keys", rows)
            key.fill(0)
            prefs.putString("live_recipients", friends.keys.joinToString(","))
            Log.i(TAG, "sealed live key to ${added.size} new friend(s)")
          }
        }
      }.onFailure { Log.e(TAG, "live key sync failed", it) }
    }
  }

  private fun row(owner: String, kid: String, recipient: String, sealed: String) =
    JSONObject().put("owner_id", owner).put("key_id", kid).put("recipient_id", recipient).put("sealed", sealed)

  /** Day rollover from the service tick: re-run [sync] with the last friend set. */
  suspend fun rotateIfNewDay() {
    if (ownKey() != null && prefs.getString("live_day") == rt.escrow.today()) return
    sync(rt.escrow.liveFriends())
  }

  /** `locEnc` for a telemetry frame, or null with no key yet (then the frame carries no location at all). */
  @Volatile private var lastDayCheckMs = 0L

  fun encrypt(l: android.location.Location): JSONObject? {
    val cfg = prefs.serverConfig ?: return null
    // Day rollover while streaming outside night mode: rotate in the background, keep the old key meanwhile.
    val now = System.currentTimeMillis()
    if (now - lastDayCheckMs > 60_000L && prefs.getString("live_day") != rt.escrow.today()) {
      lastDayCheckMs = now
      rt.scope.launch { rotateIfNewDay() }
    }
    val kid = ownKid() ?: return null
    val key = ownKey() ?: return null
    return try {
      val s = seq.incrementAndGet()
      val ct = encryptLocation(key, cfg.userId, "live:$kid", s.toULong(), Location(l.latitude, l.longitude, l.accuracy, l.time.toULong()))
      JSONObject().put("kid", kid).put("seq", s).put("ct", b64(ct))
    } catch (e: Exception) {
      Log.w(TAG, "encrypt failed", e); null
    } finally { key.fill(0) }
  }

  // ---- friend side ---------------------------------------------------------

  /** Opens sealed live keys addressed to me. Each must be signed by the owner's pinned key. Returns how many opened. */
  fun open(rows: List<Map<String, Any?>>): Int {
    val me = rt.escrow.identity()
    var n = 0
    for (r in rows) {
      val owner = r["ownerId"] as? String ?: continue
      val kid = r["keyId"] as? String ?: continue
      if (friendKeys.containsKey("$owner|$kid")) { n++; continue }
      val pin = rt.pins.get(owner)
      if (pin == null) { Log.w(TAG, "no pinned key for ${owner.take(8)}: live key ignored"); continue }
      runCatching {
        friendKeys["$owner|$kid"] = openSealed(me.x25519Secret, unb64(pin.ed25519Pub), unb64(r["sealedB64"] as String), aad(owner, kid))
        n++
      }.onFailure { Log.w(TAG, "live key from ${owner.take(8)} did not verify", it) }
    }
    return n
  }

  fun decrypt(ownerId: String, kid: String, seq: Long, ctB64: String): Map<String, Any>? {
    val key = friendKeys["$ownerId|$kid"] ?: return null
    return runCatching {
      val l = decryptLocation(key, ownerId, "live:$kid", seq.toULong(), unb64(ctB64))
      mapOf("lat" to l.lat, "lng" to l.lng, "accuracyM" to l.accuracyM.toDouble(), "tMs" to l.tMs.toLong())
    }.getOrNull()
  }

  fun clear() {
    friendKeys.values.forEach { it.fill(0) }
    friendKeys.clear()
    listOf("live_key", "live_kid", "live_day", "live_recipients").forEach { prefs.remove(it) }
  }
}
