package expo.modules.safetynative

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/** Home/lock-screen widget: tap → manual SOS via the foreground service. */
class SosWidget : AppWidgetProvider() {
  companion object { const val ACTION_WIDGET_SOS = "expo.modules.safetynative.WIDGET_SOS" }

  override fun onUpdate(context: Context, mgr: AppWidgetManager, ids: IntArray) {
    val tap = PendingIntent.getBroadcast(
      context, 60, Intent(context, SosWidget::class.java).setAction(ACTION_WIDGET_SOS),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    for (id in ids) {
      val views = RemoteViews(context.packageName, R.layout.sos_widget)
      views.setOnClickPendingIntent(R.id.sos_button, tap)
      mgr.updateAppWidget(id, views)
    }
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == ACTION_WIDGET_SOS) SensingService.sendAction(context, SensingService.ACTION_SOS)
  }
}
