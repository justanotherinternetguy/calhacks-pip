package expo.modules.safetynative

import android.util.Log
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/**
 * Receives every FCM message (registered above expo-notifications' own service, which the manifest removes).
 * Our pushes (`data.pip == "1"`, supabase/functions/_shared/push.ts) are data-only, so Android delivers them here
 * even in the background or after the app was swiped away, and we post them as sticky notifications
 * ([FriendAlerts]). Anything else goes to expo-notifications unchanged; token rotation too.
 */
class PipMessagingService : ExpoFirebaseMessagingService() {
  companion object { private const val TAG = "PipMessaging" }

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val d = remoteMessage.data
    if (d["pip"] != "1") return super.onMessageReceived(remoteMessage)
    val rt = SafetyRuntime.get(applicationContext)
    val kind = d["kind"].orEmpty()
    val title = d["title"].orEmpty()
    val body = d["body"].orEmpty()
    val incidentId = d["incidentId"]
    val checkInId = d["checkInId"]
    Log.i(TAG, "push kind=$kind incident=${incidentId?.take(8)} checkIn=${checkInId?.take(8)}")
    runCatching {
      when {
        kind == "checkin_request" && checkInId != null ->
          rt.friendAlerts.showRequest(checkInId, title, body, d["deadlineMs"]?.toLongOrNull() ?: 0L)
        kind == "checkin_answered" && checkInId != null -> {
          rt.friendAlerts.resolve("out:$checkInId")
          rt.alerts.showInfo(title, body)
        }
        kind == "checkin_cancelled" && checkInId != null -> rt.friendAlerts.resolve("in:$checkInId")
        kind == "incident_resolved" && incidentId != null -> rt.friendAlerts.resolve("inc:$incidentId")
        kind == "ring" -> rt.alerts.ringAlarm(30)
        incidentId != null -> rt.friendAlerts.showAlert(incidentId, title, body, d["critical"] == "true")
        else -> rt.alerts.showInfo(title, body)
      }
    }.onFailure { Log.e(TAG, "handling $kind failed", it) }
    // Let a running app refresh at once (it also reconciles on its own).
    rt.emit("pushReceived", d.toMap())
  }
}
