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
 */
class EngineHolder(private val context: Context, private val prefs: Prefs) {
  companion object {
    private const val TAG = "EngineHolder"
    private const val KEY_ALIAS = "safe.baseline.aesgcm"
    private const val AUTOSAVE_MS = 10 * 60 * 1000L
  }

  private val modelFile = File(context.filesDir, "model.toml")
  private val baselineFile = File(context.filesDir, "baseline.bin")
  @Volatile private var engine: SafetyEngine? = null
  private var autosave: Job? = null

  fun isReady() = engine != null

  /** Returns the engine, creating it from persisted config + baseline on first use. */
  @Synchronized
  fun get(): SafetyEngine = engine ?: create(loadConfigToml()).also { engine = it }

  fun snapshotOrNull(): Snapshot? = try { engine?.snapshot() } catch (e: Throwable) { null }

  /**
   * Replace the model config (from `configure`). Re-creates the engine, carrying the baseline over.
   * The new engine is built *before* the old one is closed: `SafetyEngine(...)` throws
   * `EngineException.Config` on bad TOML, and a closed uniffi object throws on every later call,
   * so a failed swap must leave the live engine (and the persisted config) untouched.
   */
  @Synchronized
  fun setConfigToml(toml: String) {
    if (toml.isBlank()) return
    val old = engine
    old?.let { saveBaseline(it) }
    val fresh = create(toml)          // throws EngineException → old engine stays live
    modelFile.writeText(toml)
    engine = fresh
    old?.close()
  }

  private fun loadConfigToml(): String =
    if (modelFile.exists()) modelFile.readText()
    else context.assets.open("model-v1.toml").bufferedReader().use { it.readText() }

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
