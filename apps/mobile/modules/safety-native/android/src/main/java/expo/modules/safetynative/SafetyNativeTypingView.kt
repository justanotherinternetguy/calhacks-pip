package expo.modules.safetynative

import android.content.Context
import android.graphics.Color
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Records per-key timestamps and backspaces on an EditText. Works with soft keyboards (TextWatcher),
 * since hardware KeyEvents are not delivered for IME input.
 */
class TypingTracker(private val phrase: () -> String, private val onKey: (Map<String, Any>) -> Unit) : TextWatcher {
  val keyTimesMs = ArrayList<Long>()
  var backspaces = 0
  private var startMs = 0L
  private var lastLen = 0
  var typed: String = ""

  fun reset() { keyTimesMs.clear(); backspaces = 0; startMs = 0L; lastLen = 0; typed = "" }

  override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
  override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
  override fun afterTextChanged(s: Editable?) {
    val now = System.currentTimeMillis()
    val text = s?.toString() ?: ""
    if (startMs == 0L) startMs = now
    if (text.length < lastLen) backspaces += lastLen - text.length
    keyTimesMs.add(now)
    lastLen = text.length; typed = text
    onKey(payload())
  }

  fun payload(): Map<String, Any> = mapOf(
    "typed" to typed, "keyTimesMs" to keyTimesMs.toList(), "backspaces" to backspaces,
    "durationMs" to if (startMs == 0L) 0L else (keyTimesMs.lastOrNull() ?: startMs) - startMs, "phrase" to phrase(),
  )
}

class SafetyNativeTypingView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onKey by EventDispatcher()
  private val onSubmit by EventDispatcher()
  private var phrase = ""
  private val tracker = TypingTracker({ phrase }) { onKey(it) }

  val editText = EditText(context).apply {
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
    imeOptions = EditorInfo.IME_ACTION_DONE
    isSingleLine = true
    gravity = Gravity.CENTER
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
    setTextColor(Color.BLACK); setHintTextColor(Color.GRAY)
    addTextChangedListener(tracker)
    setOnEditorActionListener { _, actionId, event ->
      if (actionId == EditorInfo.IME_ACTION_DONE || event?.keyCode == KeyEvent.KEYCODE_ENTER) { onSubmit(tracker.payload()); true } else false
    }
  }

  init {
    addView(editText, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
  }

  fun setPhrase(p: String) {
    if (p != phrase) { phrase = p; tracker.reset(); editText.setText(""); editText.hint = p }
  }
}
