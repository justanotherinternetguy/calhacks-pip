package expo.modules.safetynative

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import uniffi.safety.AudioScores

/**
 * Duty-cycled microphone: 5 s on / 25 s off in night mode, continuous for 2 min after `boost()`
 * (any motion signal). PCM stays in a ring buffer in memory; it is never written anywhere.
 * Requires RECORD_AUDIO and a foreground service that currently holds the microphone type.
 */
class AudioMonitor(private val ctx: Context, private val rt: SafetyRuntime) {
  companion object {
    private const val TAG = "AudioMonitor"
    private const val ON_MS = 5_000L
    private const val OFF_MS = 25_000L
    private const val BOOST_MS = 120_000L
  }

  private var job: Job? = null
  private var classifier: YamnetClassifier? = null
  @Volatile private var continuousUntil = 0L

  fun isRunning() = job?.isActive == true

  fun boost() { continuousUntil = System.currentTimeMillis() + BOOST_MS }

  fun start() {
    if (isRunning()) return
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      Log.w(TAG, "RECORD_AUDIO not granted; audio booster disabled"); return
    }
    if (classifier == null) {
      classifier = try { YamnetClassifier(ctx) } catch (e: Throwable) { Log.w(TAG, "yamnet.tflite unavailable; audio disabled", e); return }
    }
    job = rt.scope.launch(Dispatchers.IO) {
      while (isActive) {
        val windowMs = if (System.currentTimeMillis() < continuousUntil) BOOST_MS else ON_MS
        runCatching { captureFor(windowMs) }.onFailure { Log.w(TAG, "capture failed", it) }
        if (System.currentTimeMillis() >= continuousUntil) delay(OFF_MS)
      }
    }
  }

  fun stop() {
    job?.cancel(); job = null
    classifier?.close(); classifier = null
  }

  @SuppressLint("MissingPermission")
  private suspend fun captureFor(windowMs: Long) {
    val cls = classifier ?: return
    val minBuf = AudioRecord.getMinBufferSize(YamnetClassifier.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val rec = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION, YamnetClassifier.SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, YamnetClassifier.FRAME_SAMPLES * 2 * 2),
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); throw IllegalStateException("AudioRecord init failed (mic FGS type missing?)") }
    val frame = ShortArray(YamnetClassifier.FRAME_SAMPLES)
    try {
      rec.startRecording()
      if (rec.recordingState != AudioRecord.RECORDSTATE_RECORDING) throw IllegalStateException("mic busy or blocked")
      val end = System.currentTimeMillis() + windowMs
      // A motion boost arriving mid-capture simply extends this window.
      while ((System.currentTimeMillis() < end || System.currentTimeMillis() < continuousUntil) && job?.isActive == true) {
        var off = 0
        while (off < frame.size) {
          val n = rec.read(frame, off, frame.size - off)
          if (n <= 0) throw IllegalStateException("read=$n"); off += n
        }
        val s = cls.classify(frame)
        rt.engine.get().pushAudio(AudioScores(System.currentTimeMillis().toULong(), s.scream, s.shout, s.glass))
      }
    } finally {
      runCatching { rec.stop() }; rec.release(); frame.fill(0)
    }
  }
}
