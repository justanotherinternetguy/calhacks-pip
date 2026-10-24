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
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import uniffi.safety.AudioScores
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * Microphone while the engine's listening window is open (`EngineEvent.AudioListening`, see SensingService.setListening):
 * continuous capture between [start] and [stop], one [AudioScores] (YAMNet scream / shout / snore + estimated dB SPL) per
 * ~0.975 s frame. PCM stays in one in-memory frame buffer that is zeroed after use; it is never written anywhere.
 * Requires RECORD_AUDIO and a foreground service that currently holds the microphone type.
 */
class AudioMonitor(private val ctx: Context, private val rt: SafetyRuntime) {
  companion object {
    private const val TAG = "AudioMonitor"
    private const val RETRY_MS = 5_000L
    /** dB SPL = dBFS + this: Android CDD 5.4.2 calibrates VOICE_RECOGNITION to 90 dB SPL @ 1 kHz → RMS 2500 (16-bit). */
    private const val SPL_OFFSET_DB = 112.3f
  }

  private var job: Job? = null

  fun isRunning() = job?.isActive == true

  fun start() {
    if (isRunning()) return
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      Log.w(TAG, "RECORD_AUDIO not granted; audio disabled"); return
    }
    val cls = try { YamnetClassifier(ctx) } catch (e: Throwable) { Log.w(TAG, "yamnet.tflite unavailable; audio disabled", e); return }
    // The classifier is owned by the job and closed when it ends, so stop() never closes it mid-inference.
    job = rt.scope.launch(Dispatchers.IO) {
      try {
        while (isActive) {
          runCatching { capture(cls) }.onFailure { if (isActive) Log.w(TAG, "capture failed", it) }
          if (isActive) delay(RETRY_MS)
        }
      } finally { cls.close() }
    }
  }

  fun stop() {
    job?.cancel(); job = null
  }

  /** Records until cancelled (or the mic fails), pushing one AudioScores per frame. */
  @SuppressLint("MissingPermission")
  private suspend fun capture(cls: YamnetClassifier) {
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
      while (currentCoroutineContext().isActive) {
        var off = 0
        while (off < frame.size) {
          val n = rec.read(frame, off, frame.size - off)
          if (n <= 0) throw IllegalStateException("read=$n"); off += n
        }
        val s = cls.classify(frame)
        rt.engine.get().pushAudio(AudioScores(System.currentTimeMillis().toULong(), s.scream, s.shout, s.snore, levelDb(frame)))
      }
    } finally {
      runCatching { rec.stop() }; rec.release(); frame.fill(0)
    }
  }

  /** Estimated dB SPL of one frame from its RMS (dBFS + [SPL_OFFSET_DB]); RMS floored at 1 LSB (≈ 22 dB). */
  private fun levelDb(pcm: ShortArray): Float {
    var sum = 0.0
    for (x in pcm) sum += x.toDouble() * x
    val rms = sqrt(sum / pcm.size).coerceAtLeast(1.0)
    return (20.0 * log10(rms / 32768.0)).toFloat() + SPL_OFFSET_DB
  }
}
