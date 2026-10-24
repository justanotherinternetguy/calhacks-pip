package expo.modules.safetynative

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

/**
 * One Supabase Realtime channel over a persistent WebSocket (Phoenix protocol, serializer v2 — the same frames
 * `@supabase/realtime-js` sends from the browser). Used by [TelemetryPublisher] to broadcast ticks without the
 * per-request cost of `POST /realtime/v1/api/broadcast`: once joined, a tick is one text frame on an open socket.
 *
 * Wire format: every message is `[join_ref, ref, topic, event, payload]`.
 *   join       → `[ref, ref, "realtime:<topic>", "phx_join", { config: { broadcast: { self, ack: false }, presence: { enabled: false }, postgres_changes: [], private: true }, access_token }]`
 *   heartbeat  → `[null, ref, "phoenix", "heartbeat", {}]` every [HEARTBEAT_MS]; a missed reply drops the socket.
 *   broadcast  → `[join_ref, null, "realtime:<topic>", "broadcast", { type: "broadcast", event, payload }]`
 *   token      → `[join_ref, ref, "realtime:<topic>", "access_token", { access_token }]` when the JWT rotates.
 * Inbound `broadcast` frames (only with `self = true`: our own ticks echoed by the server) go to [onBroadcast].
 *
 * Lifecycle: [start] connects and keeps reconnecting with realtime-js's backoff (1, 2, 5, 10 s) until [stop];
 * a join refusal, `system` error, `phx_error`/`phx_close`, heartbeat timeout or transport failure all count as a
 * failure and schedule a reconnect. [joinEpoch] increments on every successful join so callers can replay state.
 * Thread-safety: OkHttp calls the listener on its own threads; state transitions go through [lock].
 */
class RealtimeSocket(
  private val scope: CoroutineScope,
  private val http: OkHttpClient,
  private val tag: String,
  private val onBroadcast: (event: String, payload: JSONObject, receivedAtMs: Long) -> Unit,
) {
  companion object {
    private const val HEARTBEAT_MS = 25_000L
    private val RECONNECT_MS = longArrayOf(1_000L, 2_000L, 5_000L, 10_000L)
    private const val VSN = "2.0.0"
  }

  /** Where to connect and what to join. `selfEcho` asks the server to send our own broadcasts back (latency probe). */
  data class Target(val supabaseUrl: String, val anonKey: String, val topic: String, val selfEcho: Boolean) {
    val wsUrl: String get() {
      val base = supabaseUrl.trimEnd('/').replaceFirst("^http".toRegex(), "ws")
      return "$base/realtime/v1/websocket?apikey=$anonKey&vsn=$VSN"
    }
    val phxTopic: String get() = "realtime:$topic"
  }

  private val lock = Any()
  private var target: Target? = null
  @Volatile private var token: String? = null
  @Volatile private var ws: WebSocket? = null
  @Volatile private var joinRef: String? = null
  private var heartbeatJob: Job? = null
  private var reconnectJob: Job? = null
  @Volatile private var pendingHeartbeatRef: String? = null
  private val refs = AtomicLong(0)
  private var attempt = 0
  @Volatile private var stopped = true

  /** True between a `phx_reply ok` to our join and the next failure. */
  @Volatile var joined = false
    private set
  /** Incremented on every successful join. */
  @Volatile var joinEpoch = 0L
    private set
  /** Reconnect attempts since [start]. */
  @Volatile var reconnects = 0
    private set
  /** Failures (join refused, transport error, heartbeat timeout…) since process start. */
  @Volatile var failures = 0
    private set
  /** Last failure reason, for the status map / log. */
  @Volatile var lastError: String? = null
    private set

  fun currentTarget(): Target? = synchronized(lock) { target }

  /** Connect (or reconnect to a different target) and keep the channel joined until [stop]. */
  fun start(t: Target, jwt: String) {
    synchronized(lock) {
      token = jwt
      if (!stopped && target == t && (ws != null || reconnectJob != null)) return
      stopped = false
      target = t
      attempt = 0
      closeSocketLocked()
      reconnectJob?.cancel(); reconnectJob = null
      connectLocked()
    }
  }

  fun stop() {
    synchronized(lock) {
      if (stopped) return
      stopped = true
      reconnectJob?.cancel(); reconnectJob = null
      closeSocketLocked()
      if (joined) Log.i(tag, "socket stopped")
      joined = false
    }
  }

  /** Connectivity came back: skip the rest of the backoff and reconnect right away (no-op while connected or stopped). */
  fun retryNow() {
    synchronized(lock) {
      if (stopped || ws != null) return
      reconnectJob?.cancel(); reconnectJob = null
      attempt = 0
      Log.i(tag, "network available; reconnecting now")
      connectLocked()
    }
  }

  /** New JWT (session refresh): pushed to the joined channel so the server keeps us authorised past the old `exp`. */
  fun setToken(jwt: String) {
    if (jwt == token) return
    token = jwt
    synchronized(lock) {
      val t = target ?: return
      if (joined) ws?.send(encode(joinRef, nextRef(), t.phxTopic, "access_token", JSONObject().put("access_token", jwt)))
    }
  }

  /** Broadcast `payload` as `event` on the joined channel. False (and the frame dropped) when not joined. */
  fun send(event: String, payload: JSONObject): Boolean {
    if (!joined) return false
    val t = target ?: return false
    val sock = ws ?: return false
    val msg = JSONObject().put("type", "broadcast").put("event", event).put("payload", payload)
    return sock.send(encode(joinRef, null, t.phxTopic, "broadcast", msg))
  }

  // ---- internals ----------------------------------------------------------------

  private fun nextRef(): String = refs.incrementAndGet().toString()

  private fun encode(joinRef: String?, ref: String?, topic: String, event: String, payload: JSONObject): String =
    JSONArray().put(joinRef ?: JSONObject.NULL).put(ref ?: JSONObject.NULL).put(topic).put(event).put(payload).toString()

  private fun connectLocked() {
    val t = target ?: return
    val req = Request.Builder().url(t.wsUrl).build()
    ws = http.newWebSocket(req, listener)
  }

  private fun closeSocketLocked() {
    heartbeatJob?.cancel(); heartbeatJob = null
    pendingHeartbeatRef = null
    ws?.let { runCatching { it.close(1000, "bye") }; runCatching { it.cancel() } }
    ws = null
    joinRef = null
  }

  private fun joinLocked() {
    val t = target ?: return
    val ref = nextRef()
    joinRef = ref
    val config = JSONObject()
      .put("broadcast", JSONObject().put("self", t.selfEcho).put("ack", false))
      .put("presence", JSONObject().put("enabled", false))
      .put("postgres_changes", JSONArray())
      .put("private", true)
    val payload = JSONObject().put("config", config)
    token?.let { payload.put("access_token", it) }
    ws?.send(encode(ref, ref, t.phxTopic, "phx_join", payload))
  }

  private fun startHeartbeatLocked() {
    heartbeatJob?.cancel()
    heartbeatJob = scope.launch {
      while (isActive) {
        delay(HEARTBEAT_MS)
        if (pendingHeartbeatRef != null) { down("heartbeat timeout"); return@launch }
        val ref = nextRef()
        pendingHeartbeatRef = ref
        val ok = synchronized(lock) { ws?.send(encode(null, ref, "phoenix", "heartbeat", JSONObject())) ?: false }
        if (!ok) { down("heartbeat send failed"); return@launch }
      }
    }
  }

  /** Any failure: tear the socket down and schedule a reconnect with backoff (unless stopped). */
  private fun down(reason: String) {
    synchronized(lock) {
      failures++
      lastError = reason
      val wasJoined = joined
      joined = false
      closeSocketLocked()
      if (stopped) return
      if (reconnectJob?.isActive == true) return
      val wait = RECONNECT_MS[attempt.coerceAtMost(RECONNECT_MS.size - 1)]
      attempt++
      reconnects++
      Log.w(tag, "socket down ($reason)${if (wasJoined) "" else " before join"}; reconnect in ${wait / 1000} s (attempt $attempt)")
      reconnectJob = scope.launch {
        delay(wait)
        synchronized(lock) {
          reconnectJob = null
          if (!stopped && ws == null) connectLocked()
        }
      }
    }
  }

  private fun handle(text: String, now: Long) {
    val arr = runCatching { JSONArray(text) }.getOrNull() ?: return
    if (arr.length() < 5) return
    val ref = if (arr.isNull(1)) null else arr.optString(1)
    val topic = arr.optString(2)
    val event = arr.optString(3)
    val payload = arr.optJSONObject(4) ?: JSONObject()
    val t = target ?: return
    when (event) {
      "phx_reply" -> {
        val status = payload.optString("status")
        if (ref != null && ref == joinRef) {
          if (status == "ok") {
            synchronized(lock) {
              if (stopped) return
              joined = true
              attempt = 0
              joinEpoch++
              lastError = null
              startHeartbeatLocked()
            }
            Log.i(tag, "joined ${t.topic} (self-echo ${if (t.selfEcho) "on" else "off"})")
          } else {
            val why = payload.optJSONObject("response")?.let { it.optString("reason").ifBlank { it.optString("message") } }.orEmpty()
            down("join refused: ${why.ifBlank { payload.toString().take(120) }}")
          }
        } else if (ref != null && ref == pendingHeartbeatRef) {
          pendingHeartbeatRef = null
        }
      }
      "broadcast" -> if (topic == t.phxTopic) {
        val inner = payload.optJSONObject("payload") ?: return
        onBroadcast(payload.optString("event"), inner, now)
      }
      "system" -> if (payload.optString("status") == "error") down("system: ${payload.optString("message").take(120)}")
      "phx_error" -> down("channel error")
      "phx_close" -> if (!stopped) down("channel closed")
    }
  }

  private val listener = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      synchronized(lock) { if (webSocket === ws) joinLocked() else webSocket.cancel() }
    }
    override fun onMessage(webSocket: WebSocket, text: String) {
      if (webSocket !== ws) return
      runCatching { handle(text, System.currentTimeMillis()) }.onFailure { Log.w(tag, "bad frame: ${it.message}") }
    }
    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      if (webSocket === ws) down("closing $code ${reason.take(60)}")
    }
    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      if (webSocket === ws) down("closed $code")
    }
    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (webSocket === ws) down("io ${t.javaClass.simpleName}${response?.let { " http ${it.code}" } ?: ""}")
    }
  }
}
