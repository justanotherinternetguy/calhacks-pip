package expo.modules.safetynative

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** Snapshot of the permissions the facade reports in `Status.permissions`. */
object PermissionHelper {
  fun granted(ctx: Context, perm: String) = ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

  fun locationAlways(ctx: Context) =
    granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) &&
      (Build.VERSION.SDK_INT < 29 || granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION))

  fun motion(ctx: Context) = Build.VERSION.SDK_INT < 29 || granted(ctx, Manifest.permission.ACTIVITY_RECOGNITION)
  fun microphone(ctx: Context) = granted(ctx, Manifest.permission.RECORD_AUDIO)
  fun notifications(ctx: Context) = NotificationManagerCompat.from(ctx).areNotificationsEnabled()
  fun batteryUnrestricted(ctx: Context) =
    (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(ctx.packageName)

  private fun s(b: Boolean) = if (b) "granted" else "denied"

  fun current(ctx: Context): Map<String, String> = mapOf(
    "locationAlways" to s(locationAlways(ctx)),
    "motion" to s(motion(ctx)),
    "microphone" to s(microphone(ctx)),
    "notifications" to s(notifications(ctx)),
    "batteryUnrestricted" to s(batteryUnrestricted(ctx)),
  )
}
