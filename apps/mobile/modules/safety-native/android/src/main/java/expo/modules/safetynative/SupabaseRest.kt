package expo.modules.safetynative

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Minimal blocking PostgREST / RPC / Edge Function client. Every call runs on the caller's thread;
 * callers wrap it in `Dispatchers.IO`. Only ciphertext, tokens and coarse status ever go through here.
 */
class SupabaseRest(private val prefs: Prefs) {
  companion object {
    internal val JSON = "application/json".toMediaType()
    fun isoNow(): String = Instant.now().toString()
  }

  /** Shared client; `client.newBuilder()` derives one with other timeouts on the same pool/dispatcher (TelemetryPublisher). */
  internal val client = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).writeTimeout(20, TimeUnit.SECONDS)
    .build()

  @Volatile private var tokenOverride: String? = null
  fun setAccessToken(token: String) {
    tokenOverride = token
    prefs.serverConfig?.let { prefs.serverConfig = it.copy(accessToken = token) }
  }

  private fun cfg(): ServerConfig = prefs.serverConfig ?: throw IOException("SafetyNative not configured")

  /** `Request.Builder` for `{supabaseUrl}{path}` carrying the apikey / bearer / JSON headers; throws when not configured. */
  internal fun authed(path: String): Request.Builder {
    val c = cfg()
    val token = tokenOverride ?: c.accessToken
    return Request.Builder().url(c.supabaseUrl.trimEnd('/') + path)
      .header("apikey", c.supabaseAnonKey)
      .header("Authorization", "Bearer $token")
      .header("Content-Type", "application/json")
  }

  private fun request(path: String, method: String, body: JSONObject?, prefer: String?, bodyArr: JSONArray? = null): String? {
    val b = authed(path)
    prefer?.let { b.header("Prefer", it) }
    val payload = (bodyArr?.toString() ?: body?.toString() ?: "{}").toRequestBody(JSON)
    when (method) {
      "GET" -> b.get(); "POST" -> b.post(payload); "PATCH" -> b.patch(payload); "DELETE" -> b.delete(payload)
    }
    client.newCall(b.build()).execute().use { resp ->
      val text = resp.body?.string()
      if (!resp.isSuccessful) throw IOException("supabase $method $path -> ${resp.code}: ${text?.take(300)}")
      return text
    }
  }

  fun insert(table: String, row: JSONObject) { request("/rest/v1/$table", "POST", row, "return=minimal") }
  fun insertMany(table: String, rows: JSONArray) { request("/rest/v1/$table", "POST", null, "return=minimal", rows) }
  fun insertReturning(table: String, row: JSONObject): JSONObject? =
    request("/rest/v1/$table", "POST", row, "return=representation")?.let { JSONArray(it).optJSONObject(0) }
  fun upsert(table: String, row: JSONObject, onConflict: String? = null) {
    val q = onConflict?.let { "?on_conflict=$it" } ?: ""
    request("/rest/v1/$table$q", "POST", row, "resolution=merge-duplicates,return=minimal")
  }
  fun patch(table: String, filter: String, patch: JSONObject) { request("/rest/v1/$table?$filter", "PATCH", patch, "return=minimal") }
  fun select(table: String, query: String): JSONArray = JSONArray(request("/rest/v1/$table?$query", "GET", null, null) ?: "[]")
  fun rpc(fn: String, args: JSONObject): String? = request("/rest/v1/rpc/$fn", "POST", args, null)
  fun function(name: String, body: JSONObject): String? = request("/functions/v1/$name", "POST", body, null)
}
