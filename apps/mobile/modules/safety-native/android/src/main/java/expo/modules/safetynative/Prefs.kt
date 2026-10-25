package expo.modules.safetynative

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

/** One home/dorm place. Stored on the device only; never uploaded. */
data class HomePlace(val id: String, val label: String, val lat: Double, val lng: Double, val radiusM: Double)

/**
 * Backend + identity configuration passed from JS via `configure` / `setSession`. `refreshToken` lets native keep the
 * JWT alive itself ([SessionKeeper]) while the JS runtime is asleep; null = JS never handed one over (no refresh).
 */
data class ServerConfig(
  val supabaseUrl: String,
  val supabaseAnonKey: String,
  val accessToken: String,
  val userId: String,
  val deviceId: String,
  val refreshToken: String? = null,
)

/**
 * Android-Keystore-wrapped encrypted preferences for everything small and secret:
 * server config, home places, identity keys, escrow state, night-mode settings.
 */
class Prefs(context: Context) {
  private val sp: SharedPreferences = run {
    val masterKey = MasterKey.Builder(context, "safe.prefs.master")
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .setUserAuthenticationRequired(false)
      .build()
    EncryptedSharedPreferences.create(
      context, "safe.prefs", masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
  }

  fun getString(key: String): String? = sp.getString(key, null)
  fun putString(key: String, value: String?) = sp.edit().putString(key, value).apply()
  fun getLong(key: String, def: Long) = sp.getLong(key, def)
  fun putLong(key: String, value: Long) = sp.edit().putLong(key, value).apply()
  fun getInt(key: String, def: Int) = sp.getInt(key, def)
  fun putInt(key: String, value: Int) = sp.edit().putInt(key, value).apply()
  fun getBool(key: String, def: Boolean) = sp.getBoolean(key, def)
  fun putBool(key: String, value: Boolean) = sp.edit().putBoolean(key, value).apply()
  fun remove(key: String) = sp.edit().remove(key).apply()

  var serverConfig: ServerConfig?
    get() = getString("server")?.let {
      val o = JSONObject(it)
      ServerConfig(
        o.getString("url"), o.getString("anon"), o.getString("token"), o.getString("user"), o.getString("device"),
        o.optString("refresh").ifBlank { null },
      )
    }
    set(v) = putString(
      "server",
      v?.let {
        JSONObject().put("url", it.supabaseUrl).put("anon", it.supabaseAnonKey).put("token", it.accessToken)
          .put("user", it.userId).put("device", it.deviceId).put("refresh", it.refreshToken ?: "").toString()
      },
    )

  var homePlaces: List<HomePlace>
    get() = getString("home_places")?.let { s ->
      val arr = JSONArray(s)
      (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        HomePlace(o.getString("id"), o.getString("label"), o.getDouble("lat"), o.getDouble("lng"), o.getDouble("radiusM"))
      }
    } ?: emptyList()
    set(v) = putString(
      "home_places",
      JSONArray().also { arr ->
        v.forEach {
          arr.put(JSONObject().put("id", it.id).put("label", it.label).put("lat", it.lat).put("lng", it.lng).put("radiusM", it.radiusM))
        }
      }.toString(),
    )

  var eveningStartHour: Int
    get() = getInt("evening_start", 20)
    set(v) = putInt("evening_start", v)
  var eveningEndHour: Int
    get() = getInt("evening_end", 6)
    set(v) = putInt("evening_end", v)
  /** 'auto' | 'on' | 'off' | 'paused_tonight' */
  var nightModeSetting: String
    get() = getString("night_mode") ?: "auto"
    set(v) = putString("night_mode", v)
  var learningEnabled: Boolean
    get() = getBool("learning", true)
    set(v) = putBool("learning", v)
  /** Live telemetry stream switch (CONTRACTS §7, `setTelemetry`). Default on; only effective once `configure` has run. */
  var telemetryOn: Boolean
    get() = getBool("telemetry", true)
    set(v) = putBool("telemetry", v)
  /**
   * "Demo sensitivity" (Settings): the live engine runs assets/model-demo.toml (lenient thresholds so a judge can
   * trigger incidents by hand) instead of the server/bundled model. Default off. Survives restarts (EngineHolder).
   */
  var demoSensitivity: Boolean
    get() = getBool("demo_sensitivity", false)
    set(v) = putBool("demo_sensitivity", v)
  /**
   * "Allow data collection" (Settings): a group-mate's /collect page may start a labelled recording session on this
   * phone (`collect_start` on telemetry-cmd). Off by default; commands are ignored while off.
   */
  var collectAllowed: Boolean
    get() = getBool("collect_allowed", false)
    set(v) = putBool("collect_allowed", v)
  /** Last observed touch / interactive unlock (wall-clock ms; 0 = never). Written at most once a minute by TouchTracker. */
  var lastTouchMs: Long
    get() = getLong("last_touch", 0L)
    set(v) = putLong("last_touch", v)
}
