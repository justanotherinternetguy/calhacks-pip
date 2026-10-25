package expo.modules.safetynative

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.fragment.app.FragmentActivity
import expo.modules.interfaces.permissions.PermissionsResponse
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import uniffi.safety.EscalationLevel
import uniffi.safety.TypingSample
import uniffi.safety.UserAction

class ConfigureOptions : Record {
  @Field val supabaseUrl: String = ""
  @Field val supabaseAnonKey: String = ""
  @Field val accessToken: String = ""
  /** Optional: lets native refresh the JWT itself while JS sleeps (SessionKeeper). */
  @Field val refreshToken: String = ""
  @Field val userId: String = ""
  @Field val deviceId: String = ""
  @Field val modelConfigToml: String = ""
}

class SessionRecord : Record {
  @Field val accessToken: String = ""
  @Field val refreshToken: String = ""
}

class HomePlaceRecord : Record {
  @Field val id: String = ""
  @Field val label: String = ""
  @Field val lat: Double = 0.0
  @Field val lng: Double = 0.0
  @Field val radiusM: Double = 150.0
}

class TypingRecord : Record {
  @Field val phrase: String = ""
  @Field val typed: String = ""
  @Field val keyTimesMs: List<Double> = emptyList()
  @Field val backspaces: Int = 0
  @Field val durationMs: Double = 0.0

  fun toSample() = TypingSample(phrase, typed, keyTimesMs.map { it.toLong().toULong() }, backspaces.toUInt(), durationMs.toLong().toULong())
}

class GroupMemberRecord : Record {
  @Field val userId: String = ""
  @Field val deviceId: String = ""
  @Field val x25519Pub: String = ""
  @Field val ed25519Pub: String = ""
}

class GroupRecord : Record {
  @Field val groupId: String = ""
  @Field val thresholdK: Int = 2
  @Field val members: List<GroupMemberRecord> = emptyList()
}

/**
 * JS facade (CONTRACTS §2, §6 dashboard, §7 telemetry). Thin: every method forwards to SafetyRuntime, which outlives the JS runtime.
 */
class SafetyNativeModule : Module() {
  private val rt: SafetyRuntime get() = SafetyRuntime.get(requireNotNull(appContext.reactContext) { "no react context" })

  override fun definition() = ModuleDefinition {
    Name("SafetyNative")
    Events("statusChanged", "checkRequested", "escalation", "snatch", "sos", "dashboard", "signalIncident", "incidentCleared", "incidentLogCleared", "callOption", "sessionRefreshed")

    OnCreate {
      runCatching {
        rt.sink = object : RuntimeEventSink {
          override fun emit(name: String, payload: Map<String, Any?>) { this@SafetyNativeModule.sendEvent(name, payload) }
        }
        appContext.currentActivity?.let { rt.touch.attach(it) }
      }
    }
    // The activity may be recreated while the module lives on; re-hook the window callback each time it comes to the front.
    OnActivityEntersForeground {
      runCatching {
        appContext.currentActivity?.let { rt.touch.attach(it) }
        rt.touch.touched()   // bringing the app forward is an interaction in itself
      }
    }
    OnDestroy {
      SafetyRuntime.peek()?.let { it.sink = null; it.setDashboardStreaming(false) }
    }

    // ---- setup -----------------------------------------------------------

    AsyncFunction("configure") { opts: ConfigureOptions ->
      val r = rt
      r.prefs.serverConfig = ServerConfig(opts.supabaseUrl, opts.supabaseAnonKey, opts.accessToken, opts.userId, opts.deviceId, opts.refreshToken.ifBlank { null })
      r.supabase.setAccessToken(opts.accessToken)
      if (opts.modelConfigToml.isNotBlank()) r.engine.setConfigToml(opts.modelConfigToml) else r.engine.get()
      r.onConfigured()   // telemetry stream (CONTRACTS §7) defaults to ON from here
      r.scope.launch { r.escrow.publishKeys() }
      // The app is visible here, so the service may take the microphone type later tonight.
      r.startService(allowMic = true)
    }

    // ---- session (JS ↔ native; native refreshes on its own, see SessionKeeper) ----
    AsyncFunction("setAccessToken") { token: String -> rt.applySession(token, null, fromJs = true) }
    AsyncFunction("setSession") { s: SessionRecord -> rt.applySession(s.accessToken, s.refreshToken.ifBlank { null }, fromJs = true) }
    AsyncFunction("getSession") { rt.sessionMap() }
    AsyncFunction("clearSession") { rt.clearSession() }

    AsyncFunction("requestPermission") perm@{ kind: String, promise: Promise ->
      val ctx = rt.app
      val perms: Array<String> = when (kind) {
        "locationAlways" ->
          if (Build.VERSION.SDK_INT >= 29 && PermissionHelper.granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION)) arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
          else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        "motion" -> if (Build.VERSION.SDK_INT >= 29) arrayOf(Manifest.permission.ACTIVITY_RECOGNITION) else emptyArray()
        "microphone" -> arrayOf(Manifest.permission.RECORD_AUDIO)
        "notifications" -> if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray()
        "batteryUnrestricted" -> {
          if (!PermissionHelper.batteryUnrestricted(ctx)) {
            val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}"))
            val act = appContext.currentActivity
            if (act != null) act.startActivity(i) else ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          }
          promise.resolve(if (PermissionHelper.batteryUnrestricted(ctx)) "granted" else "undetermined"); return@perm
        }
        else -> { promise.reject("E_KIND", "unknown permission kind $kind", null); return@perm }
      }
      if (perms.isEmpty()) { promise.resolve("granted"); return@perm }
      val pm = appContext.permissions ?: run { promise.resolve(PermissionHelper.current(ctx)[kind] ?: "denied"); return@perm }
      pm.askForPermissions({ result: Map<String, PermissionsResponse> ->
        val statuses = result.values.map { it.status }
        val state = when {
          statuses.all { it == PermissionsStatus.GRANTED } -> "granted"
          statuses.any { it == PermissionsStatus.DENIED } -> "denied"
          else -> "undetermined"
        }
        rt.emitStatus()
        SensingService.sendAction(ctx, SensingService.ACTION_RECHECK)
        promise.resolve(state)
      }, *perms)
    }

    AsyncFunction("setHomePlaces") { places: List<HomePlaceRecord> ->
      rt.prefs.homePlaces = places.map { HomePlace(it.id, it.label, it.lat, it.lng, it.radiusM) }
      SensingService.sendAction(rt.app, SensingService.ACTION_RECHECK)
    }

    AsyncFunction("setEveningWindow") { startHour: Int, endHour: Int ->
      rt.prefs.eveningStartHour = startHour.coerceIn(0, 23); rt.prefs.eveningEndHour = endHour.coerceIn(0, 24)
      SensingService.sendAction(rt.app, SensingService.ACTION_RECHECK)
    }

    AsyncFunction("setNightMode") { mode: String ->
      require(mode in setOf("auto", "on", "off", "paused_tonight")) { "bad mode $mode" }
      rt.prefs.nightModeSetting = mode
      SensingService.sendAction(rt.app, SensingService.ACTION_RECHECK)
    }

    AsyncFunction("getStatus") { rt.statusMap() }

    // ---- dashboard (CONTRACTS §6) --------------------------------------------

    AsyncFunction("getDashboard") { rt.freshDashboardMap() }   // ticks first if the last tick is > 1 s old
    AsyncFunction("setDashboardStreaming") { on: Boolean -> rt.setDashboardStreaming(on) }
    AsyncFunction("resetIncidents") { rt.resetIncidents() }

    // ---- telemetry stream (CONTRACTS §7) ----------------------------------------

    AsyncFunction("setTelemetry") { on: Boolean -> rt.setTelemetry(on) }
    AsyncFunction("getTelemetryStatus") { rt.telemetry.statusMap() }   // { on, hz, lastSentMs, failures, connected, reconnects, dropped, rttMs, error }

    // ---- demo sensitivity (Settings): live engine on assets/model-demo.toml, normal model kept on disk ----
    AsyncFunction("setDemoSensitivity") { on: Boolean -> rt.engine.setDemoSensitivity(on) }
    AsyncFunction("getDemoSensitivity") { rt.prefs.demoSensitivity }

    // ---- data collection (Settings → Allow data collection; sessions are started from a /collect page) ----
    AsyncFunction("setCollectAllowed") { on: Boolean -> rt.setCollectAllowed(on) }
    AsyncFunction("getCollect") { rt.collectMap() }   // { allowed, on, startedMs, untilMs, label, demo }
    AsyncFunction("stopCollect") { rt.stopCollect("stopped in the app") }

    // ---- check-in / SOS ------------------------------------------------------

    AsyncFunction("submitCheckIn") { r: TypingRecord -> rt.submitCheckIn(r.toSample()) }
    // The one check-in UI (fingerprint / PIN, then the phrase) is native: JS only opens it.
    AsyncFunction("openCheckIn") { rt.app.startActivity(CheckInActivity.intent(rt.app)) }
    AsyncFunction("needHelp") { rt.needHelp() }
    AsyncFunction("triggerSos") { rt.sos.trigger() }
    AsyncFunction("cancelSos") Coroutine { -> rt.sos.cancel(appContext.currentActivity as? FragmentActivity) }

    // ---- baselines -----------------------------------------------------------

    AsyncFunction("startBaselineWalk") {
      rt.baselineWalkStartMs = rt.now()
      rt.engine.get().setLearning(true)
      SensingService.sendAction(rt.app, SensingService.ACTION_BASELINE_WALK) { it.putExtra(SensingService.EXTRA_ON, true) }
    }
    AsyncFunction("stopBaselineWalk") {
      val start = rt.baselineWalkStartMs
      rt.baselineWalkStartMs = 0L
      rt.engine.get().setLearning(rt.prefs.learningEnabled)
      rt.engine.saveNow()
      SensingService.sendAction(rt.app, SensingService.ACTION_BASELINE_WALK) { it.putExtra(SensingService.EXTRA_ON, false) }
      mapOf("seconds" to if (start == 0L) 0L else (rt.now() - start) / 1000)
    }
    AsyncFunction("recordTypingPractice") { r: TypingRecord ->
      // Practice samples feed the typing baseline; the verdict is ignored.
      rt.engine.get().pushTyping(r.toSample(), rt.now().toULong())
      rt.engine.saveNow()
    }

    // ---- escrow (subject side) -----------------------------------------------

    AsyncFunction("getIdentity") { rt.escrow.identityMap() }
    AsyncFunction("setGroup") Coroutine { g: GroupRecord ->
      val members = JSONArray().also { arr ->
        g.members.forEach {
          arr.put(JSONObject().put("userId", it.userId).put("deviceId", it.deviceId).put("x25519Pub", it.x25519Pub).put("ed25519Pub", it.ed25519Pub))
        }
      }
      rt.escrow.setGroup(g.groupId, g.thresholdK, members)
    }

    // ---- escrow (friend side) ------------------------------------------------

    AsyncFunction("openReleasedKey") { r: Map<String, Any?> ->
      rt.escrow.openReleasedKey(
        r["subjectUserId"] as String, r["epochId"] as String, (r["hourIndex"] as Number).toInt(),
        r["sealedB64"] as String, r["senderEd25519Pub"] as String,
      )
    }
    AsyncFunction("decryptLocations") { subjectUserId: String, blobs: List<Map<String, Any?>> ->
      val arr = JSONArray().also { a -> blobs.forEach { a.put(JSONObject(it)) } }
      rt.escrow.decryptLocations(subjectUserId, arr)
    }
    AsyncFunction("approveUnlock") Coroutine { r: Map<String, Any?> ->
      val sealed = rt.escrow.approveUnlock(r["requestId"] as String, r["subjectUserId"] as String, r["epochId"] as String, r["requesterX25519Pub"] as String)
      mapOf("sealedShareB64" to sealed)
    }
    AsyncFunction("recoverFromShares") { r: Map<String, Any?> ->
      @Suppress("UNCHECKED_CAST")
      val shares = JSONArray().also { a -> (r["sealedShares"] as List<Map<String, Any?>>).forEach { a.put(JSONObject(it)) } }
      mapOf("ok" to rt.escrow.recoverFromShares(r["subjectUserId"] as String, r["epochId"] as String, shares))
    }

    // ---- alarm / debug -------------------------------------------------------

    AsyncFunction("ringAlarm") { seconds: Int -> rt.alerts.ringAlarm(seconds) }
    AsyncFunction("stopAlarm") { rt.alerts.stopAlarm() }
    AsyncFunction("injectTrace") { json: String ->
      require(rt.isDebuggable) { "injectTrace is only available in debug builds" }
      TraceInjector(rt).replay(json)
    }

    // ---- native typing view ---------------------------------------------------

    View(SafetyNativeTypingView::class) {
      Events("onKey", "onSubmit")
      Prop("phrase") { view: SafetyNativeTypingView, phrase: String -> view.setPhrase(phrase) }
    }
  }
}

// Check-in helpers shared by the module, CheckInActivity and the notification action.

/**
 * A typed check-in answer. Owner proof first: unless the device has no secure lock screen, the answer counts only
 * within [SafetyRuntime.ownerVerified] (a fingerprint / PIN passed in [CheckInActivity]); otherwise it is refused
 * before the engine sees it. The engine decides the rest in `push_typing` (accepted → DismissOk, wrong phrase →
 * retry, typing far off the owner's rhythm → TypingOff + heads-up); this only ticks so its events go out now.
 */
fun SafetyRuntime.submitCheckIn(sample: TypingSample): Map<String, Any?> {
  val secure = deviceSecure()
  if (secure && !ownerVerified()) {
    android.util.Log.w("SafetyRuntime", "check-in answer refused: owner not verified")
    return mapOf("accepted" to false, "zScore" to 0.0, "reason" to "Confirm it's you first (fingerprint or PIN)")
  }
  val verdict = engine.get().pushTyping(sample, now().toULong())
  val dismissed = verdict.accepted && escalationLevel().let { it == EscalationLevel.RESOLVED || it == EscalationLevel.IDLE }
  scope.launch { runTick() }
  if (dismissed) {
    alerts.cancelCheckIn(); alerts.cancelEscalated(); AlarmReceiver.cancelCheckTimeout(app)
    logCheckAnswered(verified = secure)   // no-op before friends were involved (no incident row yet)
    clearOwnerVerified()
  }
  engine.saveNow()
  return mapOf("accepted" to dismissed, "zScore" to verdict.zScore.toDouble(), "reason" to verdict.reason)
}

/** Owner confirmed with fingerprint / PIN while friends already hold the location or a grab is running: dismiss. */
fun SafetyRuntime.biometricDismiss() {
  logCheckAnswered(verified = true)
  pushAction(UserAction.BIOMETRIC_DISMISS)
  alerts.cancelCheckIn(); alerts.cancelEscalated(); AlarmReceiver.cancelCheckTimeout(app)
  clearOwnerVerified()
}

fun SafetyRuntime.needHelp() {
  alerts.cancelCheckIn(); AlarmReceiver.cancelCheckTimeout(app)
  if (collecting) { android.util.Log.i("SafetyRuntime", "need help ignored: data collection is running"); return }
  pushAction(UserAction.NEED_HELP)
}
