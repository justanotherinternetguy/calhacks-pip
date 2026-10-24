package expo.modules.safetynative

import android.util.Log
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import uniffi.safety.Activity
import uniffi.safety.AudioScores
import uniffi.safety.Context
import uniffi.safety.MotionSample

/**
 * Debug-only replay of a recorded trace through the real engine:
 * `{ "speed": 10, "motion": [{tMs,ax,ay,az,gx,gy,gz,rx?,ry?,rz?}], "context": [{tMs,awayFromHome,separated,hourLocal,screenOn,activity,batteryPct,speedMps,lastTouchMs?,distanceHomeM?,samplingFull?}], "audio": [{tMs,scream,shout,glass}] }`
 * (rx/ry/rz default to 0 = no gyro; lastTouchMs 0 = unknown; distanceHomeM -1 = unknown; samplingFull defaults to true.)
 * Timestamps are re-based to "now"; `speed` > 1 replays faster than wall clock. Events are dispatched
 * exactly like live ones (notifications, uploads), so use a test backend.
 */
class TraceInjector(private val rt: SafetyRuntime) {
  fun replay(json: String) {
    val root = JSONObject(json)
    val speed = root.optDouble("speed", 1.0).coerceAtLeast(0.01)
    val motion = root.optJSONArray("motion") ?: org.json.JSONArray()
    val context = root.optJSONArray("context") ?: org.json.JSONArray()
    val audio = root.optJSONArray("audio") ?: org.json.JSONArray()

    fun firstT(arr: org.json.JSONArray) = if (arr.length() == 0) Long.MAX_VALUE else arr.getJSONObject(0).getLong("tMs")
    val t0 = minOf(firstT(motion), firstT(context), firstT(audio)).takeIf { it != Long.MAX_VALUE } ?: return
    val base = rt.now()

    rt.scope.launch {
      val engine = rt.engine.get()
      engine.setNightMode(true, base.toULong())
      var mi = 0; var ci = 0; var ai = 0
      var simNow = base
      val end = base + maxOf(lastT(motion), lastT(context), lastT(audio)) - t0 + 1000
      while (simNow <= end) {
        val batch = ArrayList<MotionSample>()
        while (mi < motion.length() && motion.getJSONObject(mi).getLong("tMs") - t0 + base <= simNow) {
          val m = motion.getJSONObject(mi++)
          batch.add(
            MotionSample(
              tMs = (m.getLong("tMs") - t0 + base).toULong(),
              ax = m.getDouble("ax").toFloat(), ay = m.getDouble("ay").toFloat(), az = m.getDouble("az").toFloat(),
              gx = m.optDouble("gx", 0.0).toFloat(), gy = m.optDouble("gy", 0.0).toFloat(), gz = m.optDouble("gz", 1.0).toFloat(),
              rx = m.optDouble("rx", 0.0).toFloat(), ry = m.optDouble("ry", 0.0).toFloat(), rz = m.optDouble("rz", 0.0).toFloat(),
            ),
          )
        }
        if (batch.isNotEmpty()) engine.pushMotion(batch)
        while (ci < context.length() && context.getJSONObject(ci).getLong("tMs") - t0 + base <= simNow) {
          val c = context.getJSONObject(ci++)
          val touch = c.optLong("lastTouchMs", 0L)
          engine.pushContext(
            Context(
              tMs = (c.getLong("tMs") - t0 + base).toULong(), awayFromHome = c.optBoolean("awayFromHome", true), separated = c.optBoolean("separated", false),
              hourLocal = c.optInt("hourLocal", 1).toUByte(), screenOn = c.optBoolean("screenOn", false), activity = activity(c.optString("activity", "unknown")),
              batteryPct = c.optInt("batteryPct", 80).toUByte(), speedMps = c.optDouble("speedMps", -1.0).toFloat(),
              lastTouchMs = (if (touch > 0L) touch - t0 + base else 0L).toULong(),
              distanceHomeM = c.optDouble("distanceHomeM", -1.0).toFloat(), samplingFull = c.optBoolean("samplingFull", true),
            ),
          )
        }
        while (ai < audio.length() && audio.getJSONObject(ai).getLong("tMs") - t0 + base <= simNow) {
          val a = audio.getJSONObject(ai++)
          engine.pushAudio(AudioScores((a.getLong("tMs") - t0 + base).toULong(), a.optDouble("scream").toFloat(), a.optDouble("shout").toFloat(), a.optDouble("glass").toFloat()))
        }
        rt.dispatch(engine.tick(simNow.toULong()))
        simNow += 1000
        delay((1000 / speed).toLong())
      }
      Log.i("TraceInjector", "replay done: ${engine.snapshot()}")
    }
  }

  private fun lastT(arr: org.json.JSONArray) = if (arr.length() == 0) 0L else arr.getJSONObject(arr.length() - 1).getLong("tMs")

  private fun activity(s: String) = when (s.lowercase()) {
    "stationary" -> Activity.STATIONARY; "walking" -> Activity.WALKING; "running" -> Activity.RUNNING; "vehicle" -> Activity.VEHICLE; else -> Activity.UNKNOWN
  }
}
