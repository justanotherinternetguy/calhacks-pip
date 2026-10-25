package expo.modules.safetynative

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
 *     phone is already unlocked, a BiometricPrompt: face or fingerprint (any biometric Android rates weak or
 *     stronger) or the device credential. A thief cannot pass it.
 *  3. Then the 3-word phrase, typed and compared with the owner's typing rhythm by the engine: accepted → dismissed;
 *     far off their rhythm → friends are told "answered, but may be impaired".
 *     Once friends hold the location (unlocked) or a grab is running, the phrase is skipped and step 2 dismisses.
 *
 * The phrase is shown only after step 2, and [SafetyRuntime.submitCheckIn] refuses an answer without it.
 * The screen closes itself when the escalation ends (answered, cleared, or a friend marked them safe).
 *
 * Looks like the app and the website: lilac while the check-in waits on an answer, coral once friends were told.
 *
 * Debug builds only: `--es preview check|told [--es step phrase]` draws the screen with made-up data and touches
 * nothing in the runtime (every button just closes it). Launch with
 * `adb shell run-as app.safe.mobile am start -n app.safe.mobile/expo.modules.safetynative.CheckInActivity --es preview check`.
 */
class CheckInActivity : AppCompatActivity() {
  companion object {
    private const val TAG = "CheckInActivity"
    fun intent(ctx: Context) =
      Intent(ctx, CheckInActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    // The app's palette (apps/mobile/lib/theme.ts `ht`).
    private val PAPER = Color.parseColor("#FFFCF5")
    private val INK = Color.parseColor("#1E1B2E")
    private val INK_MID = Color.parseColor("#3A3552")
    private val LEDGE = Color.parseColor("#0E0C18")
    private val CREAM = Color.parseColor("#FBF3E4")
    private val LILAC = Color.parseColor("#B69CFF")
    private val CORAL = Color.parseColor("#FF6B5C")
    private val CORAL_DEEP = Color.parseColor("#C43D2E")
    private val TRACK = Color.argb(31, 0x1E, 0x1B, 0x2E)
    private val HINT = Color.argb(110, 0x1E, 0x1B, 0x2E)
  }

  private lateinit var rt: SafetyRuntime
  private lateinit var tracker: TypingTracker
  private lateinit var root: LinearLayout
  private lateinit var column: LinearLayout
  private lateinit var kicker: TextView
  private lateinit var badge: ClockBadge
  private lateinit var title: TextView
  private lateinit var what: TextView
  private lateinit var ring: CountdownRing
  private lateinit var countdown: TextView
  private lateinit var status: TextView
  private lateinit var okBtn: Button
  private lateinit var doneBtn: Button
  private lateinit var helpBtn: Button
  private lateinit var phraseBox: LinearLayout
  private lateinit var words: LinearLayout
  private lateinit var input: EditText
  private val ui = Handler(Looper.getMainLooper())
  private var phrase = ""
  private var phraseShown = false
  private var busy = false
  /** The countdown ring runs from full to empty over the check-in this screen first saw. */
  private var ringDeadline = 0L
  private var ringTotalMs = 1L

  // Debug-only preview (see the class doc): "check" or "told", with a fake check-in.
  private var preview: String? = null
  private var previewCheck: PendingCheck? = null

  private val fonts by lazy { Fonts(this) }

  private val ticker = object : Runnable {
    override fun run() { refresh(); ui.postDelayed(this, 1_000L) }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    readPreview(intent)
    rt = SafetyRuntime.get(this)
    if (preview == null) rt.touch.attach(this)
    if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    // Draw behind the system bars (Android 15+ does anyway) and pad for them and the keyboard ourselves.
    WindowCompat.setDecorFitsSystemWindows(window, false)
    WindowInsetsControllerCompat(window, window.decorView).apply { isAppearanceLightStatusBars = true; isAppearanceLightNavigationBars = true }
    tracker = TypingTracker({ phrase }) {}
    setContentView(build())
    if (preview != null && intent.getStringExtra("step") == "phrase") showPhrase()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent); readPreview(intent)
    refresh()
  }
  override fun onResume() { super.onResume(); ui.post(ticker) }
  override fun onPause() { super.onPause(); ui.removeCallbacks(ticker) }

  private fun readPreview(i: Intent) {
    val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    preview = i.getStringExtra("preview")?.takeIf { debuggable && (it == "check" || it == "told") }
    if (preview != null && previewCheck == null) {
      previewCheck = PendingCheck("maple orbit tulip", System.currentTimeMillis() + 120_000L, "A possible fall, then no movement.")
    }
  }

  // ---- layout --------------------------------------------------------------

  private fun dp(v: Float) = v * resources.displayMetrics.density
  private fun dp(v: Int) = dp(v.toFloat()).toInt()

  private fun text(sp: Float, color: Int, face: Typeface, gravity: Int = Gravity.CENTER) = TextView(this).apply {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); setTextColor(color); typeface = face; this.gravity = gravity
    includeFontPadding = false
  }

  private fun pill(fill: Int, stroke: Int, radius: Float) = GradientDrawable().apply {
    cornerRadius = radius; setColor(fill); if (stroke != Color.TRANSPARENT) setStroke(dp(2), stroke)
  }

  /** A pill resting on a ledge; pressing it sinks the face onto the ledge, as the app's buttons do. */
  private fun ledged(fill: Int, ledge: Int, radius: Float): Drawable {
    val l = dp(3)
    fun layers(sunk: Boolean) = LayerDrawable(arrayOf(pill(ledge, Color.TRANSPARENT, radius), pill(fill, INK, radius))).apply {
      setLayerInset(0, 0, l, 0, 0)
      if (sunk) setLayerInset(1, 0, l, 0, 0) else setLayerInset(1, 0, 0, 0, l)
    }
    return StateListDrawable().apply {
      addState(intArrayOf(android.R.attr.state_pressed), layers(sunk = true))
      addState(intArrayOf(), layers(sunk = false))
    }
  }

  private fun button(label: String, fill: Int, fg: Int, ledge: Int, onClick: () -> Unit) = Button(this).apply {
    text = label; setTextColor(fg); isAllCaps = false; typeface = fonts.displaySemi
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f); letterSpacing = 0.01f
    stateListAnimator = null; minHeight = 0; minimumHeight = 0; minWidth = 0; minimumWidth = 0
    background = ledged(fill, ledge, dp(30f))
    setPadding(dp(16), 0, dp(16), dp(3))
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(55)).apply { topMargin = dp(10) }
    setOnClickListener { onClick() }
  }

  private fun lp(w: Int = ViewGroup.LayoutParams.WRAP_CONTENT, top: Int = 0) =
    LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top); gravity = Gravity.CENTER_HORIZONTAL }

  private fun build(): View {
    root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(LILAC) }

    column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
    val scroll = ScrollView(this).apply {
      isFillViewport = true; isVerticalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER
      addView(column, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

    kicker = text(12.5f, INK_MID, fonts.displaySemi).apply { text = "PIP · CHECK-IN"; letterSpacing = 0.08f }
    column.addView(kicker, lp(top = 22))
    badge = ClockBadge(this).also { column.addView(it, LinearLayout.LayoutParams(dp(74), dp(74)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(10) }) }
    title = text(44f, INK, fonts.displayBold).apply { letterSpacing = -0.01f; setLineSpacing(0f, 0.95f) }
    column.addView(title, lp(ViewGroup.LayoutParams.MATCH_PARENT, top = 14))
    what = text(15.5f, INK_MID, fonts.body).apply { setLineSpacing(dp(3f), 1f) }
    column.addView(what, lp(ViewGroup.LayoutParams.MATCH_PARENT, top = 10))
    ring = CountdownRing(this).also { column.addView(it, LinearLayout.LayoutParams(dp(124), dp(124)).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(24) }) }
    countdown = text(13.5f, INK_MID, fonts.displaySemi)
    column.addView(countdown, lp(ViewGroup.LayoutParams.MATCH_PARENT, top = 12))

    phraseBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; visibility = View.GONE }
    phraseBox.addView(text(13.5f, INK_MID, fonts.displaySemi).apply { text = "Type these words" }, lp())
    words = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
    phraseBox.addView(words, lp(ViewGroup.LayoutParams.MATCH_PARENT, top = 10))
    input = EditText(this).apply {
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
      imeOptions = EditorInfo.IME_ACTION_DONE; isSingleLine = true; gravity = Gravity.CENTER
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f); setTextColor(INK); setHintTextColor(HINT); hint = "type here…"
      typeface = fonts.mono
      background = pill(PAPER, INK, dp(16f))
      setPadding(dp(16), 0, dp(16), 0)
      addTextChangedListener(tracker)
      setOnEditorActionListener { _, _, _ -> submit(); true }
    }
    phraseBox.addView(input, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54)).apply { topMargin = dp(14) })
    column.addView(phraseBox, lp(ViewGroup.LayoutParams.MATCH_PARENT, top = 24))

    status = text(14.5f, CORAL_DEEP, fonts.bodySemi).apply { setLineSpacing(dp(2f), 1f) }
    column.addView(status, lp(ViewGroup.LayoutParams.MATCH_PARENT, top = 14))
    column.addView(View(this), LinearLayout.LayoutParams(1, dp(16)))

    // The answers stay at the bottom, under the thumb.
    val actions = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(4), 0, 0) }
    okBtn = button("I’m OK", INK, CREAM, LEDGE) { if (preview != null) previewOk() else onOk() }.also { actions.addView(it) }
    doneBtn = button("Done", INK, CREAM, LEDGE) { if (preview != null) finish() else submit() }.apply { visibility = View.GONE }.also { actions.addView(it) }
    helpBtn = button("I need help", CORAL, INK, INK) { if (preview != null) finish() else { rt.needHelp(); finish() } }.also { actions.addView(it) }
    root.addView(actions, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left + dp(22), bars.top + dp(12), bars.right + dp(22), maxOf(bars.bottom, ime.bottom) + dp(18))
      insets
    }
    refresh()
    return root
  }

  private fun setWords(p: String) {
    words.removeAllViews()
    p.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.forEachIndexed { i, w ->
      val chip = text(16f, INK, fonts.mono).apply {
        text = w; setPadding(dp(11), dp(8), dp(11), dp(8))
        background = GradientDrawable().apply { cornerRadius = dp(10f); setColor(PAPER); setStroke(dp(1.5f).toInt().coerceAtLeast(2), INK) }
      }
      words.addView(chip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { if (i > 0) leftMargin = dp(7) })
    }
  }

  private fun setPhraseVisible(on: Boolean) {
    phraseShown = on
    phraseBox.visibility = if (on) View.VISIBLE else View.GONE
    okBtn.visibility = if (on) View.GONE else View.VISIBLE
    doneBtn.visibility = if (on) View.VISIBLE else View.GONE
  }

  // ---- state ---------------------------------------------------------------

  private fun level(): EscalationLevel = when (preview) {
    "check" -> EscalationLevel.CHECK
    "told" -> EscalationLevel.HEADS_UP
    else -> rt.escalationLevel()
  }
  private fun pending(): PendingCheck? = if (preview != null) previewCheck else rt.pendingCheck
  /** Levels at which the typed phrase is the dismiss (the engine's `push_typing` window). */
  private fun phraseLevel(l: EscalationLevel) = l == EscalationLevel.CHECK || l == EscalationLevel.HEADS_UP

  private fun refresh() {
    val l = level()
    if (l == EscalationLevel.IDLE || l == EscalationLevel.RESOLVED) { finish(); return }
    val check = pending()
    val asking = l == EscalationLevel.CHECK
    val bg = if (asking) LILAC else CORAL
    root.setBackgroundColor(bg)
    window.decorView.setBackgroundColor(bg)
    kicker.visibility = if (asking) View.VISIBLE else View.GONE
    badge.visibility = if (asking) View.GONE else View.VISIBLE
    // The check-in sits at the top under its kicker; "friends were told" is a centred notice.
    column.gravity = if (asking || phraseShown) Gravity.CENTER_HORIZONTAL else Gravity.CENTER
    title.text = when (l) {
      EscalationLevel.CHECK -> "You okay?"
      EscalationLevel.HEADS_UP, EscalationLevel.UNLOCKED -> "Your friends were told"
      else -> "Phone grab detected"
    }
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (!asking) 30f else if (phraseShown) 36f else 44f)
    // Typing needs the room above the keyboard: the clock shrinks but keeps counting.
    val ringSize = dp(if (phraseShown) 84 else 124)
    (ring.layoutParams as LinearLayout.LayoutParams).let { if (it.width != ringSize) { it.width = ringSize; it.height = ringSize; it.topMargin = dp(if (phraseShown) 14 else 24); ring.layoutParams = it } }
    what.text = (if (asking) check?.summary else (if (preview != null) null else rt.escalationSummary).orEmpty().ifBlank { check?.summary })
      ?.ifBlank { null } ?: "Something looked wrong."
    if (asking && check != null) {
      if (check.deadlineMs != ringDeadline) { ringDeadline = check.deadlineMs; ringTotalMs = (check.deadlineMs - System.currentTimeMillis()).coerceAtLeast(1L) }
      val leftMs = (check.deadlineMs - System.currentTimeMillis()).coerceAtLeast(0)
      val s = leftMs / 1000
      ring.visibility = View.VISIBLE
      ring.set("%d:%02d".format(s / 60, s % 60), (leftMs.toFloat() / ringTotalMs).coerceIn(0f, 1f))
      ring.contentDescription = "Answer in %d minutes %d seconds or your friends get a heads-up".format(s / 60, s % 60)
      countdown.text = "until your friends get a heads-up"
      countdown.visibility = if (phraseShown) View.GONE else View.VISIBLE
    } else {
      ring.visibility = View.GONE
      countdown.visibility = if (phraseShown) View.GONE else View.VISIBLE
      countdown.text = when (l) {
        EscalationLevel.UNLOCKED -> "They can see your location now. Tap I’m OK if you’re fine."
        EscalationLevel.HEADS_UP -> "Tap I’m OK if you’re fine."
        else -> "Tell them you’re OK, or ask for help."
      }
    }
    countdown.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (asking) 13.5f else 15.5f)
    countdown.typeface = if (asking) fonts.displaySemi else fonts.body
    status.setTextColor(if (asking) CORAL_DEEP else INK)
    // Coral on coral would vanish: once friends were told, "I need help" turns paper.
    if (helpBtn.tag != asking) { helpBtn.tag = asking; helpBtn.background = ledged(if (asking) CORAL else PAPER, INK, dp(30f)) }
    if (phraseShown && !phraseLevel(l)) setPhraseVisible(false)
  }

  private fun previewOk() {
    if (phraseLevel(level())) showPhrase() else finish()
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
    // WEAK admits face unlock (most phones rate it class 2); fingerprint is STRONG, which WEAK includes. The snatch /
    // SOS stand-down (SosManager) stays STRONG-only: someone holding the phone up to the owner must not stop it.
    val auth = BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    if (BiometricManager.from(this).canAuthenticate(auth) != BiometricManager.BIOMETRIC_SUCCESS) {
      busy = false; status.text = "Can't confirm it's you on this phone. Ask a friend to mark you safe."; return
    }
    BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) { busy = false; verified() }
      override fun onAuthenticationError(code: Int, msg: CharSequence) { busy = false; status.text = "Not confirmed. Your check-in is still open." }
      override fun onAuthenticationFailed() { /* the prompt lets them retry */ }
    }).authenticate(
      BiometricPrompt.PromptInfo.Builder().setTitle("Confirm it's you").setSubtitle("Use your face, fingerprint or PIN before telling your friends you're OK")
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
    phrase = pending()?.phrase.orEmpty()
    if (phrase.isBlank()) { status.text = "No open check-in."; return }
    setWords(phrase)
    input.setText(""); tracker.reset()
    setPhraseVisible(true)
    refresh()
    input.requestFocus()
  }

  private fun submit() {
    if (!phraseShown || busy) return
    if (preview != null) { finish(); return }
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
          reason.isNotBlank() -> "Thanks. Your friends know you answered but may need a hand."
          else -> "Try again."
        }
        if (reason.startsWith("Confirm it's you")) setPhraseVisible(false)
        input.setText(""); tracker.reset()
        refresh()
      }
    }
  }
}

/** The bundled faces: Fredoka for headings and buttons, Figtree for sentences, DM Mono for the clock and the words. */
private class Fonts(ctx: Context) {
  private fun load(ctx: Context, name: String, fallback: Typeface) =
    runCatching { Typeface.createFromAsset(ctx.assets, "fonts/$name.ttf") }.getOrElse { fallback }
  val displayBold = load(ctx, "Fredoka-Bold", Typeface.DEFAULT_BOLD)
  val displaySemi = load(ctx, "Fredoka-SemiBold", Typeface.DEFAULT_BOLD)
  val body = load(ctx, "Figtree-Regular", Typeface.DEFAULT)
  val bodySemi = load(ctx, "Figtree-SemiBold", Typeface.DEFAULT_BOLD)
  val mono = load(ctx, "DMMono-Medium", Typeface.MONOSPACE)
}

/** The check-in clock: a paper disc, a faint track, and an ink arc that empties as the answer window runs out. */
private class CountdownRing(ctx: Context) : View(ctx) {
  private val d = resources.displayMetrics.density
  private val stroke = 9f * d
  private val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#FFFCF5") }
  private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = stroke; color = Color.argb(31, 0x1E, 0x1B, 0x2E) }
  private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = stroke; strokeCap = Paint.Cap.ROUND; color = Color.parseColor("#1E1B2E") }
  private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.parseColor("#1E1B2E"); textAlign = Paint.Align.CENTER
    typeface = runCatching { Typeface.createFromAsset(ctx.assets, "fonts/DMMono-Medium.ttf") }.getOrElse { Typeface.MONOSPACE }
  }
  private val box = RectF()
  private var text = ""
  private var fraction = 1f

  fun set(t: String, f: Float) { if (t != text || f != fraction) { text = t; fraction = f; invalidate() } }

  override fun onDraw(c: Canvas) {
    val cx = width / 2f; val cy = height / 2f
    val r = minOf(width, height) / 2f - stroke / 2f
    label.textSize = minOf(width, height) * 0.22f
    box.set(cx - r, cy - r, cx + r, cy + r)
    c.drawCircle(cx, cy, r, disc)
    c.drawCircle(cx, cy, r, track)
    if (fraction > 0f) c.drawArc(box, -90f, 360f * fraction, false, arc)
    c.drawText(text, cx, cy - (label.descent() + label.ascent()) / 2f, label)
  }
}

/** "Friends were told": a paper disc in an ink ring with a clock drawn in ink. */
private class ClockBadge(ctx: Context) : View(ctx) {
  private val d = resources.displayMetrics.density
  private val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#FFFCF5") }
  private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2.5f * d; color = Color.parseColor("#1E1B2E") }
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE; strokeWidth = 3f * d; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; color = Color.parseColor("#1E1B2E")
  }

  override fun onDraw(c: Canvas) {
    val cx = width / 2f; val cy = height / 2f
    val r = minOf(width, height) / 2f - ring.strokeWidth / 2f
    c.drawCircle(cx, cy, r, disc)
    c.drawCircle(cx, cy, r, ring)
    // The site's clock icon on a 24 grid: a circle of radius 8 and hands to 12 o'clock and about 4.
    val u = 36f * d / 24f
    c.drawCircle(cx, cy, 8f * u, line)
    c.drawLine(cx, cy - 5f * u, cx, cy, line)
    c.drawLine(cx, cy, cx + 3f * u, cy + 2f * u, line)
  }
}
