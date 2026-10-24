package expo.modules.safetynative

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import uniffi.safety.EscalationLevel
import uniffi.safety.TypingSample

/**
 * The one "You okay?" screen, opened from the check-in notification (full-screen on the lock screen), the
 * "friends were told" notification, or JS (`openCheckIn`).
 *
 *  1. What was detected + a countdown, and two buttons. "I need help" works for anyone, locked or not.
 *  2. "I'm OK" proves the owner first: unlocking a secure lock screen (fingerprint / PIN / pattern), or, when the
 *     phone is already unlocked, a BiometricPrompt (strong biometric or device credential). A thief cannot pass it.
 *  3. Then the 3-word phrase, typed and compared with the owner's typing rhythm by the engine: accepted → dismissed;
 *     far off their rhythm → friends are told "answered, but may be impaired".
 *     Once friends hold the location (unlocked) or a grab is running, the phrase is skipped and step 2 dismisses.
 *
 * The phrase is shown only after step 2, and [SafetyRuntime.submitCheckIn] refuses an answer without it.
 * The screen closes itself when the escalation ends (answered, cleared, or a friend marked them safe).
 */
class CheckInActivity : AppCompatActivity() {
  companion object {
    private const val TAG = "CheckInActivity"
    fun intent(ctx: Context) =
      Intent(ctx, CheckInActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    private val BG = Color.parseColor("#0b0d12")
    private val CARD = Color.parseColor("#151924")
    private val TEXT = Color.parseColor("#f3f4f6")
    private val MUTED = Color.parseColor("#8b93a7")
    private val DANGER = Color.parseColor("#ff3b5c")
    private val OK = Color.parseColor("#34d399")
    private val WARN = Color.parseColor("#fbbf24")
  }

  private lateinit var rt: SafetyRuntime
  private lateinit var tracker: TypingTracker
  private lateinit var title: TextView
  private lateinit var what: TextView
  private lateinit var countdown: TextView
  private lateinit var status: TextView
  private lateinit var okBtn: Button
  private lateinit var phraseBox: LinearLayout
  private lateinit var phraseText: TextView
  private lateinit var input: EditText
  private val ui = Handler(Looper.getMainLooper())
  private var phrase = ""
  private var phraseShown = false
  private var busy = false

  private val ticker = object : Runnable {
    override fun run() { refresh(); ui.postDelayed(this, 1_000L) }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    rt = SafetyRuntime.get(this)
    rt.touch.attach(this)
    if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    tracker = TypingTracker({ phrase }) {}
    setContentView(build())
  }

  override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); refresh() }
  override fun onResume() { super.onResume(); ui.post(ticker) }
  override fun onPause() { super.onPause(); ui.removeCallbacks(ticker) }

  // ---- layout --------------------------------------------------------------

  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
  private fun text(sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); setTextColor(color); gravity = Gravity.CENTER
    if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
  }
  private fun button(label: String, color: Int, onClick: () -> Unit) = Button(this).apply {
    text = label; setTextColor(Color.WHITE); isAllCaps = false; setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
    background = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(color) }
    layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56)).apply { topMargin = dp(12) }
    setOnClickListener { onClick() }
  }

  private fun build(): View {
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(dp(24), dp(24), dp(24), dp(24)); setBackgroundColor(BG)
    }
    title = text(30f, TEXT, bold = true).also { root.addView(it) }
    what = text(17f, TEXT).apply { setPadding(0, dp(12), 0, 0) }.also { root.addView(it) }
    countdown = text(15f, MUTED).apply { setPadding(0, dp(8), 0, dp(8)) }.also { root.addView(it) }

    phraseBox = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; visibility = View.GONE; setPadding(dp(16), dp(16), dp(16), dp(16))
      background = GradientDrawable().apply { cornerRadius = dp(16).toFloat(); setColor(CARD) }
      layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) }
    }
    phraseBox.addView(text(14f, MUTED).apply { text = "Type this phrase:" })
    phraseText = text(26f, TEXT, bold = true).apply { setPadding(0, dp(8), 0, dp(8)) }.also { phraseBox.addView(it) }
    input = EditText(this).apply {
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
      imeOptions = EditorInfo.IME_ACTION_DONE; isSingleLine = true; gravity = Gravity.CENTER
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f); setTextColor(TEXT); setHintTextColor(MUTED); hint = "type here"
      addTextChangedListener(tracker)
      setOnEditorActionListener { _, _, _ -> submit(); true }
    }
    phraseBox.addView(input)
    phraseBox.addView(button("Done", OK) { submit() })
    root.addView(phraseBox)

    status = text(15f, WARN).apply { setPadding(0, dp(10), 0, 0) }.also { root.addView(it) }
    okBtn = button("I'm OK", OK) { onOk() }.also { root.addView(it) }
    root.addView(button("I need help", DANGER) { rt.needHelp(); finish() })
    refresh()
    return root
  }

  // ---- state ---------------------------------------------------------------

  private fun level(): EscalationLevel = rt.escalationLevel()
  /** Levels at which the typed phrase is the dismiss (the engine's `push_typing` window). */
  private fun phraseLevel(l: EscalationLevel) = l == EscalationLevel.CHECK || l == EscalationLevel.HEADS_UP

  private fun refresh() {
    val l = level()
    if (l == EscalationLevel.IDLE || l == EscalationLevel.RESOLVED) { finish(); return }
    val check = rt.pendingCheck
    title.text = when (l) {
      EscalationLevel.CHECK -> "You okay?"
      EscalationLevel.HEADS_UP -> "Your friends were told"
      EscalationLevel.UNLOCKED -> "Your friends can see your location"
      else -> "Phone grab detected"
    }
    what.text = (if (l == EscalationLevel.CHECK) check?.summary else rt.escalationSummary.ifBlank { check?.summary })
      ?.ifBlank { null } ?: "Something looked wrong."
    countdown.text = if (l == EscalationLevel.CHECK && check != null) {
      val s = ((check.deadlineMs - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
      "Answer in %d:%02d or your friends will be told".format(s / 60, s % 60)
    } else "Tell them you're OK, or ask for help."
    if (phraseShown && !phraseLevel(l)) { phraseShown = false; phraseBox.visibility = View.GONE; okBtn.visibility = View.VISIBLE }
  }

  // ---- I'm OK: owner proof, then the phrase --------------------------------

  private fun onOk() {
    if (busy) return
    status.text = ""
    if (!rt.deviceSecure()) {
      // No lock screen: nothing can prove the owner. Typing is still checked; friends see it as unverified.
      if (phraseLevel(level())) showPhrase()
      else status.text = "Set a screen lock to cancel alerts yourself. A friend can mark you safe."
      return
    }
    val km = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
    busy = true
    if (km.isKeyguardLocked) {
      // Unlocking a secure lock screen is the owner proof (fingerprint / PIN / pattern).
      km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() { busy = false; verified() }
        override fun onDismissCancelled() { busy = false; status.text = "Unlock your phone to confirm it's you." }
        override fun onDismissError() { busy = false; status.text = "Couldn't unlock. Try again." }
      })
    } else biometric()
  }

  private fun biometric() {
    val auth = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    if (BiometricManager.from(this).canAuthenticate(auth) != BiometricManager.BIOMETRIC_SUCCESS) {
      busy = false; status.text = "Can't confirm it's you on this phone. Ask a friend to mark you safe."; return
    }
    BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) { busy = false; verified() }
      override fun onAuthenticationError(code: Int, msg: CharSequence) { busy = false; status.text = "Not confirmed. Your check-in is still open." }
      override fun onAuthenticationFailed() { /* the prompt lets them retry */ }
    }).authenticate(
      BiometricPrompt.PromptInfo.Builder().setTitle("Confirm it's you").setSubtitle("Before telling your friends you're OK")
        .setAllowedAuthenticators(auth).build(),
    )
  }

  private fun verified() {
    rt.markOwnerVerified()
    val l = level()
    if (phraseLevel(l)) showPhrase()
    else { Log.i(TAG, "owner dismissed at $l"); rt.biometricDismiss(); finish() }
  }

  private fun showPhrase() {
    phrase = rt.pendingCheck?.phrase.orEmpty()
    if (phrase.isBlank()) { status.text = "No open check-in."; return }
    phraseText.text = phrase
    input.setText(""); tracker.reset()
    phraseBox.visibility = View.VISIBLE; okBtn.visibility = View.GONE; phraseShown = true
    input.requestFocus()
  }

  private fun submit() {
    if (!phraseShown || busy) return
    val p = tracker.payload()
    @Suppress("UNCHECKED_CAST")
    val sample = TypingSample(
      phrase, p["typed"] as String, (p["keyTimesMs"] as List<Long>).map { it.toULong() },
      (p["backspaces"] as Int).toUInt(), (p["durationMs"] as Long).toULong(),
    )
    busy = true
    rt.scope.launch {
      val verdict = runCatching { rt.submitCheckIn(sample) }.getOrNull()
      withContext(Dispatchers.Main) {
        busy = false
        if (verdict?.get("accepted") == true) { finish(); return@withContext }
        val reason = verdict?.get("reason")?.toString().orEmpty()
        status.text = when {
          reason.startsWith("wrong phrase") -> "That didn't match. Type the phrase again."
          reason.startsWith("Confirm it's you") -> reason
          reason.isNotBlank() -> "Thanks. Your friends were told you answered but may need a hand."
          else -> "Try again."
        }
        if (reason.startsWith("Confirm it's you")) { phraseShown = false; phraseBox.visibility = View.GONE; okBtn.visibility = View.VISIBLE }
        input.setText(""); tracker.reset()
        refresh()
      }
    }
  }
}
