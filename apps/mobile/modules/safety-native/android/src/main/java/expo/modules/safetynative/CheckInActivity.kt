package expo.modules.safetynative

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.safety.TypingSample

/**
 * Lock-screen-capable "You okay?" screen launched from the check-in notification's full-screen
 * intent. Typing the phrase is the dismiss; the keyguard is requested so a thief must unlock first.
 */
class CheckInActivity : AppCompatActivity() {
  companion object {
    private const val EXTRA_PHRASE = "phrase"
    private const val EXTRA_DEADLINE = "deadline"
    fun intent(ctx: Context, phrase: String, deadlineMs: Long) =
      Intent(ctx, CheckInActivity::class.java).putExtra(EXTRA_PHRASE, phrase).putExtra(EXTRA_DEADLINE, deadlineMs)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
  }

  private lateinit var rt: SafetyRuntime
  private lateinit var tracker: TypingTracker
  private lateinit var status: TextView
  private var phrase = ""

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    rt = SafetyRuntime.get(this)
    rt.touch.attach(this)
    phrase = intent.getStringExtra(EXTRA_PHRASE) ?: ""
    if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    tracker = TypingTracker({ phrase }) {}
    val pad = (16 * resources.displayMetrics.density).toInt()
    val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(pad, pad, pad, pad); setBackgroundColor(Color.WHITE) }
    root.addView(TextView(this).apply { text = "You okay?"; setTextSize(TypedValue.COMPLEX_UNIT_SP, 28f); setTextColor(Color.BLACK); gravity = Gravity.CENTER })
    root.addView(TextView(this).apply { text = "Type this phrase to let your friends know you're fine:"; setTextColor(Color.DKGRAY); gravity = Gravity.CENTER; setPadding(0, pad, 0, pad / 2) })
    root.addView(TextView(this).apply { text = phrase; setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f); setTextColor(Color.BLACK); gravity = Gravity.CENTER })
    val input = EditText(this).apply {
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
      imeOptions = EditorInfo.IME_ACTION_DONE; isSingleLine = true; gravity = Gravity.CENTER
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f); setTextColor(Color.BLACK); hint = "type here"
      addTextChangedListener(tracker)
      setOnEditorActionListener { _, _, _ -> submit(); true }
    }
    root.addView(input)
    // The phrase can only be typed after the phone is unlocked (blocks a thief holding the phone).
    val km = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
    if (km.isKeyguardLocked) {
      input.visibility = android.view.View.GONE
      km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() { input.visibility = android.view.View.VISIBLE; input.requestFocus() }
      })
    }
    status = TextView(this).apply { setTextColor(Color.RED); gravity = Gravity.CENTER; setPadding(0, pad / 2, 0, pad / 2) }
    root.addView(status)
    root.addView(Button(this).apply { text = "I'm fine"; setOnClickListener { submit() } })
    root.addView(Button(this).apply {
      text = "I need help"; setBackgroundColor(Color.parseColor("#B3261E")); setTextColor(Color.WHITE)
      setOnClickListener { rt.needHelp(); finish() }
    })
    setContentView(root)
    input.requestFocus()
  }

  private fun submit() {
    val p = tracker.payload()
    @Suppress("UNCHECKED_CAST")
    val sample = TypingSample(
      phrase, p["typed"] as String, (p["keyTimesMs"] as List<Long>).map { it.toULong() },
      (p["backspaces"] as Int).toUInt(), (p["durationMs"] as Long).toULong(),
    )
    rt.scope.launch {
      val verdict = runCatching { rt.submitCheckIn(sample) }.getOrNull()
      withContext(Dispatchers.Main) {
        if (verdict?.get("accepted") == true) finish()
        else { status.text = verdict?.get("reason")?.toString() ?: "Try again"; tracker.reset() }
      }
    }
  }
}
