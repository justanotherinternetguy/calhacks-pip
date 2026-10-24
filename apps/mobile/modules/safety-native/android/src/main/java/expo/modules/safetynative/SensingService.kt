package expo.modules.safetynative

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import uniffi.safety.Activity
import uniffi.safety.Context as EngineContext
import uniffi.safety.HmmState
import uniffi.safety.MotionSample
import java.time.LocalTime
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Persistent foreground service. Day mode: geofence + activity transitions, LOW-rate motion
 * (~10 Hz accel + gravity, batched once a second, no gyro) and a 1-min ticker so the engine sees
 * activity/stillness all day. Night mode: fused location (~100 m / 60 s), screen/battery context,
 * duty-cycled audio, uploaders, and `engine.tick` every second with event dispatch.
 *
 * Sampling mode (CONTRACTS §6) is owned by the engine: `EngineEvent.SamplingRateChanged` flips
 * between LOW and FULL (50 Hz + gyroscope). Native additionally forces FULL during a baseline walk,
 * while opportunistic daytime gait learning is active (walking + learning enabled), and while the
 * personal dashboard is streaming (`SafetyRuntime.dashboardStreaming`) or the telemetry stream is on
 * (`SafetyRuntime.telemetryOn`, CONTRACTS §7); both also make the day ticker run every second so
 * `engine.metrics()` is fresh for each `dashboard` event / telemetry tick. Per-sample |a| and |ω| are kept in
 * small rings for the telemetry publisher ([drainTelemetrySamples]).
 */
class SensingService : Service(), SensorEventListener {
  companion object {
    private const val TAG = "SensingService"
    const val ACTION_START = "expo.modules.safetynative.START"
    const val ACTION_STOP = "expo.modules.safetynative.STOP"
    const val ACTION_SOS = "expo.modules.safetynative.SOS"
    const val ACTION_RECHECK = "expo.modules.safetynative.RECHECK"
    const val ACTION_GEOFENCE = "expo.modules.safetynative.GEOFENCE"
    const val ACTION_ACTIVITY = "expo.modules.safetynative.ACTIVITY"
    const val ACTION_BASELINE_WALK = "expo.modules.safetynative.BASELINE_WALK"
    const val EXTRA_ALLOW_MIC = "allowMic"
    const val EXTRA_AWAY = "away"
    const val EXTRA_ACTIVITY = "activity"
    const val EXTRA_ON = "on"
    const val GEOFENCE_REQUEST_CODE = 40
    const val ACTIVITY_REQUEST_CODE = 41
    /** FULL mode: 50 Hz accel + gravity + gyro. */
    private const val SENSOR_PERIOD_FULL_US = 20_000
    /** LOW mode: ~10 Hz accel + gravity, no gyro. */
    private const val SENSOR_PERIOD_LOW_US = 100_000
    /** Let the sensor hub batch for up to 1 s so the AP wakes at most once a second. */
    private const val SENSOR_BATCH_US = 1_000_000
    private const val G = 9.80665f
    private const val EARTH_RADIUS_M = 6_371_000.0
    /** Telemetry rings (CONTRACTS §7): samples kept between two publisher drains (4 Hz × 50 Hz = ~13; 64 covers a 1 Hz drain). */
    private const val TELEMETRY_RING_MAX = 64

    fun sendAction(ctx: Context, action: String, fill: (Intent) -> Unit = {}) {
      val i = Intent(ctx, SensingService::class.java).setAction(action); fill(i)
      try { ContextCompat.startForegroundService(ctx, i) } catch (e: Throwable) { Log.e(TAG, "start $action failed", e) }
    }

    /** Great-circle distance (haversine), metres. */
    fun haversineM(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
      val p1 = Math.toRadians(lat1); val p2 = Math.toRadians(lat2)
      val dp = p2 - p1; val dl = Math.toRadians(lng2 - lng1)
      val a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
      return 2 * EARTH_RADIUS_M * atan2(sqrt(a), sqrt(1 - a))
    }
  }

  private lateinit var rt: SafetyRuntime
  private lateinit var sensors: SensorManager
  private lateinit var audio: AudioMonitor
  private val fused by lazy { LocationServices.getFusedLocationProviderClient(this) }
  private val night = NightModeController()

  private var micAllowed = false
  private var foregroundStarted = false
  private var nightJob: Job? = null
  private var dayJob: Job? = null
  private var wakeLock: PowerManager.WakeLock? = null

  // motion
  private val gravity = floatArrayOf(0f, 0f, 1f)
  private var haveGravity = false
  private val rotation = floatArrayOf(0f, 0f, 0f) // latest gyro reading, rad/s; zeroed when the gyro is off
  private var batch = ArrayList<MotionSample>(60)
  private var lastFlushMs = 0L
  /** null = listeners off; false = LOW registered; true = FULL registered. */
  private var registeredFull: Boolean? = null
  /** What we are currently delivering (mirrored into Context.sampling_full). */
  @Volatile private var fullActive = false
  /** Telemetry rings: |a| (g) and |ω| (rad/s) per sample since the last [drainTelemetrySamples]; guarded by motionLock. */
  private val telemetryAccel = ArrayDeque<Float>(TELEMETRY_RING_MAX + 1)
  private val telemetryGyro = ArrayDeque<Float>(TELEMETRY_RING_MAX + 1)
  private val bootToWallMs get() = System.currentTimeMillis() - SystemClock.elapsedRealtime()

  // context
  @Volatile private var screenOn = true
  @Volatile private var activity = Activity.UNKNOWN

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    rt = SafetyRuntime.get(this)
    rt.sensing = this
    sensors = getSystemService(SENSOR_SERVICE) as SensorManager
    audio = AudioMonitor(this, rt)
    ensureForeground(night = false)
    ContextCompat.registerReceiver(
      this, screenReceiver,
      IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_USER_PRESENT) },
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    rt.touch.start()
    rt.serviceRunning = true
    rt.engine.startAutosave(rt.scope)
    registerGeofences()
    registerActivityTransitions()
    applySampling() // LOW mode from the start; the engine upgrades via SamplingRateChanged
    startDayTicker()
    rt.telemetry.start() // rate policy decides whether it actually publishes (CONTRACTS §7)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) { night.evaluate(); return START_STICKY } // restarted by the system (START_STICKY)
    when (intent.action) {
      ACTION_START -> {
        if (intent.getBooleanExtra(EXTRA_ALLOW_MIC, false)) { micAllowed = true; rt.alerts.cancelRearm() }
        registerGeofences()
        night.evaluate()
      }
      ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
      ACTION_SOS -> rt.sos.trigger()
      ACTION_RECHECK -> { registerGeofences(); registerActivityTransitions(); if (rt.nightActive) startLocation(); applySampling(); night.evaluate() }
      ACTION_GEOFENCE -> { rt.awayFromHome = intent.getBooleanExtra(EXTRA_AWAY, rt.awayFromHome); night.evaluate() }
      ACTION_ACTIVITY -> onActivity(intent.getIntExtra(EXTRA_ACTIVITY, DetectedActivity.UNKNOWN))
      ACTION_BASELINE_WALK -> applySampling() // rt.baselineWalkStartMs was set by the module before sending
    }
    rt.emitStatus()
    return START_STICKY
  }

  override fun onDestroy() {
    stopNightSession()
    dayJob?.cancel()
    rt.telemetry.stop()
    stopSensors()
    runCatching { unregisterReceiver(screenReceiver) }
    rt.engine.saveNow()
    rt.serviceRunning = false
    if (rt.sensing === this) rt.sensing = null
    rt.emitStatus()
    super.onDestroy()
  }

  // ---- foreground type handling ---------------------------------------------

  private var micGrantedToService = false

  /**
   * (Re)calls startForeground. Type mask: location when the permission is granted (Android 14+ throws
   * otherwise), microphone only in night mode when the user has opened the app since boot and granted
   * RECORD_AUDIO, specialUse as the pre-permission fallback.
   */
  private fun ensureForeground(night: Boolean) {
    val wantMic = night && micAllowed && PermissionHelper.microphone(this) && Build.VERSION.SDK_INT >= 30
    val hasLocation = PermissionHelper.granted(this, Manifest.permission.ACCESS_FINE_LOCATION) ||
      PermissionHelper.granted(this, Manifest.permission.ACCESS_COARSE_LOCATION)
    val notif = rt.alerts.serviceNotification(night)

    fun start(withMic: Boolean) {
      if (Build.VERSION.SDK_INT < 29) { startForeground(AlertManager.NOTIF_SERVICE, notif); return }
      var type = 0
      if (hasLocation) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
      if (withMic) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      if (type == 0) type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else ServiceInfo.FOREGROUND_SERVICE_TYPE_MANIFEST
      startForeground(AlertManager.NOTIF_SERVICE, notif, type)
    }

    try {
      start(wantMic)
      foregroundStarted = true
      micGrantedToService = wantMic || Build.VERSION.SDK_INT < 30
    } catch (e: Exception) {
      // Android 14+: the microphone type cannot be (re)started from the background, e.g. after a reboot.
      Log.w(TAG, "startForeground(mic=$wantMic) failed; falling back", e)
      micGrantedToService = false
      runCatching { start(false); foregroundStarted = true }.onFailure { Log.e(TAG, "startForeground fallback failed", it) }
      if (wantMic) rt.alerts.showRearm()
    }
  }

  // ---- night-mode controller ----------------------------------------------

  inner class NightModeController {
    private var pausedDay: String? = null

    private fun inWindow(): Boolean {
      val h = LocalTime.now().hour
      val s = rt.prefs.eveningStartHour; val e = rt.prefs.eveningEndHour
      return if (s <= e) h in s until e else (h >= s || h < e)
    }

    /** Called on every mode-relevant change; idempotent. */
    @Synchronized
    fun evaluate() {
      val setting = rt.prefs.nightModeSetting
      if (setting == "paused_tonight") {
        if (pausedDay == null) pausedDay = rt.escrow.today()
        if (!inWindow() && pausedDay != rt.escrow.today()) { rt.prefs.nightModeSetting = "auto"; pausedDay = null }
      }
      val (active, reason) = when (rt.prefs.nightModeSetting) {
        "on" -> true to "manual"
        "off" -> false to "off"
        "paused_tonight" -> false to "off"
        else -> {
          val a = rt.awayFromHome && inWindow() && rt.prefs.homePlaces.isNotEmpty()
          a to (if (a) "away_from_home" else if (inWindow()) "window" else "off")
        }
      }
      if (active == rt.nightActive) { rt.nightReason = reason; return }
      rt.nightReason = reason
      if (active) startNightSession() else stopNightSession()
      rt.emitStatus()
    }
  }

  private fun startNightSession() {
    Log.i(TAG, "night session start")
    rt.nightActive = true; rt.nightSince = rt.now()
    ensureForeground(night = true)
    wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "safe:night").apply { setReferenceCounted(false); acquire() }
    rt.engine.get().setNightMode(true, rt.now().toULong())
    applySampling()
    startLocation()
    if (micGrantedToService) audio.start()
    rt.scope.launch { rt.escrow.rotateIfNewDay() }
    rt.heartbeat.start(); rt.locationUploader.start(); rt.proximityUploader.start()
    rt.scope.launch { rt.heartbeat.sendNow() }

    nightJob = rt.scope.launch {
      var lastRotateCheck = 0L
      while (isActive) {
        val now = rt.now()
        runCatching {
          tickNow(now)
          val snap = rt.engine.get().snapshot()
          if (snap.riskBand.toInt() >= 1 || snap.hmmState != HmmState.NORMAL) audio.boost()
          if (now - lastRotateCheck > 60_000) { lastRotateCheck = now; rt.escrow.rotateIfNewDay() }
        }.onFailure { Log.e(TAG, "tick failed", it) }
        delay(1_000L - (rt.now() - now).coerceIn(0L, 900L))
      }
    }
  }

  private fun stopNightSession() {
    if (!rt.nightActive && nightJob == null) return
    Log.i(TAG, "night session stop")
    nightJob?.cancel(); nightJob = null
    rt.nightActive = false; rt.nightSince = null
    runCatching { rt.engine.get().setNightMode(false, rt.now().toULong()) }
    rt.heartbeat.stop(); rt.locationUploader.stop(); rt.proximityUploader.stop()
    audio.stop()
    stopLocation()
    applySampling() // back to LOW unless the engine / a baseline walk still wants FULL
    wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
    rt.scope.launch { rt.heartbeat.sendNow() }
    rt.engine.saveNow() // baseline + incident log
    ensureForeground(night = false)
  }

  /**
   * Low-power loop outside night sessions: re-evaluate the window and feed the engine context + tick.
   * Once a minute in LOW mode; every second while FULL sampling is active (engine request after an
   * incident, dashboard streaming or the telemetry stream) so grab/impact logic keeps running at the same
   * cadence as at night and the dashboard / telemetry get a fresh `metrics()` each second. Restarted (ticks
   * immediately) when a streaming flag flips, so a pending 60 s delay does not hold the first fresh frame back.
   */
  @Synchronized
  private fun startDayTicker() {
    dayJob?.cancel()
    dayJob = rt.scope.launch {
      var lastPassiveFix = 0L
      while (isActive) {
        runCatching {
          night.evaluate()
          if (!rt.nightActive) {
            val now = rt.now()
            if (now - lastPassiveFix >= 60_000L) { lastPassiveFix = now; refreshPassiveLocation() }
            tickNow(now)
          }
        }.onFailure { Log.e(TAG, "day tick failed", it) }
        delay(if (!rt.nightActive && (fullActive || rt.dashboardStreamingOn || rt.telemetryOn)) 1_000L else 60_000L)
      }
    }
  }

  /**
   * One full tick: keyguard poll, Context push (so `samplingFull`, `lastTouchMs`, activity... are current),
   * then `engine.tick` via [SafetyRuntime.runTick], which dispatches events and emits `dashboard` while streaming.
   * Shared by the day ticker, the night loop and `getDashboard` (through [SafetyRuntime.freshDashboardMap]).
   */
  fun tickNow(now: Long = rt.now(), emitDashboard: Boolean = true) {
    rt.touch.poll(now)
    pushContext(now)
    rt.runTick(now, emitDashboard)
  }

  /** Dashboard-streaming / telemetry flag flipped: re-register sensors for the new effective mode and re-arm the day ticker cadence. */
  fun onStreamingChanged() {
    applySampling()
    startDayTicker()
  }

  /**
   * Hands the per-sample magnitudes collected since the previous call to the telemetry publisher (newest last, ≤ 64
   * each; `gyro` is all zeros in LOW mode) and clears the rings. `sampleHz` is the nominal rate of the registered mode.
   */
  fun drainTelemetrySamples(): RawSamples = synchronized(motionLock) {
    val a = FloatArray(telemetryAccel.size) { telemetryAccel[it] }
    val g = FloatArray(telemetryGyro.size) { telemetryGyro[it] }
    telemetryAccel.clear(); telemetryGyro.clear()
    RawSamples(a, g, if (registeredFull == null) 0 else if (fullActive) 50 else 10)
  }

  private fun pushContext(now: Long) {
    val speed = rt.lastLocation?.takeIf { it.hasSpeed() && now - it.time < 120_000 }?.speed ?: -1f
    rt.engine.get().pushContext(
      EngineContext(
        tMs = now.toULong(), awayFromHome = rt.awayFromHome, separated = rt.separated,
        hourLocal = LocalTime.now().hour.toUByte(), screenOn = screenOn, activity = activity,
        batteryPct = rt.batteryPct().toUByte(), speedMps = speed,
        lastTouchMs = rt.touch.lastTouchMs.coerceAtLeast(0L).toULong(),
        distanceHomeM = distanceHomeM(),
        samplingFull = fullActive,
      ),
    )
  }

  /** Haversine distance from the last fix to the nearest saved home place; -1 when either is unknown. */
  private fun distanceHomeM(): Float {
    val loc = rt.lastLocation ?: return -1f
    val homes = rt.prefs.homePlaces
    if (homes.isEmpty()) return -1f
    return homes.minOf { h -> haversineM(loc.latitude, loc.longitude, h.lat, h.lng) }.toFloat()
  }

  // ---- motion --------------------------------------------------------------

  /** FULL when the engine asked for it, the dashboard or telemetry streams, during a baseline walk, or while learning gait on a daytime walk. */
  private fun effectiveFull(): Boolean =
    rt.samplingFull || rt.dashboardStreamingOn || rt.telemetryOn || rt.baselineWalkStartMs != 0L || (activity == Activity.WALKING && rt.prefs.learningEnabled)

  /**
   * (Re)registers the motion listeners for the current effective mode. Idempotent; safe from any thread
   * (SensorManager delivers to the main looper when no Handler is given). Called from onCreate, the
   * engine's SamplingRateChanged, activity transitions, baseline-walk start/stop, night start/stop and
   * dashboard streaming / telemetry on/off.
   */
  @Synchronized
  fun applySampling() {
    val wantFull = effectiveFull()
    if (registeredFull == wantFull) return
    val lin = sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    val grav = sensors.getDefaultSensor(Sensor.TYPE_GRAVITY)
    if (lin == null || grav == null) { Log.w(TAG, "linear accel / gravity sensors missing"); return }
    if (registeredFull != null) { sensors.unregisterListener(this); flushMotion() }
    val period = if (wantFull) SENSOR_PERIOD_FULL_US else SENSOR_PERIOD_LOW_US
    sensors.registerListener(this, grav, period, SENSOR_BATCH_US)
    sensors.registerListener(this, lin, period, SENSOR_BATCH_US)
    if (wantFull) {
      val gyro = sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
      if (gyro != null) sensors.registerListener(this, gyro, period, SENSOR_BATCH_US) else Log.w(TAG, "gyroscope missing; rx/ry/rz stay 0")
    }
    if (!wantFull) synchronized(motionLock) { rotation.fill(0f) }
    fullActive = wantFull
    registeredFull = wantFull
    Log.i(TAG, "sampling ${if (wantFull) "FULL (50 Hz + gyro)" else "LOW (10 Hz, no gyro)"}")
  }

  @Synchronized
  private fun stopSensors() {
    if (registeredFull == null) return
    sensors.unregisterListener(this)
    registeredFull = null
    fullActive = false
    synchronized(motionLock) { rotation.fill(0f) }
    flushMotion()
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  override fun onSensorChanged(e: SensorEvent) {
    when (e.sensor.type) {
      Sensor.TYPE_GRAVITY -> {
        val n = sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]).takeIf { it > 1e-3f } ?: return
        gravity[0] = e.values[0] / n; gravity[1] = e.values[1] / n; gravity[2] = e.values[2] / n; haveGravity = true
      }
      Sensor.TYPE_GYROSCOPE -> synchronized(motionLock) {
        if (fullActive) { rotation[0] = e.values[0]; rotation[1] = e.values[1]; rotation[2] = e.values[2] }
      }
      Sensor.TYPE_LINEAR_ACCELERATION -> {
        if (!haveGravity) return
        val tMs = e.timestamp / 1_000_000L + bootToWallMs
        val ax = e.values[0] / G; val ay = e.values[1] / G; val az = e.values[2] / G
        val full = synchronized(motionLock) {
          val gyroOn = fullActive
          val rx = if (gyroOn) rotation[0] else 0f; val ry = if (gyroOn) rotation[1] else 0f; val rz = if (gyroOn) rotation[2] else 0f
          batch.add(
            MotionSample(
              tMs = tMs.toULong(),
              ax = ax, ay = ay, az = az,
              gx = gravity[0], gy = gravity[1], gz = gravity[2],
              rx = rx, ry = ry, rz = rz,
            ),
          )
          // Telemetry rings (CONTRACTS §7 accel/gyro): magnitudes only, drained by TelemetryPublisher at its own cadence.
          telemetryAccel.addLast(sqrt(ax * ax + ay * ay + az * az)); if (telemetryAccel.size > TELEMETRY_RING_MAX) telemetryAccel.removeFirst()
          telemetryGyro.addLast(sqrt(rx * rx + ry * ry + rz * rz)); if (telemetryGyro.size > TELEMETRY_RING_MAX) telemetryGyro.removeFirst()
          batch.size >= 50 || tMs - lastFlushMs >= 1000
        }
        if (full) flushMotion()
      }
    }
  }

  private val motionLock = Any()

  private fun flushMotion() {
    val out = synchronized(motionLock) {
      if (batch.isEmpty()) return
      val o = batch; batch = ArrayList(60); lastFlushMs = o.last().tMs.toLong(); o
    }
    runCatching { rt.engine.get().pushMotion(out) }.onFailure { Log.e(TAG, "pushMotion failed", it) }
  }

  // ---- location ------------------------------------------------------------

  private val locationCallback = object : LocationCallback() {
    override fun onLocationResult(r: LocationResult) {
      r.lastLocation?.let { loc ->
        rt.lastLocation = loc
        rt.awayFromHome = !rt.prefs.homePlaces.any { h -> distanceM(loc.latitude, loc.longitude, h.lat, h.lng) <= h.radiusM + 50 }
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun startLocation() {
    if (!PermissionHelper.granted(this, Manifest.permission.ACCESS_FINE_LOCATION)) return
    val req = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 60_000L)
      .setMinUpdateDistanceMeters(100f).setMinUpdateIntervalMillis(30_000L).setWaitForAccurateLocation(false).build()
    fused.requestLocationUpdates(req, locationCallback, Looper.getMainLooper())
    fused.lastLocation.addOnSuccessListener { it?.let { l -> locationCallback.onLocationResult(LocationResult.create(listOf(l))) } }
  }

  private fun stopLocation() { fused.removeLocationUpdates(locationCallback) }

  /** Day mode: no active location requests; just pick up whatever fix another app produced (free). */
  @SuppressLint("MissingPermission")
  private fun refreshPassiveLocation() {
    if (!PermissionHelper.granted(this, Manifest.permission.ACCESS_FINE_LOCATION)) return
    runCatching {
      fused.lastLocation.addOnSuccessListener { l ->
        if (l != null && (rt.lastLocation == null || l.time > (rt.lastLocation?.time ?: 0L))) rt.lastLocation = l
      }
    }
  }

  @SuppressLint("MissingPermission")
  fun registerGeofences() {
    if (!PermissionHelper.granted(this, Manifest.permission.ACCESS_FINE_LOCATION)) return
    val client = LocationServices.getGeofencingClient(this)
    val pi = PendingIntent.getBroadcast(
      this, GEOFENCE_REQUEST_CODE, Intent(this, GeofenceReceiver::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0),
    )
    client.removeGeofences(pi)
    val homes = rt.prefs.homePlaces
    if (homes.isEmpty()) { rt.awayFromHome = false; return }
    val fences = homes.map {
      Geofence.Builder().setRequestId(it.id).setCircularRegion(it.lat, it.lng, it.radiusM.toFloat().coerceAtLeast(100f))
        .setExpirationDuration(Geofence.NEVER_EXPIRE).setLoiteringDelay(60_000)
        .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT).build()
    }
    val req = GeofencingRequest.Builder().setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER or GeofencingRequest.INITIAL_TRIGGER_EXIT)
      .addGeofences(fences).build()
    client.addGeofences(req, pi).addOnFailureListener { Log.w(TAG, "addGeofences failed", it) }
    // Seed awayFromHome from the last fix so auto mode has an answer before the first transition.
    fused.lastLocation.addOnSuccessListener { l ->
      if (l != null) {
        if (rt.lastLocation == null) rt.lastLocation = l
        rt.awayFromHome = !homes.any { h -> distanceM(l.latitude, l.longitude, h.lat, h.lng) <= h.radiusM + 50 }; night.evaluate()
      }
    }
  }

  @SuppressLint("MissingPermission")
  private fun registerActivityTransitions() {
    if (!PermissionHelper.motion(this)) return
    val types = listOf(DetectedActivity.WALKING, DetectedActivity.RUNNING, DetectedActivity.STILL, DetectedActivity.IN_VEHICLE)
    val transitions = types.flatMap { t ->
      listOf(ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransition.ACTIVITY_TRANSITION_EXIT).map { tr ->
        ActivityTransition.Builder().setActivityType(t).setActivityTransition(tr).build()
      }
    }
    val pi = PendingIntent.getBroadcast(
      this, ACTIVITY_REQUEST_CODE, Intent(this, ActivityTransitionReceiver::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0),
    )
    ActivityRecognition.getClient(this).requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pi)
      .addOnFailureListener { Log.w(TAG, "activity transitions failed", it) }
  }

  private fun onActivity(detected: Int) {
    activity = when (detected) {
      DetectedActivity.STILL -> Activity.STATIONARY
      DetectedActivity.WALKING, DetectedActivity.ON_FOOT -> Activity.WALKING
      DetectedActivity.RUNNING -> Activity.RUNNING
      DetectedActivity.IN_VEHICLE, DetectedActivity.ON_BICYCLE -> Activity.VEHICLE
      else -> Activity.UNKNOWN
    }
    // Opportunistic daytime baseline learning: gait needs FULL rate while walking (effectiveFull covers it).
    applySampling()
  }

  // ---- screen / unlock -----------------------------------------------------

  // Screen state for Context.screen_on only; unlock/touch bookkeeping lives in TouchTracker.
  private val screenReceiver = object : BroadcastReceiver() {
    override fun onReceive(c: Context?, i: Intent) {
      when (i.action) {
        Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> screenOn = true
        Intent.ACTION_SCREEN_OFF -> screenOn = false
      }
    }
  }

  private fun distanceM(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
    val out = FloatArray(1); android.location.Location.distanceBetween(lat1, lng1, lat2, lng2, out); return out[0].toDouble()
  }
}
