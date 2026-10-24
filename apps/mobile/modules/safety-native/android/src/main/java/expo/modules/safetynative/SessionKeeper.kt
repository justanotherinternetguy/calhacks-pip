package expo.modules.safetynative

import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Keeps the Supabase session alive from native. JS only refreshes while it is awake and in the foreground, so after
 * ~1 h in the background (or after a reboot that restarted only the service) every upload, push and the telemetry
 * channel used to die with an expired JWT. Now JS hands the refresh token over (`configure` / `setSession`) and this
 * loop rotates the pair [REFRESH_AHEAD_MS] before `exp`, stores it, and tells JS (`sessionRefreshed`) so supabase-js
 * adopts the new pair instead of refreshing with a token the server already rotated.
 *
 * Conflict rule: whoever refreshes first wins; the other side adopts. JS refreshes ~90 s before `exp`, native 5 min
 * before, so in practice native leads whenever it runs. A refresh refusal (revoked / already used) parks the keeper
 * until JS delivers a new session. One log line per refresh or failure state.
 */
class SessionKeeper(private val rt: SafetyRuntime) {
  companion object {
    private const val TAG = "Session"
    private const val POLL_MS = 30_000L
    private const val REFRESH_AHEAD_MS = 5 * 60_000L
    private const val RETRY_MS = 60_000L

    /** `exp` (unix ms) from a JWT payload; null when the token is not a JWT. */
    fun jwtExpMs(jwt: String): Long? {
      val parts = jwt.split('.')
      if (parts.size < 2) return null
      return runCatching {
        val json = String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP), Charsets.UTF_8)
        JSONObject(json).optLong("exp", 0L).takeIf { it > 0 }?.times(1000L)
      }.getOrNull()
    }
  }

  private var job: Job? = null
  /** Refresh token the server refused; no retry until JS hands over a different one. */
  @Volatile private var deadRefreshToken: String? = null
  @Volatile private var lastFailure: String? = null

  @Synchronized
  fun start() {
    if (job?.isActive == true) return
    job = rt.scope.launch {
      while (isActive) {
        val wait = runCatching { step() }.getOrElse { Log.w(TAG, "step failed", it); RETRY_MS }
        delay(wait)
      }
    }
  }

  /** Called when JS delivered a session: a token the server refused earlier is forgotten once a different one arrives. */
  fun onSessionFromJs(refreshToken: String?) {
    if (refreshToken != null && refreshToken != deadRefreshToken) deadRefreshToken = null
  }

  fun statusLine(): String {
    val cfg = rt.prefs.serverConfig ?: return "not configured"
    val exp = jwtExpMs(cfg.accessToken) ?: return "token is not a JWT"
    val left = (exp - rt.now()) / 1000
    return "token ${if (left < 0) "expired ${-left} s ago" else "valid ${left} s"}; refresh ${if (cfg.refreshToken == null) "unavailable (JS never sent one)" else if (deadRefreshToken == cfg.refreshToken) "refused: $lastFailure" else "armed"}"
  }

  /** One decision: refresh now if due; returns how long to sleep. */
  private fun step(): Long {
    val cfg = rt.prefs.serverConfig ?: return POLL_MS
    val refresh = cfg.refreshToken ?: return POLL_MS
    if (cfg.accessToken.isBlank() || refresh == deadRefreshToken) return POLL_MS
    val exp = jwtExpMs(cfg.accessToken) ?: return POLL_MS
    val due = exp - REFRESH_AHEAD_MS
    val now = rt.now()
    if (now < due) return (due - now).coerceIn(1_000L, POLL_MS)
    return try {
      val (access, newRefresh) = rt.supabase.refreshSession(refresh)
      rt.applySession(access, newRefresh, fromJs = false)
      lastFailure = null
      Log.i(TAG, "refreshed; next in ${((jwtExpMs(access) ?: now) - now - REFRESH_AHEAD_MS) / 1000} s")
      POLL_MS
    } catch (e: Exception) {
      val msg = e.message ?: e.javaClass.simpleName
      if (msg != lastFailure) Log.w(TAG, "refresh failed: $msg")
      lastFailure = msg
      // 400/401/403 = the token itself is bad (used, revoked, signed out): stop hammering until JS sends a new one.
      if (Regex("-> 40[013]").containsMatchIn(msg)) { deadRefreshToken = refresh; POLL_MS } else RETRY_MS
    }
  }
}
