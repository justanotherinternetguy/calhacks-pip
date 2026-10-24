package expo.modules.safetynative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

/** Activity Recognition transitions → engine Context.activity (+ daytime baseline sampling). */
class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!ActivityTransitionResult.hasResult(intent)) return
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val last = result.transitionEvents.lastOrNull() ?: return
    val type = if (last.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER) last.activityType else DetectedActivity.UNKNOWN
    SensingService.sendAction(context, SensingService.ACTION_ACTIVITY) { it.putExtra(SensingService.EXTRA_ACTIVITY, type) }
  }
}
