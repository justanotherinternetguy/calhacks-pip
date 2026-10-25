package expo.modules.safetynative

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import org.vosk.LibVosk
import org.vosk.LogLevel
import org.vosk.Model
import org.vosk.Recognizer
import java.io.File

/**
 * Distress words ("help", "get off me", "call the police", …) in the listening window, with Vosk
 * (vosk-model-small-en-us-0.15, offline). The recognizer is limited to [PHRASES] plus "[unk]", so other speech comes
 * out as "[unk]" or nothing. [score] takes the same 0.975 s, 16 kHz frames as YAMNet and returns one number per
 * frame: the confidence of a whole listed phrase heard in an utterance that ended in this frame, else 0.
 *
 * Privacy: audio and recognised text stay in memory for one frame and are never logged, stored or uploaded. Only the
 * score leaves this class.
 *
 * Vosk loads its model from a directory, so on first use the model is copied out of the APK assets into
 * `filesDir/vosk/<ASSET_DIR>/`, and reused while its VERSION file matches the asset's. Call on a background thread
 * (the copy is ~68 MB the first time, the load ~1 s). Throws if the model is missing or cannot load.
 */
class DistressWordSpotter(context: Context) {
  companion object {
    private const val TAG = "DistressWords"
    const val SAMPLE_RATE = 16_000
    private const val ASSET_DIR = "vosk-model-small-en-us"
    private const val MARKER = "VERSION"

    /**
     * Each is matched as a whole phrase. All words are in the small model's vocabulary (checked 2026-10-25). "stop" and
     * "get off" were left out: off-device tests heard them in everyday talk ("can you stop by later").
     */
    val PHRASES = listOf(
      "help", "help me", "somebody help", "someone help", "get off me", "leave me alone",
      "call the police", "call an ambulance", "i can't breathe", "i'm hurt", "it hurts",
    )
    /** Word sequences that count, longest first; the grammar often drops a leading "i" ("can't breathe"). */
    private val MATCH: List<List<String>> =
      (PHRASES.map { it.split(' ') } + listOf(listOf("can't", "breathe"))).sortedByDescending { it.size }
  }

  private val model: Model
  private val recognizer: Recognizer

  init {
    LibVosk.setLogLevel(LogLevel.WARNINGS)
    val dir = installModel(context)
    model = Model(dir.absolutePath)
    recognizer = try {
      Recognizer(model, SAMPLE_RATE.toFloat(), JSONArray(PHRASES + "[unk]").toString()).apply { setWords(true) }
    } catch (e: Throwable) { model.close(); throw e }
  }

  /**
   * One frame of 16-bit mono PCM at 16 kHz. Returns the confidence (0..1) of the best listed phrase in an utterance
   * that ended with this frame, or 0 (no phrase, or the utterance is still going). Partial results are ignored.
   */
  fun score(pcm: ShortArray): Float {
    if (!recognizer.acceptWaveForm(pcm, pcm.size)) return 0f
    val words = JSONObject(recognizer.result).optJSONArray("result") ?: return 0f
    val heard = List(words.length()) { words.getJSONObject(it) }
    var best = 0f
    for (p in MATCH) {
      for (k in 0..heard.size - p.size) {
        if (p.indices.all { heard[k + it].optString("word") == p[it] }) {
          best = maxOf(best, p.indices.minOf { heard[k + it].optDouble("conf", 0.0).toFloat() })
        }
      }
    }
    if (best > 0f) Log.d(TAG, "distress word heard, conf %.2f".format(best))
    return best
  }

  /** Forget the utterance in progress (e.g. after a gap in the audio). */
  fun reset() = recognizer.reset()

  fun close() {
    recognizer.close()
    model.close()
  }

  /** Copies the model out of the assets once per model version; returns its directory. */
  private fun installModel(context: Context): File {
    val assets = context.assets
    val want = assets.open("$ASSET_DIR/$MARKER").bufferedReader().use { it.readText().trim() }
    val root = File(context.filesDir, "vosk")
    val dir = File(root, ASSET_DIR)
    val marker = File(dir, MARKER)
    if (marker.isFile && marker.readText().trim() == want) return dir

    Log.i(TAG, "installing $want")
    val tmp = File(root, "$ASSET_DIR.tmp")
    tmp.deleteRecursively()
    fun copy(asset: String, to: File) {
      val children = assets.list(asset).orEmpty()
      if (children.isEmpty()) {
        to.parentFile?.mkdirs()
        assets.open(asset).use { i -> to.outputStream().use { o -> i.copyTo(o) } }
      } else children.forEach { copy("$asset/$it", File(to, it)) }
    }
    copy(ASSET_DIR, tmp) // VERSION comes along; a copy cut short stays in .tmp and is redone next time
    dir.deleteRecursively()
    if (!tmp.renameTo(dir)) throw IllegalStateException("could not move the Vosk model into place")
    return dir
  }
}
