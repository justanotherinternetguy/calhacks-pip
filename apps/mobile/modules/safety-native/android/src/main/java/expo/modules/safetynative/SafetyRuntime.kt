package expo.modules.safetynative

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.location.Location
import android.os.BatteryManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import uniffi.safety.EngineEvent
import uniffi.safety.EscalationLevel
import uniffi.safety.HmmState
import uniffi.safety.IncidentRecord
import uniffi.safety.Snapshot
import uniffi.safety.UserAction

/** Receives events that should reach JS (when the JS runtime is alive). */
interface RuntimeEventSink {
  fun emit(name: String, payload: Map<String, Any?>)
}

/**
 * Process-wide singleton wiring every native component together. Lives as long as the process
 * (the foreground service keeps it alive); the Expo module attaches/detaches as JS comes and goes.
 */
class SafetyRuntime private constructor(val app: Context) {
  companion object {
    private const val TAG = "SafetyRuntime"
    private const val SIGNAL_RING_MAX = 64
    private const val EVENT_RING_MAX = 64
    @Volatile private var instance: SafetyRuntime? = null
    fun get(context: Context): SafetyRuntime =
      instance ?: synchronized(this) { instance ?: SafetyRuntime(context.applicationContext).also { instance = it } }
    fun peek(): SafetyRuntime? = instance
  }

  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  val prefs = Prefs(app)
  val touch = TouchTracker(this)
  val engine = EngineHolder(app, prefs)
  val supabase = SupabaseRest(prefs)
  val alerts = AlertManager(app, this)
  val escrow = EscrowManager(this)
  val heartbeat = HeartbeatUploader(this)
  val locationUploader = LocationUploader(this)
  val proximityUploader = ProximityUploader(this)
  val sos = SosManager(this)
  /** Live telemetry stream to the web monitor (CONTRACTS §7). */
  val telemetry = TelemetryPublisher(this)

  @Volatile var sink: RuntimeEventSink? = null
  @Volatile var lastLocation: Location? = null
  @Volatile var lastHeartbeatMs: Long? = null
  @Volatile var serviceRunning = false
  @Volatile var nightActive = false
  @Volatile var nightSince: Long? = null
  @Volatile var nightReason = "off"
  @Volatile var currentIncidentId: String? = null
  @Volatile var sosActive = false
  @Volatile var separated = false
  @Volatile var baselineWalkStartMs = 0L
  @Volatile var awayFromHome = false
  /** Sampling mode requested by the engine (EngineEvent.SamplingRateChanged): true = 50 Hz + gyro. */
  @Volatile var samplingFull = false
  /** The live foreground service, if any (set in onCreate/onDestroy), so engine events can reconfigure sensors. */
  @Volatile var sensing: SensingService? = null

  /**
   * True while the personal dashboard is on screen (setDashboardStreaming). Forces FULL sampling and a 1 s engine
   * tick in SensingService; each tick is followed by a `dashboard` event so the UI never paints a stale snapshot.
   */
  @Volatile var dashboardStreamingOn = false
  /** Wall-clock time of the last engine tick (any loop); getDashboard re-ticks when this is older than 1 s. */
  @Volatile var lastTickMs = 0L

  /**
   * Explicit telemetry switch (CONTRACTS §7, `setTelemetry`), persisted in Prefs and cached here because the 4 Hz
   * publisher and `effectiveFull()` read it often. Defaults to ON, but only counts once `configure` ran (see [telemetryOn]).
   */
  @Volatile private var telemetryEnabled = prefs.telemetryOn
  @Volatile private var telemetryConfigured = prefs.serverConfig != null
  /** True while the telemetry stream is explicitly on: publisher at 4 Hz and FULL sampling forced, like dashboard streaming. */
  val telemetryOn: Boolean get() = telemetryEnabled && telemetryConfigured
  /** `(phrase, deadlineMs)` of the open check-in, for the telemetry tick; set on CheckRequested, cleared on Resolved. */
  @Volatile var pendingCheck: Pair<String, Long>? = null

  /** Native-side copy of the last SignalIncident records (newest last, capped); the engine keeps the authoritative log. */
  private val signalRing = ArrayDeque<IncidentRecord>()
  /** snake_case names of the engine events dispatched since the telemetry publisher last drained them (capped). */
  private val eventRing = ArrayDeque<String>()
  /** Fallback 1 s ticker used only while streaming without a running service (no sensors, but the engine still ages). */
  private var dashboardJob: Job? = null

  init { touch.start() }

  val isDebuggable: Boolean get() = (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
  val configured: Boolean get() = prefs.serverConfig != null

  /** `configure()` just stored a ServerConfig: telemetry (default on) becomes effective, sampling + publisher follow. */
  fun onConfigured() {
    telemetryConfigured = true
    sensing?.onStreamingChanged()
    syncTelemetryPublisher()
  }
  fun now(): Long = System.currentTimeMillis()

  fun batteryPct(): Int {
    val bm = app.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).coerceIn(0, 100)
  }

  fun emit(name: String, payload: Map<String, Any?>) {
    try { sink?.emit(name, payload) } catch (e: Throwable) { Log.w(TAG, "emit $name failed", e) }
  }

  fun emitStatus() = emit("statusChanged", statusMap())

  // ---- status -------------------------------------------------------------

  fun statusMap(): Map<String, Any?> {
    val snap = engine.snapshotOrNull()
    return mapOf(
      "nightMode" to mapOf("active" to nightActive, "since" to nightSince, "reason" to nightReason),
      "engine" to snapshotMap(snap),
      "permissions" to PermissionHelper.current(app),
      "batteryPct" to batteryPct(),
      "lastHeartbeatMs" to lastHeartbeatMs,
      "serviceRunning" to serviceRunning,
    )
  }

  fun snapshotMap(s: Snapshot?): Map<String, Any?> = mapOf(
    "pDanger" to (s?.pDanger?.toDouble() ?: 0.0),
    "hmmState" to hmmName(s?.hmmState ?: HmmState.NORMAL),
    "escalation" to escalationName(s?.escalation ?: EscalationLevel.IDLE),
    "riskBand" to (s?.riskBand?.toInt() ?: 0),
    "evidence" to (s?.evidence ?: ""),
    "baselineSeconds" to (s?.baselineSeconds?.toLong() ?: 0L),
    "placement" to placementName(s?.placement),
    "nightMode" to (s?.nightMode ?: false),
  )

  // ---- dashboard (CONTRACTS §6) ---------------------------------------------

  fun recentSignals(): List<IncidentRecord> = synchronized(signalRing) { signalRing.toList() }

  /** `{ metrics: LiveMetrics, incidents: IncidentRecord[] }` from the engine; falls back to the native ring if the engine is unavailable. */
  fun dashboardMap(): Map<String, Any?> {
    val e = try { engine.get() } catch (t: Throwable) { null }
    val metrics = runCatching { e?.metrics()?.toMap() }.getOrNull() ?: emptyMetricsMap(now())
    val incidents = runCatching { e?.incidentLog()?.map { it.toMap() } }.getOrNull() ?: recentSignals().map { it.toMap() }
    return mapOf("metrics" to metrics, "incidents" to incidents)
  }

  /** `dashboardMap()` after a fresh engine tick when the last one is older than 1 s, so the first paint is current. */
  fun freshDashboardMap(): Map<String, Any?> {
    val now = now()
    if (now - lastTickMs >= 1_000L) {
      runCatching { sensing?.tickNow(now, emitDashboard = false) ?: runTick(now, emitDashboard = false) }
        .onFailure { Log.w(TAG, "dashboard tick failed", it) }
    }
    return dashboardMap()
  }

  /**
   * While on: SensingService forces FULL sampling and ticks the engine every second (pushing Context each time),
   * and every tick is followed by a `dashboard` event (see [runTick]). Off: sampling returns to what the engine asked for.
   * Without a running service a fallback job ticks the engine itself so the dashboard still moves.
   */
  @Synchronized
  fun setDashboardStreaming(on: Boolean) {
    if (dashboardStreamingOn == on) return
    dashboardStreamingOn = on
    val svc = sensing
    val mode = if (on) "FULL (50 Hz + gyro, forced)" else "engine-requested (${if (samplingFull) "FULL" else "LOW"})"
    Log.i(TAG, "dashboard streaming ${if (on) "on" else "off"}: sampling $mode, tick ${if (on) "1 s" else "engine cadence"}${if (svc == null) ", service not running" else ""}")
    svc?.onStreamingChanged()
    syncTelemetryPublisher()
    if (!on) { dashboardJob?.cancel(); dashboardJob = null; return }
    dashboardJob = scope.launch {
      while (isActive) {
        if (sensing == null) runCatching { runTick(now()) }.onFailure { Log.w(TAG, "fallback tick failed", it) }
        delay(1_000L)
      }
    }
  }

  // ---- telemetry (CONTRACTS §7) ----------------------------------------------

  /**
   * `setTelemetry(on)`: persist the switch; while on, SensingService forces FULL sampling (the monitor wants real gait
   * metrics) and the day ticker runs every second, and the publisher streams at 4 Hz (see [TelemetryPublisher]).
   */
  @Synchronized
  fun setTelemetry(on: Boolean) {
    prefs.telemetryOn = on
    if (telemetryEnabled == on) return
    telemetryEnabled = on
    Log.i(TAG, "telemetry ${if (on) "on" else "off"}: sampling ${if (on) "FULL (forced)" else "per dashboard / engine request"}${if (sensing == null) ", service not running" else ""}")
    sensing?.onStreamingChanged()
    syncTelemetryPublisher()
  }

  /**
   * The publisher runs while the service is alive (SensingService.onCreate starts it, onDestroy stops it) or while
   * something explicitly asks for the stream without a service — then it publishes whatever the engine holds.
   */
  fun syncTelemetryPublisher() {
    if (sensing != null || telemetryOn || dashboardStreamingOn) telemetry.start() else telemetry.stop()
  }

  /** Engine events (snake_case, CONTRACTS §7 `events`) since the previous call; clears the ring. */
  fun drainTelemetryEvents(): List<String> = synchronized(eventRing) { val l = eventRing.toList(); eventRing.clear(); l }

  private fun eventName(ev: EngineEvent): String = when (ev) {
    is EngineEvent.CheckRequested -> "check_requested"
    is EngineEvent.HeadsUp -> "heads_up"
    is EngineEvent.UnlockLocation -> "unlock_location"
    is EngineEvent.SnatchDetected -> "snatch_detected"
    EngineEvent.Resolved -> "resolved"
    is EngineEvent.RiskBandChanged -> "risk_band_changed"
    EngineEvent.BatteryDying -> "battery_dying"
    is EngineEvent.LocationIntervalChanged -> "location_interval_changed"
    is EngineEvent.SamplingRateChanged -> "sampling_rate_changed"
    is EngineEvent.SignalIncident -> "signal_incident"
    is EngineEvent.CallOptionAvailable -> "call_option"
  }

  fun hmmName(s: HmmState) = when (s) {
    HmmState.NORMAL -> "normal"; HmmState.IMPAIRED -> "impaired"; HmmState.INCIDENT -> "incident"; HmmState.UNRESPONSIVE -> "unresponsive"
  }

  fun escalationName(e: EscalationLevel) = when (e) {
    EscalationLevel.IDLE -> "idle"; EscalationLevel.CHECK -> "check"; EscalationLevel.HEADS_UP -> "heads_up"
    EscalationLevel.UNLOCKED -> "unlocked"; EscalationLevel.SNATCH -> "snatch"; EscalationLevel.RESOLVED -> "resolved"
  }

  // ---- engine events ------------------------------------------------------

  /**
   * One engine tick: dispatch its events, then (while streaming and JS is attached) emit `dashboard` right behind it,
   * so the snapshot the UI receives is the one this tick produced. Every wall-clock tick loop goes through here.
   */
  fun runTick(now: Long = now(), emitDashboard: Boolean = true) {
    val events = engine.get().tick(now.toULong())
    lastTickMs = now
    dispatch(events)
    if (emitDashboard && dashboardStreamingOn && sink != null) {
      runCatching { emit("dashboard", dashboardMap()) }.onFailure { Log.w(TAG, "dashboard emit failed", it) }
    }
  }

  /** Called from the sensing service's tick loops (via [runTick]) and the trace injector. */
  fun dispatch(events: List<EngineEvent>) {
    for (ev in events) {
      val name = eventName(ev)
      synchronized(eventRing) { eventRing.addLast(name); while (eventRing.size > EVENT_RING_MAX) eventRing.removeFirst() }
      // Sampling/interval changes are logged where they are applied; everything else is a rare transition worth a line.
      if (ev is EngineEvent.SignalIncident) Log.i(TAG, "incident: ${incidentKindName(ev.record.kind)} ${"%.1f".format(ev.record.sdDistance)} SD — ${ev.record.summary}")
      else if (ev !is EngineEvent.SamplingRateChanged && ev !is EngineEvent.LocationIntervalChanged) Log.i(TAG, "engine event: $name")
      try { handle(ev) } catch (e: Throwable) { Log.e(TAG, "event $ev failed", e) }
    }
    if (events.isNotEmpty()) emitStatus()
  }

  private fun handle(ev: EngineEvent) {
    when (ev) {
      is EngineEvent.CheckRequested -> {
        pendingCheck = ev.phrase to ev.deadlineMs.toLong()
        alerts.showCheckIn(ev.phrase, ev.deadlineMs.toLong())
        AlarmReceiver.scheduleCheckTimeout(app, ev.deadlineMs.toLong())
        emit("checkRequested", mapOf("phrase" to ev.phrase, "deadlineMs" to ev.deadlineMs.toLong()))
      }
      is EngineEvent.HeadsUp -> {
        // Also emitted immediately on a grab (v1.1). Deliberately NO key release and NO location here:
        // the engine follows up with UnlockLocation after 2 min unless PhoneUnlocked/BiometricDismiss.
        alerts.cancelCheckIn()
        scope.launch {
          val id = openIncident("heads_up", ev.summary)
          alerts.pushToGroup(id, "heads_up", "Heads up", "${displayName()} might not be okay: ${ev.summary}", critical = false)
        }
        emit("escalation", mapOf("level" to "heads_up", "summary" to ev.summary))
      }
      is EngineEvent.UnlockLocation -> {
        alerts.cancelCheckIn()
        scope.launch {
          val id = openIncident("unlocked", ev.summary)
          escrow.releaseHourKeys(id)
          locationUploader.uploadNow()
          alerts.pushToGroup(id, "release", "${displayName()} needs help", ev.summary, critical = true)
        }
        emit("escalation", mapOf("level" to "unlocked", "summary" to ev.summary))
      }
      is EngineEvent.SnatchDetected -> {
        val loc = lastLocation
        scope.launch {
          val id = openIncident("snatch", ev.summary)
          escrow.releaseHourKeys(id)
          locationUploader.uploadNow()
          alerts.pushToGroup(
            id, "heads_up", "${displayName()}'s phone may have been snatched",
            "${ev.summary}. ${displayName()} may be without a phone. Don't chase.", critical = true,
          )
        }
        emit("snatch", mapOf("summary" to ev.summary, "lat" to loc?.latitude, "lng" to loc?.longitude))
        emit("escalation", mapOf("level" to "snatch", "summary" to ev.summary))
      }
      EngineEvent.Resolved -> {
        pendingCheck = null
        alerts.cancelCheckIn()
        AlarmReceiver.cancelCheckTimeout(app)
        scope.launch { resolveIncident() }
        sosActive = false
        emit("sos", mapOf("active" to false))
        emit("escalation", mapOf("level" to "resolved", "summary" to ""))
      }
      is EngineEvent.RiskBandChanged -> scope.launch { heartbeat.sendNow() }
      EngineEvent.BatteryDying -> scope.launch {
        locationUploader.uploadNow()
        val id = openIncident("battery_dying", "Battery at ${batteryPct()}%")
        alerts.pushToGroup(id, "battery_dying", "${displayName()}'s phone is dying", "Battery almost empty during night mode", critical = false)
      }
      is EngineEvent.LocationIntervalChanged -> locationUploader.setIntervalSeconds(ev.seconds.toLong())
      is EngineEvent.SamplingRateChanged -> {
        val full = ev.gyro || ev.hz.toInt() > 15
        Log.i(TAG, "sampling → ${ev.hz} Hz gyro=${ev.gyro} (full=$full)")
        samplingFull = full
        sensing?.applySampling()
      }
      is EngineEvent.SignalIncident -> {
        synchronized(signalRing) { signalRing.addLast(ev.record); while (signalRing.size > SIGNAL_RING_MAX) signalRing.removeFirst() }
        emit("signalIncident", ev.record.toMap())
      }
      is EngineEvent.CallOptionAvailable -> {
        scope.launch {
          // Attach to the running incident (heads-up/unlock already opened it); open one only if somehow missing.
          val id = currentIncidentId ?: openIncident("heads_up", ev.summary)
          alerts.pushToGroup(id, "call_option", "No response for 10 minutes", ev.summary, critical = true)
        }
        emit("callOption", mapOf("summary" to ev.summary))
      }
    }
  }

  fun pushAction(action: UserAction) {
    engine.get().pushAction(action, now().toULong())
    scope.launch { runTick() }
  }

  fun displayName(): String = prefs.getString("display_name") ?: "Your friend"

  // ---- incidents ----------------------------------------------------------

  /** Opens (or reuses) the incident row for the current escalation episode; returns its id. */
  suspend fun openIncident(level: String, summary: String): String? {
    val cfg = prefs.serverConfig ?: return null
    val existing = currentIncidentId
    if (existing != null) {
      // Escalate the existing incident instead of opening a second one.
      runCatching { supabase.patch("incidents", "id=eq.$existing", JSONObject().put("level", level).put("summary", summary)) }
      return existing
    }
    val body = JSONObject().put("user_id", cfg.userId).put("level", level).put("summary", summary)
    escrow.groupId()?.let { body.put("group_id", it) }
    val id = runCatching { supabase.insertReturning("incidents", body)?.optString("id") }.getOrNull()
    currentIncidentId = id
    return id
  }

  suspend fun resolveIncident() {
    val id = currentIncidentId ?: return
    currentIncidentId = null
    runCatching {
      supabase.patch("incidents", "id=eq.$id", JSONObject().put("level", "resolved").put("resolved_at", SupabaseRest.isoNow()))
      supabase.insert("incident_events", JSONObject().put("incident_id", id).put("actor_id", prefs.serverConfig?.userId).put("kind", "resolved"))
    }
  }

  // ---- service control ----------------------------------------------------

  fun startService(allowMic: Boolean) {
    val i = Intent(app, SensingService::class.java).setAction(SensingService.ACTION_START).putExtra(SensingService.EXTRA_ALLOW_MIC, allowMic)
    try {
      androidx.core.content.ContextCompat.startForegroundService(app, i)
    } catch (e: Throwable) {
      Log.e(TAG, "startForegroundService failed", e)
    }
  }

  suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }
}
