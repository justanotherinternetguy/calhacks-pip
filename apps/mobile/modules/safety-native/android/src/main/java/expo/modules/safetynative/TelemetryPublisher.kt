package expo.modules.safetynative

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import uniffi.safety.EscalationLevel
import uniffi.safety.HmmState
import uniffi.safety.IncidentRecord
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToLong

/** Per-sample magnitudes SensingService collected since the previous telemetry tick (CONTRACTS §7 `accel` / `gyro`, newest last). */
class RawSamples(val accel: FloatArray, val gyro: FloatArray, val sampleHz: Int) {
  companion object { val EMPTY = RawSamples(FloatArray(0), FloatArray(0), 0) }
}

/**
 * Live telemetry stream to the web monitor (CONTRACTS §7). Each tick is one `TelemetryTick` JSON POSTed to
 * `{supabaseUrl}/realtime/v1/api/broadcast` as a private broadcast on `telemetry:{userId}` / event `tick` — no DB rows,
 * no location.
 *
 * Rate policy (re-evaluated every iteration, so night start/stop and the two switches need no wiring):
 * 4 Hz while `SafetyRuntime.telemetryOn` or `dashboardStreaming`, 1 Hz while night mode is active, otherwise idle.
 * The engine is still ticked at 1 s by SensingService; at 4 Hz this only re-reads `engine.metrics()` / `snapshot()`
 * (no I/O) and drains the per-sample rings (|a|, |ω|) and the engine-event ring, which are filled per sample / per tick.
 *
 * Delivery: one in-flight request at a time (a tick that lands while the previous POST is still out is dropped, not
 * queued); every failure counts and arms an exponential backoff 1 → 30 s during which ticks are skipped (rings keep the
 * last ≤ 64 samples / events). Incident deltas are the records with `id > lastSentIncidentId`, which only advances
 * when a POST succeeded, so a lost tick re-sends them. Logs one line per rate / network state change, never per tick.
 */
class TelemetryPublisher(private val rt: SafetyRuntime) {
  companion object {
    private const val TAG = "Telemetry"
    private const val HZ_FAST = 4
    private const val HZ_SLOW = 1
    private const val IDLE_POLL_MS = 1_000L
    private const val BACKOFF_MIN_MS = 1_000L
    private const val BACKOFF_MAX_MS = 30_000L
    private const val CALL_TIMEOUT_S = 5L
    private const val BATTERY_REFRESH_MS = 10_000L
    private const val LOG_REFRESH_MS = 1_000L
    private const val BROADCAST_PATH = "/realtime/v1/api/broadcast"
  }

  /** Same pool / dispatcher as the PostgREST client, shorter call timeout so a hung POST cannot block the stream for 30 s. */
  private val http by lazy { rt.supabase.client.newBuilder().callTimeout(CALL_TIMEOUT_S, TimeUnit.SECONDS).build() }
  private var job: Job? = null
  private val inFlight = AtomicBoolean(false)

  /** Current publish rate (0 = idle). */
  @Volatile var hz: Int = 0
    private set
  /** Wall-clock ms of the last POST that returned 2xx (0 = never). */
  @Volatile var lastSentMs: Long = 0L
    private set
  /** Total failed POSTs (HTTP non-2xx or I/O error) since process start. */
  @Volatile var failures: Int = 0
    private set

  private var seq = 0L
  private var dropped = 0
  /** Highest incident id acknowledged by a successful POST; the next tick sends the records above it. */
  @Volatile private var lastSentIncidentId = 0L
  private var backoffMs = 0L
  @Volatile private var backoffUntilMs = 0L
  private var batteryPct = 0
  private var batteryReadMs = 0L
  private var cachedLog: List<IncidentRecord> = emptyList()
  private var logReadMs = 0L
  private var netState = "idle"

  fun desiredHz(): Int = when {
    rt.telemetryOn || rt.dashboardStreamingOn -> HZ_FAST
    rt.nightActive -> HZ_SLOW
    else -> 0
  }

  /** `getTelemetryStatus()` payload: `on` is the explicit switch, `hz` what is actually being published right now. */
  fun statusMap(): Map<String, Any?> = mapOf("on" to rt.telemetryOn, "hz" to hz, "lastSentMs" to lastSentMs, "failures" to failures)

  @Synchronized
  fun start() {
    if (job?.isActive == true) return
    job = rt.scope.launch {
      var next = rt.now()
      while (isActive) {
        val h = desiredHz()
        if (h != hz) {
          hz = h
          Log.i(TAG, if (h == 0) "idle (telemetry off, no dashboard, no night mode)" else "$h Hz (${rateReason()})")
          next = rt.now()
        }
        if (h == 0) { delay(IDLE_POLL_MS); continue }
        val period = 1_000L / h
        val now = rt.now()
        if (now >= backoffUntilMs) publishOnce(now)
        next += period
        val wait = next - rt.now()
        if (wait < 0) next = rt.now()          // fell behind (Doze, slow build): resync instead of bursting
        delay(wait.coerceIn(0L, period))
      }
    }
  }

  @Synchronized
  fun stop() {
    val j = job ?: return
    job = null
    j.cancel()
    if (hz != 0) { hz = 0; Log.i(TAG, "stopped") }
  }

  private fun rateReason() = when {
    rt.telemetryOn -> "telemetry on"
    rt.dashboardStreamingOn -> "dashboard streaming"
    else -> "night mode"
  }

  // ---- one tick ---------------------------------------------------------------

  private fun publishOnce(now: Long) {
    val cfg = rt.prefs.serverConfig ?: return
    if (!inFlight.compareAndSet(false, true)) { dropped++; return }   // previous POST still out: drop, never queue
    val body: String
    val maxIncidentId: Long
    try {
      val (tick, maxId) = buildTick(now, cfg.userId)
      maxIncidentId = maxId
      val msg = JSONObject().put("topic", "telemetry:${cfg.userId}").put("event", "tick").put("private", true).put("payload", tick)
      body = JSONObject().put("messages", JSONArray().put(msg)).toString()
    } catch (t: Throwable) {
      inFlight.set(false)
      setNetState("build failed: ${t.javaClass.simpleName}: ${t.message?.take(80)}")
      return
    }
    rt.scope.launch(Dispatchers.IO) {
      try {
        val req = rt.supabase.authed(BROADCAST_PATH).post(body.toRequestBody(SupabaseRest.JSON)).build()
        http.newCall(req).execute().use { resp ->
          if (resp.isSuccessful) onSuccess(maxIncidentId) else onFailure("http ${resp.code}")
        }
      } catch (t: Throwable) {
        onFailure("io ${t.javaClass.simpleName}")
      } finally {
        inFlight.set(false)
      }
    }
  }

  private fun onSuccess(maxIncidentId: Long) {
    lastSentMs = rt.now()
    if (maxIncidentId > lastSentIncidentId) lastSentIncidentId = maxIncidentId
    backoffMs = 0L
    backoffUntilMs = 0L
    setNetState("ok")
  }

  private fun onFailure(reason: String) {
    failures++
    backoffMs = if (backoffMs == 0L) BACKOFF_MIN_MS else (backoffMs * 2).coerceAtMost(BACKOFF_MAX_MS)
    backoffUntilMs = rt.now() + backoffMs
    setNetState("failing ($reason)")
  }

  @Synchronized
  private fun setNetState(s: String) {
    if (s == netState) return
    netState = s
    Log.i(TAG, "$s; failures=$failures dropped=$dropped backoff=${backoffMs} ms")
  }

  /** The §7 `TelemetryTick` object plus the highest incident id it carries (to acknowledge on success). */
  private fun buildTick(now: Long, userId: String): Pair<JSONObject, Long> {
    val engine = runCatching { rt.engine.get() }.getOrNull()
    val snap = runCatching { engine?.snapshot() }.getOrNull()
    val metrics = runCatching { engine?.metrics()?.toMap() }.getOrNull() ?: emptyMetricsMap(now)
    val events = rt.drainTelemetryEvents()
    val raw = rt.sensing?.drainTelemetrySamples() ?: RawSamples.EMPTY

    // The log (with raw_json per record) is re-read once a second or as soon as a SignalIncident was dispatched.
    if (engine != null && (now - logReadMs >= LOG_REFRESH_MS || "signal_incident" in events)) {
      cachedLog = runCatching { engine.incidentLog() }.getOrDefault(cachedLog)
      logReadMs = now
    }
    val sentId = lastSentIncidentId
    val fresh = cachedLog.filter { it.id.toLong() > sentId }
    val maxId = fresh.maxOfOrNull { it.id.toLong() } ?: sentId

    if (now - batteryReadMs >= BATTERY_REFRESH_MS) { batteryPct = rt.batteryPct(); batteryReadMs = now }

    val o = JSONObject()
      .put("v", 1)
      .put("t", now)
      .put("seq", ++seq)
      .put("user", userId)
      .put("metrics", jsonOf(metrics))
      .put("hmm", rt.hmmName(snap?.hmmState ?: HmmState.NORMAL))
      .put("escalation", rt.escalationName(snap?.escalation ?: EscalationLevel.IDLE))
      .put("riskBand", snap?.riskBand?.toInt() ?: 0)
      .put("pDanger", jsonOf(snap?.pDanger?.toDouble() ?: 0.0))
      .put("nightMode", rt.nightActive)
      .put("battery", batteryPct)
      .put("activity", metrics["activity"] ?: "unknown")
      .put("placement", metrics["placement"] ?: "unknown")
      .put("samplingFull", metrics["samplingFull"] ?: false)
      .put("accel", magnitudes(raw.accel))
      .put("gyro", magnitudes(raw.gyro))
      .put("sampleHz", raw.sampleHz)
      .put("incidents", JSONArray().also { a -> fresh.forEach { a.put(jsonOf(it.toMap())) } })
      .put("incidentCount", cachedLog.size)
      .put("events", JSONArray(events))
    if (snap?.escalation == EscalationLevel.CHECK) {
      rt.pendingCheck?.let { (phrase, deadlineMs) -> o.put("checkPhrase", phrase).put("checkDeadlineMs", deadlineMs) }
    }
    return o to maxId
  }

  /** 4-decimal magnitudes; non-finite values become 0 so one bad sample cannot sink the tick (org.json rejects NaN). */
  private fun magnitudes(v: FloatArray): JSONArray = JSONArray().also { a ->
    for (x in v) a.put(if (x.isFinite()) (x.toDouble() * 10_000.0).roundToLong() / 10_000.0 else 0.0)
  }

  /** Map/List → JSONObject/JSONArray recursively; non-finite floats → JSON null (org.json throws on NaN/Infinity). */
  private fun jsonOf(v: Any?): Any = when (v) {
    null -> JSONObject.NULL
    is Map<*, *> -> JSONObject().also { o -> v.forEach { (k, x) -> o.put(k.toString(), jsonOf(x)) } }
    is Collection<*> -> JSONArray().also { a -> v.forEach { a.put(jsonOf(it)) } }
    is Double -> if (v.isFinite()) v else JSONObject.NULL
    is Float -> if (v.isFinite()) v.toDouble() else JSONObject.NULL
    else -> v
  }
}
