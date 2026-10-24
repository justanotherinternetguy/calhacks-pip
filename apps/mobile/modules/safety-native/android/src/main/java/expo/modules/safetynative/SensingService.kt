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
import kotlin.math.sqrt

/**
 * Persistent foreground service. Day mode: geofence + activity transitions + a 1-min ticker.
 * Night mode: fused location (~100 m / 60 s), 50 Hz motion, screen/battery context, duty-cycled
 * audio, uploaders, and `engine.tick` every second with event dispatch.
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
    private const val SENSOR_PERIOD_US = 20_000 // 50 Hz
    private const val G = 9.80665f

    fun sendAction(ctx: Context, action: String, fill: (Intent) -> Unit = {}) {
      val i = Intent(ctx, SensingService::class.java).setAction(action); fill(i)
      try { ContextCompat.startForegroundService(ctx, i) } catch (e: Throwable) { Log.e(TAG, "start $action failed", e) }
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
  private var batch = ArrayList<MotionSample>(60)
  private var lastFlushMs = 0L
  private var sensorsOn = false
  private val bootToWallMs get() = System.currentTimeMillis() - SystemClock.elapsedRealtime()

  // context
  @Volatile private var screenOn = true
  @Volatile private var activity = Activity.UNKNOWN

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    rt = SafetyRuntime.get(this)
    sensors = getSystemService(SENSOR_SERVICE) as SensorManager
    audio = AudioMonitor(this, rt)
    ensureForeground(night = false)
    ContextCompat.registerReceiver(
      this, screenReceiver,
      IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_USER_PRESENT) },
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    rt.serviceRunning = true
    rt.engine.startAutosave(rt.scope)
    registerGeofences()
    registerActivityTransitions()
    startDayTicker()
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
      ACTION_RECHECK -> { registerGeofences(); registerActivityTransitions(); if (rt.nightActive) startLocation(); night.evaluate() }
      ACTION_GEOFENCE -> { rt.awayFromHome = intent.getBooleanExtra(EXTRA_AWAY, rt.awayFromHome); night.evaluate() }
      ACTION_ACTIVITY -> onActivity(intent.getIntExtra(EXTRA_ACTIVITY, DetectedActivity.UNKNOWN))
      ACTION_BASELINE_WALK -> if (intent.getBooleanExtra(EXTRA_ON, false)) startSensors() else if (!rt.nightActive) stopSensors()
    }
    rt.emitStatus()
    return START_STICKY
  }

  override fun onDestroy() {
    stopNightSession()
    dayJob?.cancel()
    runCatching { unregisterReceiver(screenReceiver) }
    rt.engine.saveNow()
    rt.serviceRunning = false
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
    startSensors()
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
          pushContext(now)
          val engine = rt.engine.get()
          rt.dispatch(engine.tick(now.toULong()))
          val snap = engine.snapshot()
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
    if (rt.baselineWalkStartMs == 0L) stopSensors()
    wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null
    rt.scope.launch { rt.heartbeat.sendNow() }
    rt.engine.saveNow()
    ensureForeground(night = false)
  }

  /** Low-power loop: once a minute re-evaluate the window and keep the engine's clock moving. */
  private fun startDayTicker() {
    dayJob?.cancel()
    dayJob = rt.scope.launch {
      while (isActive) {
        runCatching {
          night.evaluate()
          if (!rt.nightActive) { pushContext(rt.now()); rt.dispatch(rt.engine.get().tick(rt.now().toULong())) }
        }.onFailure { Log.e(TAG, "day tick failed", it) }
        delay(60_000L)
      }
    }
  }

  private fun pushContext(now: Long) {
    val speed = rt.lastLocation?.takeIf { it.hasSpeed() && now - it.time < 120_000 }?.speed ?: -1f
    rt.engine.get().pushContext(
      EngineContext(
        tMs = now.toULong(), awayFromHome = rt.awayFromHome, separated = rt.separated,
        hourLocal = LocalTime.now().hour.toUByte(), screenOn = screenOn, activity = activity,
        batteryPct = rt.batteryPct().toUByte(), speedMps = speed,
      ),
    )
  }

  // ---- motion --------------------------------------------------------------

  private fun startSensors() {
    if (sensorsOn) return
    val lin = sensors.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    val grav = sensors.getDefaultSensor(Sensor.TYPE_GRAVITY)
    if (lin == null || grav == null) { Log.w(TAG, "linear accel / gravity sensors missing"); return }
    sensors.registerListener(this, grav, SENSOR_PERIOD_US, 200_000)
    sensors.registerListener(this, lin, SENSOR_PERIOD_US, 1_000_000) // batch up to 1 s
    sensorsOn = true
  }

  private fun stopSensors() {
    if (!sensorsOn) return
    sensors.unregisterListener(this); sensorsOn = false
    flushMotion()
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  override fun onSensorChanged(e: SensorEvent) {
    when (e.sensor.type) {
      Sensor.TYPE_GRAVITY -> {
        val n = sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]).takeIf { it > 1e-3f } ?: return
        gravity[0] = e.values[0] / n; gravity[1] = e.values[1] / n; gravity[2] = e.values[2] / n; haveGravity = true
      }
      Sensor.TYPE_LINEAR_ACCELERATION -> {
        if (!haveGravity) return
        val tMs = e.timestamp / 1_000_000L + bootToWallMs
        val full = synchronized(motionLock) {
          batch.add(MotionSample(tMs.toULong(), e.values[0] / G, e.values[1] / G, e.values[2] / G, gravity[0], gravity[1], gravity[2]))
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
      if (l != null) { rt.awayFromHome = !homes.any { h -> distanceM(l.latitude, l.longitude, h.lat, h.lng) <= h.radiusM + 50 }; night.evaluate() }
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
    // Opportunistic daytime baseline learning: sample gait only while walking.
    if (!rt.nightActive && rt.baselineWalkStartMs == 0L) {
      if (activity == Activity.WALKING && rt.prefs.learningEnabled) startSensors() else stopSensors()
    }
  }

  // ---- screen / unlock -----------------------------------------------------

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
