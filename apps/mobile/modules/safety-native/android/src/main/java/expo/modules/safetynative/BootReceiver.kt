package expo.modules.safetynative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * After a reboot (or app update) the service restarts WITHOUT microphone access: Android 14+ does
 * not let a microphone-type foreground service start from the background. We post a "tap to re-arm"
 * notification; opening the app calls `configure`, which restarts the service with mic allowed.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action !in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_LOCKED_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) return
    val rt = SafetyRuntime.get(context)
    if (!rt.configured) return
    rt.startService(allowMic = false)
    if (PermissionHelper.microphone(context)) rt.alerts.showRearm()
  }
}
