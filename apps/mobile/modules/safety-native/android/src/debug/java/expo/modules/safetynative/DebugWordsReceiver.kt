package expo.modules.safetynative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Debug builds only: runs a 16 kHz mono 16-bit WAV from the app's files dir through [DistressWordSpotter] and logs one
 * score per frame (tag DebugWords). Lets the spotter be checked on a phone without a real fall:
 *   adb push help.wav /data/local/tmp/ && adb shell run-as app.safe.mobile cp /data/local/tmp/help.wav files/
 *   adb shell am broadcast -n app.safe.mobile/expo.modules.safetynative.DebugWordsReceiver --es wav help.wav
 */
class DebugWordsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val name = intent.getStringExtra("wav") ?: return
    val pending = goAsync()
    Thread {
      try {
        val t0 = System.currentTimeMillis()
        val spotter = DistressWordSpotter(context)
        Log.i(TAG, "spotter ready in ${System.currentTimeMillis() - t0} ms")
        val bytes = File(context.filesDir, name).readBytes()
        val pcm = ByteBuffer.wrap(bytes, 44, bytes.size - 44).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val all = ShortArray(pcm.remaining()).also { pcm.get(it) }
        // pad with a second of silence so the last utterance ends
        val padded = all + ShortArray(YamnetClassifier.FRAME_SAMPLES * 2)
        val frame = ShortArray(YamnetClassifier.FRAME_SAMPLES)
        var best = 0f
        var i = 0
        while (i + frame.size <= padded.size) {
          System.arraycopy(padded, i, frame, 0, frame.size)
          val t = System.nanoTime()
          val s = spotter.score(frame)
          best = maxOf(best, s)
          Log.i(TAG, "$name frame ${i / frame.size}: score %.2f (%.0f ms)".format(s, (System.nanoTime() - t) / 1e6))
          i += frame.size
        }
        spotter.close()
        Log.i(TAG, "$name best %.2f".format(best))
      } catch (e: Throwable) {
        Log.e(TAG, "failed", e)
      } finally { pending.finish() }
    }.start()
  }

  companion object { private const val TAG = "DebugWords" }
}
