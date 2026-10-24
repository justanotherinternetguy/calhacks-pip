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

  /** Native-side copy of the last SignalIncident records (newest last, capped); the engine keeps the authoritative log. */
  private val signalRing = ArrayDeque<IncidentRecord>()
  private var dashboardJob: Job? = null

  init { touch.start() }

  val isDebuggable: Boolean get() = (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
  val configured: Boolean get() = prefs.serverConfig != null
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

  /** While on, emits `dashboard` once a second (only while the JS sink is attached). */
  @Synchronized
  fun setDashboardStreaming(on: Boolean) {
    if (!on) { dashboardJob?.cancel(); dashboardJob = null; return }
    if (dashboardJob?.isActive == true) return
    dashboardJob = scope.launch {
      while (isActive) {
        if (sink != null) runCatching { emit("dashboard", dashboardMap()) }.onFailure { Log.w(TAG, "dashboard emit failed", it) }
        delay(1_000L)
      }
    }
  }

  fun hmmName(s: HmmState) = when (s) {
    HmmState.NORMAL -> "normal"; HmmState.IMPAIRED -> "impaired"; HmmState.INCIDENT -> "incident"; HmmState.UNRESPONSIVE -> "unresponsive"
  }

  fun escalationName(e: EscalationLevel) = when (e) {
    EscalationLevel.IDLE -> "idle"; EscalationLevel.CHECK -> "check"; EscalationLevel.HEADS_UP -> "heads_up"
    EscalationLevel.UNLOCKED -> "unlocked"; EscalationLevel.SNATCH -> "snatch"; EscalationLevel.RESOLVED -> "resolved"
  }

  // ---- engine events ------------------------------------------------------

  /** Called from the sensing service's 1 s tick loop (and the trace injector). */
  fun dispatch(events: List<EngineEvent>) {
    for (ev in events) {
      try { handle(ev) } catch (e: Throwable) { Log.e(TAG, "event $ev failed", e) }
    }
    if (events.isNotEmpty()) emitStatus()
  }

  private fun handle(ev: EngineEvent) {
    when (ev) {
      is EngineEvent.CheckRequested -> {
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
    scope.launch { dispatch(engine.get().tick(now().toULong())) }
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
