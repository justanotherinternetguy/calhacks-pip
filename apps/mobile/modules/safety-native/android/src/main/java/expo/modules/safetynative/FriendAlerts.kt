package expo.modules.safetynative

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Sticky friend notifications (persistent until handled):
 *   in:<checkInId>   a friend asks "You okay?"          I'm OK (unlock first) · I need help — until answered / cancelled
 *   out:<checkInId>  I asked a friend, waiting           low priority — until they answer or it is missed
 *   inc:<incidentId> a friend's alert (heads-up, SOS, missed check-in, offline…) — until the incident resolves
 *
 * Android 14+ lets the user swipe away even "ongoing" notifications, so every one carries a delete intent that
 * re-posts it silently while it is still open. A ledger in Prefs remembers what is open, so [repostAll] restores
 * everything after a reboot and [sync] reconciles with the server (lib/native.ts calls it after every refresh).
 * Posted from pushes by [PipMessagingService], so it works with the app swiped away.
 */
class FriendAlerts(private val ctx: Context, private val rt: SafetyRuntime) {
  companion object {
    const val CH_FRIEND = "friend"
    const val CH_WAITING = "friend_waiting"
    const val NOTIF_ID = 2000
    private const val LEDGER = "sticky_ledger"
    private const val TAG = "FriendAlerts"
  }

  data class Item(val key: String, val title: String, val body: String, val deadlineMs: Long, val critical: Boolean) {
    val kind: String get() = key.substringBefore(':')
    val id: String get() = key.substringAfter(':')
    fun json(): JSONObject = JSONObject().put("title", title).put("body", body).put("deadlineMs", deadlineMs).put("critical", critical)
  }

  private val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  init {
    nm.createNotificationChannel(
      NotificationChannel(CH_FRIEND, "Friends checking in", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "A friend asks if you're okay, or a friend may need you. Stays until it is handled."
        enableVibration(true); lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
      },
    )
    nm.createNotificationChannel(
      NotificationChannel(CH_WAITING, "Waiting for a friend's answer", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shows while a friend has not answered your check-in yet"; setShowBadge(false)
      },
    )
  }

  // ---- ledger --------------------------------------------------------------

  @Synchronized private fun ledger(): JSONObject = rt.prefs.getString(LEDGER)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
  @Synchronized private fun saveLedger(o: JSONObject) = rt.prefs.putString(LEDGER, o.toString())

  @Synchronized
  fun items(): List<Item> {
    val o = ledger()
    return o.keys().asSequence().map { k ->
      val j = o.getJSONObject(k)
      Item(k, j.optString("title"), j.optString("body"), j.optLong("deadlineMs", 0L), j.optBoolean("critical", false))
    }.toList()
  }

  fun isOpen(key: String): Boolean = ledger().has(key)

  // ---- show / resolve ------------------------------------------------------

  fun showRequest(checkInId: String, title: String, body: String, deadlineMs: Long) = open(Item("in:$checkInId", title, body, deadlineMs, true))
  fun showWaiting(checkInId: String, name: String, deadlineMs: Long) =
    open(Item("out:$checkInId", "Waiting for $name", "You asked if they're okay. Your group is alerted if they don't answer.", deadlineMs, false))
  fun showAlert(incidentId: String, title: String, body: String, critical: Boolean) = open(Item("inc:$incidentId", title, body, 0L, critical))

  @Synchronized
  private fun open(item: Item, alert: Boolean = true) {
    val o = ledger()
    val same = o.optJSONObject(item.key)?.toString() == item.json().toString()
    o.put(item.key, item.json()); saveLedger(o)
    post(item, silent = !alert || same)
    rt.sensing?.refreshServiceNotification()
  }

  @Synchronized
  fun resolve(key: String) {
    val o = ledger()
    o.remove(key); saveLedger(o)
    nm.cancel(key, NOTIF_ID)
    rt.sensing?.refreshServiceNotification()
  }

  /** Delete intent: the user swiped it away while it is still open ⇒ back, silently. */
  fun repost(key: String) {
    val item = items().firstOrNull { it.key == key } ?: return
    post(item, silent = true)
  }

  fun repostAll() = items().forEach { post(it, silent = true) }

  /**
   * Server truth from the app: [want] = every item that should be open now. New ones are posted with sound (their
   * push may never have arrived), changed ones silently, stale ones resolved.
   */
  fun sync(want: List<Item>) {
    val have = items().associateBy { it.key }
    val keys = want.map { it.key }.toSet()
    for (k in have.keys - keys) resolve(k)
    for (w in want) {
      val h = have[w.key]
      if (h == null) open(w, alert = w.kind != "out") else if (h != w) open(w, alert = false) else post(w, silent = true)
    }
  }

  /** One line for the always-on service notification, or null when nothing is open. */
  fun summary(): String? {
    val all = items()
    val asked = all.filter { it.kind == "in" }
    val waiting = all.filter { it.kind == "out" }
    val alerts = all.filter { it.kind == "inc" }
    return when {
      asked.isNotEmpty() -> asked.first().title
      alerts.isNotEmpty() -> alerts.first().title
      waiting.size == 1 -> waiting.first().title
      waiting.size > 1 -> "Waiting for ${waiting.size} friends to answer"
      else -> null
    }
  }

  // ---- posting -------------------------------------------------------------

  private fun flags() = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
  private fun rc(key: String, n: Int) = (key.hashCode() * 31) + n

  /** Opens an expo-router route (scheme `safe`, app.config.ts) in the app. */
  private fun route(path: String, key: String): PendingIntent {
    val i = Intent(Intent.ACTION_VIEW, Uri.parse("safe://$path")).setPackage(ctx.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(ctx, rc(key, 1), i, flags())
  }

  private fun broadcast(action: String, key: String, n: Int): PendingIntent =
    PendingIntent.getBroadcast(ctx, rc(key, n), Intent(ctx, StickyReceiver::class.java).setAction(action).putExtra("key", key), flags())

  private fun post(item: Item, silent: Boolean) {
    val path = when (item.kind) { "inc" -> "incident/${item.id}"; else -> "checkin/${item.id}" }
    val b = NotificationCompat.Builder(ctx, if (item.kind == "out") CH_WAITING else CH_FRIEND)
      .setSmallIcon(if (item.kind == "out") android.R.drawable.ic_menu_recent_history else android.R.drawable.ic_dialog_alert)
      .setContentTitle(item.title).setContentText(item.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(item.body))
      .setOngoing(true).setAutoCancel(false).setOnlyAlertOnce(true).setSilent(silent)
      .setContentIntent(route(path, item.key))
      .setDeleteIntent(broadcast(StickyReceiver.ACTION_REPOST, item.key, 2))
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setPriority(if (item.kind == "out") NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_MAX)
      .setCategory(if (item.kind == "out") NotificationCompat.CATEGORY_STATUS else NotificationCompat.CATEGORY_MESSAGE)
    if (item.deadlineMs > 0 && item.kind != "inc") b.setWhen(item.deadlineMs).setUsesChronometer(true).setChronometerCountDown(true).setShowWhen(true)
    if (item.kind == "in") {
      val ok = NotificationCompat.Action.Builder(0, "I'm OK", broadcast(StickyReceiver.ACTION_CHECKIN_OK, item.key, 3))
        .setAuthenticationRequired(true) // Android 12+: unlock first, so a stranger holding the phone can't answer
        .build()
      b.addAction(ok).addAction(0, "I need help", broadcast(StickyReceiver.ACTION_CHECKIN_HELP, item.key, 4))
    }
    if (item.kind == "inc") b.addAction(0, "Open", route(path, item.key))
    runCatching { nm.notify(item.key, NOTIF_ID, b.build()) }.onFailure { Log.w(TAG, "post ${item.key} failed", it) }
  }

  // ---- answering from the notification (works with the app swiped away) ----

  /** Calls functions/v1/checkin as the signed-in user; on success the sticky goes. */
  fun answer(key: String, status: String, onDone: () -> Unit) {
    val id = key.substringAfter(':')
    rt.scope.launch {
      val ok = runCatching {
        rt.io { rt.supabase.function("checkin", JSONObject().put("action", "answer").put("checkInId", id).put("status", status)) }
      }.onFailure { Log.w(TAG, "answer $status for ${id.take(8)} failed", it) }.isSuccess
      if (ok) {
        resolve(key)
        if (status == "ok") {
          rt.alerts.showInfo("Sent", "Your friend knows you're okay.")
          rt.noteOwnerOk("tapped")
        }
      } else {
        open(items().firstOrNull { it.key == key }?.copy(body = "Couldn't send your answer (no connection?). Tap to open the app and try again.") ?: return@launch, alert = true)
      }
      onDone()
    }
  }
}

/** Notification actions + delete intents for [FriendAlerts]. */
class StickyReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_REPOST = "expo.modules.safetynative.STICKY_REPOST"
    const val ACTION_CHECKIN_OK = "expo.modules.safetynative.FRIEND_CHECKIN_OK"
    const val ACTION_CHECKIN_HELP = "expo.modules.safetynative.FRIEND_CHECKIN_HELP"
  }

  override fun onReceive(context: Context, intent: Intent) {
    val rt = SafetyRuntime.get(context)
    val key = intent.getStringExtra("key") ?: return
    when (intent.action) {
      ACTION_REPOST -> rt.friendAlerts.repost(key)
      ACTION_CHECKIN_OK -> { val p = goAsync(); rt.friendAlerts.answer(key, "ok") { p.finish() } }
      ACTION_CHECKIN_HELP -> {
        // Raise the SOS on the phone first (location release lives here), then tell the asker.
        rt.needHelp()
        val p = goAsync(); rt.friendAlerts.answer(key, "help") { p.finish() }
      }
    }
  }
}
