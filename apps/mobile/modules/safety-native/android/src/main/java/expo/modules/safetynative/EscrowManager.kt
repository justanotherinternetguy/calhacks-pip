package expo.modules.safetynative

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import uniffi.safety.Identity
import uniffi.safety.Share
import uniffi.safety.combineShares
import uniffi.safety.decryptLocation
import uniffi.safety.deriveHourKey
import uniffi.safety.fingerprint
import uniffi.safety.generateIdentity
import uniffi.safety.newDayKey
import uniffi.safety.openSealed
import uniffi.safety.sealTo
import uniffi.safety.splitDayKey
import java.security.MessageDigest
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.math.max
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class GroupMember(val userId: String, val deviceId: String, val x25519Pub: ByteArray, val ed25519Pub: ByteArray)
data class GroupInfo(val groupId: String, val thresholdK: Int, val members: List<GroupMember>)
data class Epoch(val epochId: String, val day: String)

/**
 * Location escrow: device identity, daily key rotation + Shamir shares sealed to friends,
 * hourly keys for location blobs, normal unlock (release K_h), and the friend-side caches.
 *
 * Conventions per CONTRACTS.md §5 (iOS must match):
 *   key_shares     : "share|{epochId}|{recipientUserId}"       plaintext = share.data (index in column)
 *   released_keys  : "hour|{epochId}|{hourIndex}"              plaintext = K_h
 *   unlock_approval: "approval|{subjectUserId}|{epochId}"      plaintext = [index u8] || share.data
 *   hour_index     : floor(unix_ms / 3_600_000) — UTC-absolute hour number (u32), NOT local hour of day
 *   epoch_id       : epochs.id uuid as a lowercase string
 */
class EscrowManager(private val rt: SafetyRuntime) {
  companion object { private const val TAG = "Escrow" }
  private val prefs get() = rt.prefs

  // ---- identity ------------------------------------------------------------

  @Synchronized
  fun identity(): Identity {
    prefs.getString("id_x_sec")?.let {
      return Identity(unb64(it), unb64(prefs.getString("id_x_pub")!!), unb64(prefs.getString("id_ed_sec")!!), unb64(prefs.getString("id_ed_pub")!!))
    }
    val id = generateIdentity()
    prefs.putString("id_x_sec", b64(id.x25519Secret)); prefs.putString("id_x_pub", b64(id.x25519Public))
    prefs.putString("id_ed_sec", b64(id.ed25519Secret)); prefs.putString("id_ed_pub", b64(id.ed25519Public))
    return id
  }

  fun identityMap(): Map<String, Any?> {
    val id = identity()
    val userId = prefs.serverConfig?.userId ?: ""
    return mapOf(
      "userId" to userId, "x25519Pub" to b64(id.x25519Public), "ed25519Pub" to b64(id.ed25519Public),
      "fingerprint" to fingerprint(userId, id.x25519Public, id.ed25519Public),
    )
  }

  /** Publish our public keys on the devices row so friends (and the QR flow) can verify them. */
  suspend fun publishKeys() {
    val cfg = prefs.serverConfig ?: return
    val id = identity()
    rt.io {
      runCatching {
        rt.supabase.upsert(
          "devices",
          JSONObject().put("id", cfg.deviceId).put("user_id", cfg.userId).put("platform", "android")
            .put("x25519_pub", b64(id.x25519Public)).put("ed25519_pub", b64(id.ed25519Public)),
          onConflict = "id",
        )
      }.onFailure { Log.w(TAG, "publishKeys failed", it) }
    }
  }

  // ---- group ---------------------------------------------------------------

  fun group(): GroupInfo? = prefs.getString("group")?.let { s ->
    val o = JSONObject(s)
    val arr = o.getJSONArray("members")
    GroupInfo(
      o.getString("groupId"), o.getInt("thresholdK"),
      (0 until arr.length()).map { i ->
        val m = arr.getJSONObject(i)
        GroupMember(m.getString("userId"), m.getString("deviceId"), unb64(m.getString("x25519Pub")), unb64(m.getString("ed25519Pub")))
      },
    )
  }
  fun groupId(): String? = group()?.groupId
  fun memberUserIds(): List<String> = group()?.members?.map { it.userId } ?: emptyList()

  /** Stores the group and rotates the day key immediately (new member set ⇒ new shares). */
  suspend fun setGroup(groupId: String, thresholdK: Int, members: JSONArray) {
    val self = prefs.serverConfig?.userId
    val filtered = JSONArray()
    for (i in 0 until members.length()) {
      val m = members.getJSONObject(i)
      if (m.getString("userId") != self) filtered.put(m)
    }
    val next = JSONObject().put("groupId", groupId).put("thresholdK", thresholdK).put("members", filtered).toString()
    val changed = prefs.getString("group") != next
    prefs.putString("group", next)
    // Only a changed member set needs new shares; otherwise just make sure today's epoch exists.
    rotateDayKey(force = changed)
  }

  // ---- day / hour keys -----------------------------------------------------

  private val zone: ZoneId get() = ZoneId.systemDefault()
  /** Local calendar day: the epoch's `day` column; K_day rotates when this changes (same as iOS). */
  fun today(): String = LocalDate.now(zone).toString()
  /** UTC calendar day (yyyy-MM-dd), used only for the group proximity key (CONTRACTS §5). */
  fun utcToday(): String = LocalDate.now(ZoneOffset.UTC).toString()
  /** CONTRACTS §5: hour_index = floor(unix_ms / 3_600_000), UTC-absolute (fits u32 / non-negative Int). */
  fun hourIndex(unixMs: Long): Int = (unixMs / 3_600_000L).toInt()
  fun hourIndexNow(): Int = hourIndex(rt.now())

  fun currentEpoch(): Epoch? {
    val id = prefs.getString("epoch_id") ?: return null
    val day = prefs.getString("epoch_day") ?: return null
    return Epoch(id, day)
  }

  private fun dayKey(): ByteArray? = prefs.getString("day_key")?.let { unb64(it) }

  /** Called from the service tick: rotates K_day at local midnight. K_h needs no rotation step — it is derived on demand from the absolute hour_index. */
  suspend fun rotateIfNewDay() = rotateDayKey(force = false)

  fun hourKey(hourIndex: Int): ByteArray {
    val dk = dayKey() ?: throw IllegalStateException("no day key")
    try { return deriveHourKey(dk, hourIndex.toUInt()) } finally { dk.fill(0) }
  }

  /**
   * New K_day → epochs row → Shamir k-of-n shares sealed to each friend → key_shares.
   * With n < 2 friends fallback unlock is disabled: an epoch still exists (for location blobs) but no shares.
   */
  @Synchronized
  private fun rotateDayKeySync() {
    val cfg = prefs.serverConfig ?: return
    val g = group()
    // Zeroize the old day key material.
    prefs.getString("day_key")?.let { unb64(it).fill(0) }
    prefs.remove("day_key"); prefs.remove("epoch_id")

    val dayKey = newDayKey()
    val n = g?.members?.size ?: 0
    // CONTRACTS §5: k = clamp(max(2, threshold_k), 2, n); n < 2 → no shares.
    val k = if (n >= 2) max(2, g!!.thresholdK).coerceIn(2, n) else 0

    val epochRow = JSONObject().put("user_id", cfg.userId).put("day", today()).put("k", k).put("n", n).put("active", true)
    g?.let { epochRow.put("group_id", it.groupId) }
    // Deactivate previous epochs for this user, then insert the new one.
    runCatching { rt.supabase.patch("epochs", "user_id=eq.${cfg.userId}&active=is.true", JSONObject().put("active", false)) }
    val epochId = rt.supabase.insertReturning("epochs", epochRow)?.getString("id")?.lowercase() ?: throw IllegalStateException("epoch insert failed")

    prefs.putString("day_key", b64(dayKey)); prefs.putString("epoch_id", epochId); prefs.putString("epoch_day", today())

    if (g != null && k >= 2) {
      val me = identity()
      val shares: List<Share> = splitDayKey(dayKey, k.toUByte(), n.toUByte())
      val rows = JSONArray()
      g.members.forEachIndexed { i, m ->
        val sh = shares[i]
        val sealed = sealTo(m.x25519Pub, me.ed25519Secret, sh.data, "share|$epochId|${m.userId}".toByteArray(Charsets.UTF_8))
        rows.put(
          JSONObject().put("epoch_id", epochId).put("recipient_user_id", m.userId).put("share_index", sh.index.toInt())
            .put("sealed", b64(sealed)).put("sender_ed25519_pub", b64(me.ed25519Public)),
        )
        sh.data.fill(0)
      }
      rt.supabase.insertMany("key_shares", rows)
    }
    dayKey.fill(0)
    Log.i(TAG, "rotated day key: epoch=$epochId k=$k n=$n")
  }

  private val rotateLock = Mutex()

  /** Rotates K_day. With force = false it is a no-op when an epoch for today already exists. Serialized so
   *  concurrent triggers at startup (configure, night session start, setGroup) create one epoch, not several. */
  suspend fun rotateDayKey(force: Boolean = true) {
    rotateLock.withLock {
      val e = currentEpoch()
      if (!force && e != null && e.day == today()) return
      rt.io { runCatching { rotateDayKeySync() }.onFailure { Log.e(TAG, "rotateDayKey failed", it) } }
    }
  }

  /** Shared (non-secret) per-group per-UTC-day key for proximity tokens (CONTRACTS §5). Server brute-force is an accepted v1 risk. */
  fun groupEpochKey(): ByteArray? {
    val gid = groupId() ?: return null
    return MessageDigest.getInstance("SHA-256").digest("safe/proximity|$gid|${utcToday()}".toByteArray(Charsets.UTF_8))
  }

  // ---- normal unlock -------------------------------------------------------

  /** Seal K_h for the current and next hour to each member → released_keys. */
  suspend fun releaseHourKeys(incidentId: String?) {
    val cfg = prefs.serverConfig ?: return
    val g = group() ?: return
    val epoch = currentEpoch() ?: return
    val me = identity()
    rt.io {
      runCatching {
        val h = hourIndexNow()
        val rows = JSONArray()
        for (hi in listOf(h, h + 1)) {
          val key = hourKey(hi)
          for (m in g.members) {
            val sealed = sealTo(m.x25519Pub, me.ed25519Secret, key, "hour|${epoch.epochId}|$hi".toByteArray(Charsets.UTF_8))
            rows.put(
              JSONObject().put("incident_id", incidentId).put("subject_user_id", cfg.userId).put("recipient_user_id", m.userId)
                .put("epoch_id", epoch.epochId).put("hour_index", hi).put("sealed", b64(sealed)).put("sender_ed25519_pub", b64(me.ed25519Public)),
            )
          }
          key.fill(0)
        }
        rt.supabase.insertMany("released_keys", rows)
        rt.supabase.insert(
          "audit_log",
          JSONObject().put("subject_user_id", cfg.userId).put("actor_id", cfg.userId).put("kind", "release")
            .put("payload", JSONObject().put("epochId", epoch.epochId).put("hours", JSONArray(listOf(h, h + 1)))),
        )
      }.onFailure { Log.e(TAG, "releaseHourKeys failed", it) }
    }
  }

  // ---- friend side ---------------------------------------------------------

  private fun cacheKey(subject: String, epochId: String, hour: Int?) = "fk|$subject|$epochId" + (hour?.let { "|$it" } ?: "")

  fun openReleasedKey(subject: String, epochId: String, hourIndex: Int, sealedB64: String, senderEdPubB64: String) {
    val me = identity()
    val key = openSealed(me.x25519Secret, unb64(senderEdPubB64), unb64(sealedB64), "hour|$epochId|$hourIndex".toByteArray(Charsets.UTF_8))
    prefs.putString(cacheKey(subject, epochId, hourIndex), b64(key))
    key.fill(0)
  }

  fun decryptLocations(subject: String, blobs: JSONArray): List<Map<String, Any>> {
    val out = ArrayList<Map<String, Any>>()
    for (i in 0 until blobs.length()) {
      val b = blobs.getJSONObject(i)
      val epochId = b.getString("epochId"); val hour = b.getInt("hourIndex")
      val key = prefs.getString(cacheKey(subject, epochId, hour))?.let { unb64(it) }
        ?: prefs.getString(cacheKey(subject, epochId, null))?.let { deriveHourKey(unb64(it), hour.toUInt()) }
        ?: continue
      runCatching {
        val loc = decryptLocation(key, subject, epochId, b.getLong("seq").toULong(), unb64(b.getString("ciphertextB64")))
        out.add(mapOf("lat" to loc.lat, "lng" to loc.lng, "accuracyM" to loc.accuracyM.toDouble(), "tMs" to loc.tMs.toLong()))
      }.onFailure { Log.w(TAG, "decrypt blob seq=${b.optLong("seq")} failed", it) }
      key.fill(0)
    }
    return out
  }

  /** Fallback unlock, approver side: open our share for the subject's epoch and re-seal it to the requester. */
  suspend fun approveUnlock(requestId: String, subject: String, epochId: String, requesterXPubB64: String): String {
    val cfg = prefs.serverConfig ?: throw IllegalStateException("not configured")
    val me = identity()
    val row = rt.io { rt.supabase.select("key_shares", "epoch_id=eq.$epochId&recipient_user_id=eq.${cfg.userId}&select=share_index,sealed,sender_ed25519_pub&limit=1") }
      .optJSONObject(0) ?: throw IllegalStateException("no share for epoch $epochId")
    val share = openSealed(me.x25519Secret, unb64(row.getString("sender_ed25519_pub")), unb64(row.getString("sealed")), "share|$epochId|${cfg.userId}".toByteArray(Charsets.UTF_8))
    val plain = byteArrayOf(row.getInt("share_index").toByte()) + share
    share.fill(0)
    val sealed = sealTo(unb64(requesterXPubB64), me.ed25519Secret, plain, "approval|$subject|$epochId".toByteArray(Charsets.UTF_8))
    plain.fill(0)
    val sealedB64 = b64(sealed)
    rt.io {
      runCatching {
        rt.supabase.insert(
          "unlock_approvals",
          JSONObject().put("request_id", requestId).put("approver_id", cfg.userId).put("sealed_share", sealedB64).put("approver_ed25519_pub", b64(me.ed25519Public)),
        )
      }.onFailure { Log.w(TAG, "unlock_approvals insert failed", it) }
    }
    return sealedB64
  }

  /** Fallback unlock, requester side: combine k re-sealed shares → K_day, cached for decryptLocations. */
  fun recoverFromShares(subject: String, epochId: String, sealedShares: JSONArray): Boolean {
    val me = identity()
    val shares = ArrayList<Share>()
    for (i in 0 until sealedShares.length()) {
      val s = sealedShares.getJSONObject(i)
      runCatching {
        val plain = openSealed(me.x25519Secret, unb64(s.getString("approverEd25519Pub")), unb64(s.getString("sealedB64")), "approval|$subject|$epochId".toByteArray(Charsets.UTF_8))
        shares.add(Share(plain[0].toUByte(), plain.copyOfRange(1, plain.size)))
      }.onFailure { Log.w(TAG, "open approval failed", it) }
    }
    if (shares.isEmpty()) return false
    return runCatching {
      val dayKey = combineShares(shares)
      prefs.putString(cacheKey(subject, epochId, null), b64(dayKey))
      dayKey.fill(0); shares.forEach { it.data.fill(0) }
      true
    }.getOrElse { Log.w(TAG, "combineShares failed", it); false }
  }
}
