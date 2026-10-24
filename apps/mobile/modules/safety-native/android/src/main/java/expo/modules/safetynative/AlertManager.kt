package expo.modules.safetynative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.sin

/**
 * Notification channels, the check-in prompt (full-screen intent → CheckInActivity), the loud
 * remote-ring alarm, and the push fan-out helper (incident_events row + functions/v1/push).
 */
class AlertManager(private val ctx: Context, private val rt: SafetyRuntime) {
  companion object {
    const val CH_SENSING = "sensing"
    const val CH_CHECKIN = "checkin"
    const val CH_ALARM = "alarm"
    const val NOTIF_SERVICE = 1001
    const val NOTIF_CHECKIN = 1002
    const val NOTIF_ALARM = 1003
    const val NOTIF_REARM = 1004
    private const val TAG = "AlertManager"
  }

  private val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  private var alarmTrack: AudioTrack? = null
  private var alarmJob: Job? = null

  init { createChannels() }

  private fun createChannels() {
    nm.createNotificationChannel(
      NotificationChannel(CH_SENSING, "Safety sensing", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Keeps the safety service running"; setShowBadge(false)
      },
    )
    nm.createNotificationChannel(
      NotificationChannel(CH_CHECKIN, "Check-ins", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Asks whether you're okay"; enableVibration(true); lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      },
    )
    nm.createNotificationChannel(
      NotificationChannel(CH_ALARM, "Friend alarm", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Rings loudly when a friend tries to reach you"
        setBypassDnd(true); enableVibration(true)
        setSound(
          android.provider.Settings.System.DEFAULT_ALARM_ALERT_URI,
          AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
        )
      },
    )
  }

  private fun flags() = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  fun launcherIntent(): PendingIntent? {
    val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
    return PendingIntent.getActivity(ctx, 10, i, flags())
  }

  /** Persistent low-priority notification required by the foreground service. */
  fun serviceNotification(night: Boolean): Notification =
    NotificationCompat.Builder(ctx, CH_SENSING)
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setContentTitle(if (night) "Night mode on" else "Safety is on standby")
      .setContentText(if (night) "Watching out for you tonight" else "Starts automatically when you head out")
      .setOngoing(true).setSilent(true).setContentIntent(launcherIntent())
      .setCategory(NotificationCompat.CATEGORY_SERVICE).build()

  /** "You okay?" — full-screen on the lock screen; opening it requires unlocking the phone. */
  fun showCheckIn(phrase: String, deadlineMs: Long) {
    val full = PendingIntent.getActivity(ctx, 20, CheckInActivity.intent(ctx, phrase, deadlineMs), flags())
    val help = PendingIntent.getBroadcast(ctx, 21, Intent(ctx, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_NEED_HELP), flags())
    val n = NotificationCompat.Builder(ctx, CH_CHECKIN)
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle("You okay?")
      .setContentText("Tap and type the phrase to let us know you're fine")
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setFullScreenIntent(full, true)
      .setContentIntent(full)
      .setAutoCancel(true)
      .setTimeoutAfter((deadlineMs - System.currentTimeMillis()).coerceAtLeast(10_000L))
      .addAction(0, "I'm fine", full)
      .addAction(0, "I need help", help)
      .build()
    nm.notify(NOTIF_CHECKIN, n)
  }

  fun cancelCheckIn() = nm.cancel(NOTIF_CHECKIN)

  /** Posted after a reboot: the service is up but the mic may not be used until the user opens the app. */
  fun showRearm() {
    val n = NotificationCompat.Builder(ctx, CH_CHECKIN)
      .setSmallIcon(android.R.drawable.ic_dialog_alert)
      .setContentTitle("Tap to re-arm sound detection")
      .setContentText("Your phone restarted. Open the app once so night mode can use the microphone again.")
      .setContentIntent(launcherIntent()).setAutoCancel(true).build()
    nm.notify(NOTIF_REARM, n)
  }
  fun cancelRearm() = nm.cancel(NOTIF_REARM)

  // ---- remote ring -------------------------------------------------------

  /** Loud looping tone on the alarm stream at max volume. Synthesized, so no raw asset is needed. */
  fun ringAlarm(seconds: Int) {
    stopAlarm()
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val prevVol = am.getStreamVolume(AudioManager.STREAM_ALARM)
    runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0) }

    val rate = 44100
    val tone = ShortArray(rate) // 1 s: 0.5 s 880 Hz beep + 0.5 s silence
    for (i in 0 until rate / 2) tone[i] = (sin(2.0 * PI * 880.0 * i / rate) * Short.MAX_VALUE * 0.9).toInt().toShort()
    val track = AudioTrack.Builder()
      .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
      .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
      .setBufferSizeInBytes(tone.size * 2).setTransferMode(AudioTrack.MODE_STATIC).build()
    track.write(tone, 0, tone.size)
    track.setLoopPoints(0, tone.size, -1)
    track.play()
    alarmTrack = track

    val stopIntent = PendingIntent.getBroadcast(ctx, 30, Intent(ctx, AlarmReceiver::class.java).setAction(AlarmReceiver.ACTION_STOP_ALARM), flags())
    nm.notify(
      NOTIF_ALARM,
      NotificationCompat.Builder(ctx, CH_ALARM).setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle("A friend is trying to reach you").setContentText("Tap to silence")
        .setCategory(NotificationCompat.CATEGORY_ALARM).setPriority(NotificationCompat.PRIORITY_MAX)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC).setOngoing(true)
        .setContentIntent(stopIntent).setDeleteIntent(stopIntent).addAction(0, "Silence", stopIntent).build(),
    )
    alarmJob = rt.scope.launch {
      delay(seconds.coerceIn(5, 300) * 1000L)
      if (isActive) stopAlarm()
      runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, prevVol, 0) }
    }
  }

  fun stopAlarm() {
    alarmJob?.cancel(); alarmJob = null
    alarmTrack?.let { runCatching { it.stop(); it.release() } }
    alarmTrack = null
    nm.cancel(NOTIF_ALARM)
  }

  // ---- fan-out -----------------------------------------------------------

  /** Writes an incident_events row and asks the `push` function to notify the group (APNs/FCM). */
  suspend fun pushToGroup(incidentId: String?, kind: String, title: String, body: String, critical: Boolean) {
    val cfg = rt.prefs.serverConfig ?: return
    rt.io {
      runCatching {
        if (incidentId != null) {
          rt.supabase.insert(
            "incident_events",
            JSONObject().put("incident_id", incidentId).put("actor_id", cfg.userId).put("kind", kind)
              .put("payload", JSONObject().put("title", title).put("body", body)),
          )
        }
        rt.supabase.function(
          "push",
          JSONObject().put("incidentId", incidentId).put("kind", kind).put("title", title).put("body", body)
            .put("critical", critical).put("recipients", JSONArray(rt.escrow.memberUserIds()))
            .put("data", JSONObject().put("subjectUserId", cfg.userId)),
        )
      }.onFailure { Log.w(TAG, "push $kind failed", it) }
    }
  }
}
