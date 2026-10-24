package expo.modules.safetynative

import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import uniffi.safety.Location
import uniffi.safety.encryptLocation
import uniffi.safety.proximityTokens

internal fun b64(b: ByteArray): String = Base64.encodeToString(b, Base64.NO_WRAP)
internal fun unb64(s: String): ByteArray = Base64.decode(s, Base64.NO_WRAP)

/** Base for "do X every N seconds while night mode is on" loops. */
abstract class PeriodicUploader(protected val rt: SafetyRuntime, private val tag: String) {
  private var job: Job? = null
  @Volatile protected var intervalMs: Long = 120_000L

  fun start() {
    if (job?.isActive == true) return
    job = rt.scope.launch {
      while (isActive) {
        runCatching { rt.io { tickOnce() } }.onFailure { Log.w(tag, "upload failed", it) }
        delay(intervalMs)
      }
    }
  }
  fun stop() { job?.cancel(); job = null }
  fun isRunning() = job?.isActive == true
  protected abstract fun tickOnce()
}

/** Every 2 min in night mode: PATCH devices (status level, battery, risk band). No location. */
class HeartbeatUploader(rt: SafetyRuntime) : PeriodicUploader(rt, "Heartbeat") {
  override fun tickOnce() {
    val cfg = rt.prefs.serverConfig ?: return
    val snap = rt.engine.snapshotOrNull()
    val patch = JSONObject()
      .put("last_heartbeat", SupabaseRest.isoNow())
      .put("night_mode", rt.nightActive)
      .put("battery_pct", rt.batteryPct())
      .put("risk_band", snap?.riskBand?.toInt() ?: 0)
      .put("status_level", rt.escalationName(snap?.escalation ?: uniffi.safety.EscalationLevel.IDLE))
    rt.supabase.patch("devices", "id=eq.${cfg.deviceId}", patch)
    rt.lastHeartbeatMs = rt.now()
    rt.emitStatus()
  }
  suspend fun sendNow() { runCatching { rt.io { tickOnce() } }.onFailure { Log.w("Heartbeat", "sendNow failed", it) } }
}

/**
 * Encrypted live location, 1–5 min adaptive (engine drives the interval via LocationIntervalChanged).
 * `encryptLocation(K_h, user, epoch, seq, loc)` → location_blobs. The server never sees coordinates.
 */
class LocationUploader(rt: SafetyRuntime) : PeriodicUploader(rt, "LocationUploader") {
  fun setIntervalSeconds(s: Long) { intervalMs = (s * 1000L).coerceIn(60_000L, 300_000L) }

  override fun tickOnce() {
    val cfg = rt.prefs.serverConfig ?: return
    val loc = rt.lastLocation ?: return
    val epoch = rt.escrow.currentEpoch() ?: return  // no group → nothing to escrow to
    // CONTRACTS §5: seq = upload wall-clock unix ms; hour_index = floor(seq / 3_600_000) (UTC-absolute).
    val s = rt.now()
    val hourIndex = rt.escrow.hourIndex(s)
    val key = rt.escrow.hourKey(hourIndex)
    val plain = Location(loc.latitude, loc.longitude, loc.accuracy, loc.time.toULong())
    val blob = encryptLocation(key, cfg.userId, epoch.epochId, s.toULong(), plain)
    key.fill(0)
    rt.supabase.insert(
      "location_blobs",
      JSONObject().put("user_id", cfg.userId).put("epoch_id", epoch.epochId)
        .put("hour_index", hourIndex).put("seq", s).put("ciphertext", b64(blob)),
    )
  }

  /** Immediate upload (unlock, snatch, battery dying). */
  suspend fun uploadNow() { runCatching { rt.io { tickOnce() } }.onFailure { Log.w("LocationUploader", "uploadNow failed", it) } }
}

/** Every 2 min: 9 HMAC geohash tokens for own cell + neighbours → proximity_tokens. */
class ProximityUploader(rt: SafetyRuntime) : PeriodicUploader(rt, "ProximityUploader") {
  override fun tickOnce() {
    val cfg = rt.prefs.serverConfig ?: return
    val loc = rt.lastLocation ?: return
    val groupId = rt.escrow.groupId() ?: return
    val key = rt.escrow.groupEpochKey() ?: return
    val tokens = proximityTokens(key, loc.latitude, loc.longitude)
    key.fill(0)
    val arr = JSONArray().also { a -> tokens.forEach { a.put(b64(it)) } }
    rt.supabase.insert("proximity_tokens", JSONObject().put("user_id", cfg.userId).put("group_id", groupId).put("tokens", arr))
    // Read back what the server's proximity function concluded (together / separated only).
    val row = rt.supabase.select("presence", "group_id=eq.$groupId&user_id=eq.${cfg.userId}&select=together&limit=1").optJSONObject(0)
    if (row != null) rt.separated = !row.optBoolean("together", true)
  }
}
