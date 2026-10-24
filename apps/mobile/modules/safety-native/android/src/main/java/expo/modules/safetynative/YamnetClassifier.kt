package expo.modules.safetynative

import android.content.Context
import android.util.Log
import org.tensorflow.lite.Interpreter
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel

/**
 * YAMNet (TFLite) over 0.975 s @ 16 kHz frames = 15 600 samples → 521 class scores.
 * Class indices are resolved by display name from assets/yamnet_class_map.csv so a different
 * model export cannot silently shift them; falls back to the stock AudioSet indices.
 */
class YamnetClassifier(context: Context) {
  companion object {
    const val SAMPLE_RATE = 16_000
    const val FRAME_SAMPLES = 15_600
    private const val NUM_CLASSES = 521
    private const val TAG = "Yamnet"
  }

  data class Scores(val scream: Float, val shout: Float, val glass: Float)

  private val interpreter: Interpreter
  private val screamIdx: IntArray
  private val shoutIdx: IntArray
  private val glassIdx: IntArray
  private val input = Array(1) { FloatArray(FRAME_SAMPLES) }
  private val output = Array(1) { FloatArray(NUM_CLASSES) }

  init {
    val buf: ByteBuffer = context.assets.openFd("yamnet.tflite").use { fd ->
      fd.createInputStream().channel.map(FileChannel.MapMode.READ_ONLY, fd.startOffset, fd.declaredLength)
    }.order(ByteOrder.nativeOrder())
    interpreter = Interpreter(buf, Interpreter.Options().setNumThreads(2))
    // Stock TFHub export takes a flat [15600] waveform; some exports use [1,15600]. Match whichever.
    val inShape = interpreter.getInputTensor(0).shape()
    if (inShape.size == 1) interpreter.resizeInput(0, intArrayOf(FRAME_SAMPLES)) else interpreter.resizeInput(0, intArrayOf(1, FRAME_SAMPLES))
    interpreter.allocateTensors()

    val names = loadClassNames(context)
    fun find(vararg labels: String, fallback: IntArray): IntArray {
      val found = labels.mapNotNull { l -> names.indexOfFirst { it.equals(l, ignoreCase = true) }.takeIf { it >= 0 } }
      return if (found.isEmpty()) fallback else found.toIntArray()
    }
    screamIdx = find("Screaming", fallback = intArrayOf(11))
    shoutIdx = find("Shout", "Yell", "Bellow", "Whoop", fallback = intArrayOf(6, 9, 7, 8))
    glassIdx = find("Glass", "Shatter", fallback = intArrayOf(435, 437))
    Log.i(TAG, "classes: scream=${screamIdx.toList()} shout=${shoutIdx.toList()} glass=${glassIdx.toList()}")
  }

  private fun loadClassNames(context: Context): List<String> = try {
    context.assets.open("yamnet_class_map.csv").bufferedReader().useLines { lines ->
      lines.drop(1).map { line -> line.substringAfter(',').substringAfter(',').trim().trim('"') }.toList()
    }
  } catch (e: Throwable) { emptyList() }

  /** `pcm` is 15 600 int16 samples. Returns max prob over each class group. */
  fun classify(pcm: ShortArray): Scores {
    val f = input[0]
    for (i in 0 until FRAME_SAMPLES) f[i] = (if (i < pcm.size) pcm[i].toFloat() else 0f) / 32768f
    val inShape = interpreter.getInputTensor(0).shape()
    if (inShape.size == 1) interpreter.run(f, output) else interpreter.run(input, output)
    val s = output[0]
    fun maxOf(idx: IntArray) = idx.maxOf { if (it in s.indices) s[it] else 0f }
    return Scores(maxOf(screamIdx), maxOf(shoutIdx), maxOf(glassIdx))
  }

  fun close() = interpreter.close()
}
