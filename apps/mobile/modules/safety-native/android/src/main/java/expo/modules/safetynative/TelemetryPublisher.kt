package expo.modules.safetynative

import android.util.Log
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import uniffi.safety.EscalationLevel
import uniffi.safety.IncidentRecord
import java.util.concurrent.TimeUnit
import kotlin.math.roundToLong

/**
 * Per-sample magnitudes SensingService collected since the previous telemetry frame (CONTRACTS §7, newest last).
 * `lastTMs` is the phone wall-clock of the newest sample (0 when empty); `hz` the measured delivery rate.
 */
class RawSamples(val accel: FloatArray, val gyro: FloatArray, val lastTMs: Long, val hz: Float) {
  companion object { val EMPTY = RawSamples(FloatArray(0), FloatArray(0), 0L, 0f) }
}

/**
 * Live telemetry stream to the web monitor (CONTRACTS §7). Frames go out as `tick` broadcasts on the private
 * Realtime channel `telemetry:{userId}` over one persistent WebSocket ([RealtimeSocket]) — no DB rows, no location.
 *
 * Rate policy (re-evaluated every iteration): [HZ_STREAM] while `SafetyRuntime.telemetryOn` or `dashboardStreamingOn`,
 * [HZ_NIGHT] while night mode is active, otherwise idle (socket closed). The engine is still ticked at 1 s by
 * SensingService; a frame only drains the per-sample rings (|a|, |ω| with timestamps) and the engine-event ring,
 * and attaches the full state block (metrics, risk band, mode pills, check-in) when the engine has ticked since
 * the previous state block or at least every [STATE_EVERY_MS], so a subscriber joining mid-stream is complete within a second.
 *
 * Latency probe: while streaming fast the channel is joined with `self = true`, so the server echoes our frames back;
 * `rttMs` (phone → Realtime → phone, same clock, no skew) rides on the next frame and is shown by the monitor and Settings.
 *
 * Delivery: a frame that lands while the socket is not joined is dropped (counted), never queued. Incident deltas are
 * the records with `id > lastSentIncidentId` or whose clearedMs / acknowledged / sequenceId changed since they were sent
 * ([sentSignatures]); both advance when a frame was handed to the socket, and every (re)join replays the whole live log
 * once (the monitor upserts by id). Logs one line per rate / socket state change, never per frame.
 */
class TelemetryPublisher(private val rt: SafetyRuntime) {
  companion object {
    private const val TAG = "Telemetry"
    private const val HZ_STREAM = 10
    private const val HZ_NIGHT = 1
    private const val IDLE_POLL_MS = 1_000L
    private const val STATE_EVERY_MS = 1_000L
    private const val BATTERY_REFRESH_MS = 10_000L
    private const val LOG_REFRESH_MS = 1_000L
    private const val RTT_EVERY_MS = 1_000L
    /** One status line a minute while publishing (rate, round trip, drops, session), for field diagnosis from logcat. */
    private const val SUMMARY_EVERY_MS = 60_000L
  }

  /** Same pool / dispatcher as the PostgREST client; no call timeout (the socket is long-lived), short connect timeout. */
  private val http by lazy { rt.supabase.client.newBuilder().callTimeout(0, TimeUnit.SECONDS).connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build() }
  private val socket by lazy { RealtimeSocket(rt.scope, http, TAG, ::onEcho) }
  /** `telemetry-cmd:{uid}`: commands from the web monitor (subject or a group-mate may send, only this phone reads). */
  private val cmdSocket by lazy { RealtimeSocket(rt.scope, http, "TelemetryCmd", ::onCommand) }
  private var job: Job? = null

  /** Current publish rate (0 = idle). */
  @Volatile var hz: Int = 0
    private set
  /** Wall-clock ms of the last frame handed to a joined socket (0 = never). */
  @Volatile var lastSentMs: Long = 0L
    private set
  /** Frames dropped because the socket was not joined. */
  @Volatile var dropped: Int = 0
    private set
  /** Smoothed phone → Realtime → phone round trip from the self-echo (null until the first echo). */
  @Volatile var rttMs: Int? = null
    private set

  private var seq = 0L
  @Volatile private var lastSentIncidentId = 0L
  /** id → (clearedMs, acknowledged, sequenceId) as last sent, so a record that changed after it opened is re-sent. */
  private val sentSignatures = HashMap<Long, Triple<Long, Boolean, Long>>()
  private var seenJoinEpoch = 0L
  private var lastStateMs = 0L
  private var lastStateTickMs = -1L
  private var batteryPct = 0
  private var batteryReadMs = 0L
  private var cachedLog: List<IncidentRecord> = emptyList()
  private var logReadMs = 0L
  private var netState = "idle"
  /** `seq → sent-at ms` of the frames awaiting their echo (bounded; only one probe per [RTT_EVERY_MS]). */
  private val probes = LinkedHashMap<Long, Long>()
  private var lastProbeMs = 0L
  private var rttEma = -1.0
  private var lastSummaryMs = 0L

  fun desiredHz(): Int = when {
    rt.telemetryOn || rt.dashboardStreamingOn -> HZ_STREAM
    rt.nightActive -> HZ_NIGHT
    else -> 0
  }

  /** `getTelemetryStatus()` payload: `on` is the explicit switch, `hz` what is actually being published right now. */
  fun statusMap(): Map<String, Any?> = mapOf(
    "on" to rt.telemetryOn, "hz" to hz, "lastSentMs" to lastSentMs, "failures" to socket.failures,
    "connected" to socket.joined, "reconnects" to socket.reconnects, "dropped" to dropped, "rttMs" to rttMs, "error" to socket.lastError,
  )

  /** Session refresh: the joined channel gets the new JWT without reconnecting. */
  fun onTokenChanged(jwt: String) { socket.setToken(jwt); cmdSocket.setToken(jwt) }

  /** Connectivity restored (SafetyRuntime's NetworkCallback): reconnect without waiting out the backoff. */
  fun onNetworkAvailable() { if (hz != 0) { socket.retryNow(); cmdSocket.retryNow() } }

  @Synchronized
  fun start() {
    if (job?.isActive == true) return
    job = rt.scope.launch {
      var next = rt.now()
      while (isActive) {
        val h = desiredHz()
        val cfg = rt.prefs.serverConfig?.takeIf { it.accessToken.isNotBlank() }
        if (h != hz) {
          hz = h
          Log.i(TAG, if (h == 0) "idle (telemetry off, no dashboard, no night mode)" else "$h Hz (${rateReason()})")
          next = rt.now()
        }
        if (h == 0 || cfg == null) { socket.stop(); cmdSocket.stop(); setNetState("idle"); delay(IDLE_POLL_MS); continue }
        socket.start(RealtimeSocket.Target(cfg.supabaseUrl, cfg.supabaseAnonKey, "telemetry:${cfg.userId}", selfEcho = h == HZ_STREAM), cfg.accessToken)
        cmdSocket.start(RealtimeSocket.Target(cfg.supabaseUrl, cfg.supabaseAnonKey, "telemetry-cmd:${cfg.userId}", selfEcho = false), cfg.accessToken)
        val period = 1_000L / h
        val now = rt.now()
        publishOnce(now, cfg.userId)
        if (now - lastSummaryMs >= SUMMARY_EVERY_MS) {
          lastSummaryMs = now
          Log.i(TAG, "summary: $h Hz joined=${socket.joined} rtt=${rttMs?.let { "$it ms" } ?: "-"} seq=$seq dropped=$dropped reconnects=${socket.reconnects} failures=${socket.failures}; ${rt.session.statusLine()}")
        }
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
    socket.stop()
    cmdSocket.stop()
    if (hz != 0) { hz = 0; Log.i(TAG, "stopped") }
  }

  private fun rateReason() = when {
    rt.telemetryOn -> "telemetry on"
    rt.dashboardStreamingOn -> "dashboard streaming"
    else -> "night mode"
  }

  // ---- one frame -----------------------------------------------------------------

  private fun publishOnce(now: Long, userId: String) {
    if (!socket.joined) { dropped++; setNetState("waiting for channel (${socket.lastError ?: "connecting"})"); return }
    if (socket.joinEpoch != seenJoinEpoch) {           // fresh join: replay the live log and send a state block right away
      seenJoinEpoch = socket.joinEpoch
      lastSentIncidentId = 0L
      sentSignatures.clear()
      lastStateMs = 0L
      synchronized(probes) { probes.clear() }
    }
    val frame: JSONObject
    val sentRecords: List<IncidentRecord>
    try {
      val (f, records) = buildFrame(now, userId)
      frame = f; sentRecords = records
    } catch (t: Throwable) {
      setNetState("build failed: ${t.javaClass.simpleName}: ${t.message?.take(80)}")
      return
    }
    if (socket.send("tick", frame)) {
      lastSentMs = now
      if (sentRecords.isNotEmpty()) {
        val live = cachedLog.mapTo(HashSet()) { it.id.toLong() }
        sentSignatures.keys.retainAll(live)   // drop records the engine expired
        for (r in sentRecords) {
          val id = r.id.toLong()
          if (id > lastSentIncidentId) lastSentIncidentId = id
          sentSignatures[id] = r.signature()
        }
      }
      setNetState("ok")
    } else {
      dropped++
      setNetState("send failed")
    }
  }

  /** A command from a web monitor on `telemetry-cmd:{uid}` (the subject or a group-mate), e.g. `{ cmd: "reset_incidents" }`. */
  private fun onCommand(event: String, payload: JSONObject, @Suppress("UNUSED_PARAMETER") receivedAtMs: Long) {
    if (event != "command") return
    when (val cmd = payload.optString("cmd")) {
      "reset_incidents" -> rt.scope.launch {
        Log.i(TAG, "monitor command: reset_incidents")
        runCatching { rt.resetIncidents() }.onFailure { Log.w(TAG, "remote reset failed", it) }
      }
      else -> Log.w(TAG, "unknown monitor command: $cmd")
    }
  }

  /** Our own frame echoed back by the server: round trip on the phone's clock. */
  private fun onEcho(event: String, payload: JSONObject, receivedAtMs: Long) {
    if (event != "tick") return
    val s = payload.optLong("seq", -1L)
    val sentAt = synchronized(probes) { probes.remove(s) } ?: return
    val rtt = (receivedAtMs - sentAt).toDouble()
    if (rttEma < 0) Log.i(TAG, "first echo: round trip ${rtt.toLong()} ms")
    rttEma = if (rttEma < 0) rtt else rttEma * 0.7 + rtt * 0.3
    rttMs = rttEma.roundToLong().toInt()
  }

  @Synchronized
  private fun setNetState(s: String) {
    if (s == netState) return
    netState = s
    Log.i(TAG, "$s; dropped=$dropped failures=${socket.failures} reconnects=${socket.reconnects}${rttMs?.let { " rtt=${it} ms" } ?: ""}")
  }

  private fun IncidentRecord.signature() = Triple(clearedMs.toLong(), acknowledged, sequenceId.toLong())

  /** The §7 v2 frame plus the incident records it carries (marked as sent once the socket took the frame). */
  private fun buildFrame(now: Long, userId: String): Pair<JSONObject, List<IncidentRecord>> {
    val engine = runCatching { rt.engine.get() }.getOrNull()
    val events = rt.drainTelemetryEvents()
    val raw = rt.sensing?.drainTelemetrySamples() ?: RawSamples.EMPTY

    // The log (with raw_json per record) is re-read once a second or as soon as an incident opened or cleared.
    if ("incident_log_cleared" in events) sentSignatures.clear()   // the monitor empties its list on this event
    if (engine != null && (now - logReadMs >= LOG_REFRESH_MS || "signal_incident" in events || "incident_cleared" in events || "incident_log_cleared" in events)) {
      cachedLog = runCatching { engine.incidentLog() }.getOrDefault(cachedLog)
      logReadMs = now
    }
    val sentId = lastSentIncidentId
    val fresh = cachedLog.filter { val id = it.id.toLong(); id > sentId || sentSignatures[id]?.let { s -> s != it.signature() } == true }

    val o = JSONObject()
      .put("v", 2)
      .put("t", now)
      .put("seq", ++seq)
      .put("user", userId)
      .put("accel", magnitudes(raw.accel))
      .put("gyro", magnitudes(raw.gyro))
      .put("st", raw.lastTMs)
      .put("sampleHz", (raw.hz * 10f).roundToLong() / 10.0)
      .put("incidents", JSONArray().also { a -> fresh.forEach { a.put(jsonOf(it.toMap())) } })
      .put("incidentCount", cachedLog.size)
      .put("events", JSONArray(events))
    rttMs?.let { o.put("rttMs", it) }

    // State block: after every engine tick, at least once a second, and whenever something happened.
    val tickMs = rt.lastTickMs
    if (tickMs != lastStateTickMs || now - lastStateMs >= STATE_EVERY_MS || events.isNotEmpty() || fresh.isNotEmpty()) {
      lastStateTickMs = tickMs
      lastStateMs = now
      o.put("state", stateBlock(now, engine))
    }

    // Latency probe: remember when this frame left; the echo (self = true) closes the loop in [onEcho].
    if (socket.currentTarget()?.selfEcho == true && now - lastProbeMs >= RTT_EVERY_MS) {
      lastProbeMs = now
      synchronized(probes) {
        probes[seq] = now
        while (probes.size > 8) probes.remove(probes.keys.first())
      }
    }
    return o to fresh
  }

  private fun stateBlock(now: Long, engine: uniffi.safety.SafetyEngine?): JSONObject {
    val snap = runCatching { engine?.snapshot() }.getOrNull()
    val metrics = runCatching { engine?.metrics()?.toMap() }.getOrNull() ?: emptyMetricsMap(now)
    if (now - batteryReadMs >= BATTERY_REFRESH_MS) { batteryPct = rt.batteryPct(); batteryReadMs = now }
    val s = JSONObject()
      .put("metrics", jsonOf(metrics))
      .put("escalation", rt.escalationName(snap?.escalation ?: EscalationLevel.IDLE))
      .put("listening", snap?.listening ?: false)
      .put("nightMode", rt.nightActive)
      .put("battery", batteryPct)
      .put("activity", metrics["activity"] ?: "unknown")
      .put("placement", metrics["placement"] ?: "unknown")
      .put("samplingFull", metrics["samplingFull"] ?: false)
    if (snap?.escalation == EscalationLevel.CHECK) {
      rt.pendingCheck?.let { (phrase, deadlineMs) -> s.put("checkPhrase", phrase).put("checkDeadlineMs", deadlineMs) }
    }
    return s
  }

  /** 4-decimal magnitudes; non-finite values become 0 so one bad sample cannot sink the frame (org.json rejects NaN). */
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
