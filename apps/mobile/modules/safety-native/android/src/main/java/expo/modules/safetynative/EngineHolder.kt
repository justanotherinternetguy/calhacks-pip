package expo.modules.safetynative

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import uniffi.safety.EngineException
import uniffi.safety.SafetyEngine
import uniffi.safety.Snapshot
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Owns the single `SafetyEngine` instance. Config TOML comes from `configure` (persisted to
 * files/model.toml) or falls back to the bundled assets/model-v1.toml. The baseline blob is
 * stored AES-GCM encrypted under an Android Keystore key that does not require user
 * authentication, so it can be read while the phone is locked (e.g. after a reboot at 3 am).
 * Since v1.1 the blob also carries the engine's incident log, so it is autosaved every 5 min and
 * explicitly on night-session stop (SensingService.stopNightSession → saveNow).
 */
class EngineHolder(private val context: Context, private val prefs: Prefs) {
  /** A data-collection session is running (SafetyRuntime.startCollect): a reloaded engine must keep it on. */
  @Volatile var collecting = false

  companion object {
    private const val TAG = "EngineHolder"
    private const val KEY_ALIAS = "safe.baseline.aesgcm"
    private const val AUTOSAVE_MS = 5 * 60 * 1000L
  }

  private val modelFile = File(context.filesDir, "model.toml")
  private val baselineFile = File(context.filesDir, "baseline.bin")
  @Volatile private var engine: SafetyEngine? = null
  private var autosave: Job? = null

  fun isReady() = engine != null

  /** Returns the engine, creating it from persisted config + baseline on first use. */
  @Synchronized
  fun get(): SafetyEngine = engine ?: createFromPersisted().also { engine = it }

  /**
   * The config the live engine should run: the demo override (assets/model-demo.toml, a partial file the Rust side
   * deep-merges over the bundled defaults) while demo sensitivity is on, else the persisted server TOML, else the
   * bundled model-v1.toml. Every path that changes an input calls [reload].
   */
  private fun activeConfigToml(): String = when {
    prefs.demoSensitivity -> asset("model-demo.toml")
    modelFile.exists() -> modelFile.readText()
    else -> asset("model-v1.toml")
  }

  private fun createFromPersisted(): SafetyEngine =
    try {
      create(activeConfigToml())
    } catch (e: EngineException) {
      // A stale persisted file or a bad demo override must never brick the engine: drop them and use the bundle.
      Log.w(TAG, "active config rejected (${e.message}); falling back to bundled model-v1.toml")
      modelFile.delete()
      prefs.demoSensitivity = false
      create(asset("model-v1.toml"))
    }

  fun snapshotOrNull(): Snapshot? = try { engine?.snapshot() } catch (e: Throwable) { null }

  /** A served config arrived while an escalation was running; applied by [applyPendingReload] once it is over. */
  @Volatile private var pendingReload = false

  /**
   * Server config from `configure` (every launch): persist it as the normal model and run it unless demo is on.
   * A reload rebuilds the engine (escalation back to Idle), so while a check-in or alert is running it waits.
   */
  @Synchronized
  fun setConfigToml(toml: String) {
    if (toml.isBlank()) return
    modelFile.writeText(toml)
    when {
      prefs.demoSensitivity -> Log.i(TAG, "server config stored; live engine keeps the demo override")
      escalating() -> { pendingReload = true; Log.i(TAG, "server config stored; reload deferred until the escalation ends") }
      else -> reload()
    }
  }

  /** Called after every tick: applies a deferred server config once the escalation is back to idle. */
  @Synchronized
  fun applyPendingReload() {
    if (!pendingReload || escalating()) return
    pendingReload = false
    runCatching { reload() }.onFailure { Log.w(TAG, "deferred reload failed", it) }
  }

  private fun escalating(): Boolean {
    val level = snapshotOrNull()?.escalation ?: return false
    return level != uniffi.safety.EscalationLevel.IDLE && level != uniffi.safety.EscalationLevel.RESOLVED
  }

  /** "Demo sensitivity" switch (Settings). The pref is reverted if the swap fails, so a bad override is never sticky. */
  @Synchronized
  fun setDemoSensitivity(on: Boolean) {
    val before = prefs.demoSensitivity
    prefs.demoSensitivity = on
    try {
      reload()
    } catch (e: EngineException) {
      prefs.demoSensitivity = before
      throw e
    }
    Log.i(TAG, "demo sensitivity ${if (on) "on (assets/model-demo.toml)" else "off (normal thresholds)"}")
  }

  /**
   * Re-creates the engine on [activeConfigToml], carrying the baseline over. The new engine is built *before* the
   * old one is closed: `SafetyEngine(...)` throws `EngineException.Config` on bad TOML, and a closed uniffi object
   * throws on every later call, so a failed swap must leave the live engine untouched.
   */
  private fun reload() {
    val old = engine
    old?.let { saveBaseline(it) }
    // A fresh engine starts with night mode off: carry it over, or a mid-night reload (every app launch runs
    // `configure`) would silently stop incident rules and escalation until the next night session.
    val wasNight = runCatching { old?.snapshot()?.nightMode }.getOrNull() == true
    val fresh = create(activeConfigToml())   // throws EngineException → old engine stays live
    if (wasNight) fresh.setNightMode(true, System.currentTimeMillis().toULong())
    if (collecting) fresh.setCollecting(true, System.currentTimeMillis().toULong())
    engine = fresh
    old?.close()
    Log.i(TAG, "engine reloaded${if (wasNight) " (night mode kept on)" else ""}")
  }

  private fun asset(name: String): String = context.assets.open(name).bufferedReader().use { it.readText() }

  private fun create(toml: String): SafetyEngine {
    val baseline = loadBaseline()
    val now = System.currentTimeMillis().toULong()
    return try {
      SafetyEngine(toml, baseline, now)
    } catch (e: EngineException) {
      Log.w(TAG, "engine init failed (${e.message}); retrying without baseline")
      baselineFile.delete()
      SafetyEngine(toml, null, now)
    }.also { it.setLearning(prefs.learningEnabled) }
  }

  fun startAutosave(scope: CoroutineScope) {
    if (autosave?.isActive == true) return
    autosave = scope.launch {
      while (isActive) {
        delay(AUTOSAVE_MS)
        engine?.let { saveBaseline(it) }
      }
    }
  }

  fun saveNow() { engine?.let { saveBaseline(it) } }

  private fun saveBaseline(e: SafetyEngine) {
    try {
      val blob = e.exportBaseline()
      if (blob.isEmpty()) return
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
      val ct = cipher.doFinal(blob)
      val tmp = File(baselineFile.path + ".tmp")
      tmp.writeBytes(cipher.iv + ct)   // 12-byte IV prefix
      tmp.renameTo(baselineFile)
    } catch (t: Throwable) {
      Log.e(TAG, "saveBaseline failed", t)
    }
  }

  private fun loadBaseline(): ByteArray? {
    if (!baselineFile.exists()) return null
    return try {
      val bytes = baselineFile.readBytes()
      val iv = bytes.copyOfRange(0, 12)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)) }
      cipher.doFinal(bytes, 12, bytes.size - 12)
    } catch (t: Throwable) {
      Log.e(TAG, "loadBaseline failed; starting cold", t); null
    }
  }

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setUserAuthenticationRequired(false)   // must be usable while the phone is locked
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return gen.generateKey()
  }
}
