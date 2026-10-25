package expo.modules.safetynative

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import uniffi.safety.EscalationLevel
import uniffi.safety.UserAction

/** Exact-alarm target for the check-in deadline, plus notification-action handler. */
class AlarmReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_CHECK_TIMEOUT = "expo.modules.safetynative.CHECK_TIMEOUT"
    const val ACTION_NEED_HELP = "expo.modules.safetynative.NEED_HELP"
    const val ACTION_STOP_ALARM = "expo.modules.safetynative.STOP_ALARM"
    const val ACTION_STOP_COLLECT = "expo.modules.safetynative.STOP_COLLECT"

    private fun pi(ctx: Context) = PendingIntent.getBroadcast(
      ctx, 50, Intent(ctx, AlarmReceiver::class.java).setAction(ACTION_CHECK_TIMEOUT),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    fun scheduleCheckTimeout(ctx: Context, deadlineMs: Long) {
      val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val canExact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()
      if (canExact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, deadlineMs, pi(ctx))
      else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, deadlineMs, pi(ctx))
    }
    fun cancelCheckTimeout(ctx: Context) { (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(pi(ctx)) }
  }

  override fun onReceive(context: Context, intent: Intent) {
    val rt = SafetyRuntime.get(context)
    when (intent.action) {
      ACTION_CHECK_TIMEOUT -> if (rt.engine.snapshotOrNull()?.escalation == EscalationLevel.CHECK) {
        rt.alerts.cancelCheckIn()
        rt.pushAction(UserAction.CHECK_TIMEOUT)
      }
      ACTION_NEED_HELP -> rt.needHelp()
      ACTION_STOP_ALARM -> rt.alerts.stopAlarm()
      ACTION_STOP_COLLECT -> rt.stopCollect("stopped on the phone")
    }
  }
}
