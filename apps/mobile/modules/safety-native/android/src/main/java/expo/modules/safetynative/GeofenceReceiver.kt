package expo.modules.safetynative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

/** Home geofence enter/exit → night-mode controller. */
class GeofenceReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val ev = GeofencingEvent.fromIntent(intent) ?: return
    if (ev.hasError()) { Log.w("GeofenceReceiver", "geofence error ${ev.errorCode}"); return }
    val away = when (ev.geofenceTransition) {
      Geofence.GEOFENCE_TRANSITION_EXIT -> true
      Geofence.GEOFENCE_TRANSITION_ENTER, Geofence.GEOFENCE_TRANSITION_DWELL -> false
      else -> return
    }
    SensingService.sendAction(context, SensingService.ACTION_GEOFENCE) { it.putExtra(SensingService.EXTRA_AWAY, away) }
  }
}
