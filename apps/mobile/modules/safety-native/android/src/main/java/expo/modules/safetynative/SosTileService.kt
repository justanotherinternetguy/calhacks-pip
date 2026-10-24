package expo.modules.safetynative

import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick Settings tile: one tap triggers manual SOS (consent → straight to unlock). */
class SosTileService : TileService() {
  override fun onStartListening() {
    qsTile?.apply {
      state = if (SafetyRuntime.peek()?.sosActive == true) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
      label = if (state == Tile.STATE_ACTIVE) "SOS sent" else "SOS"
      updateTile()
    }
  }

  override fun onClick() {
    val rt = SafetyRuntime.get(this)
    if (!rt.configured) { unlockAndRun { rt.alerts.launcherIntent()?.send() }; return }
    SensingService.sendAction(this, SensingService.ACTION_SOS)
    qsTile?.apply { state = Tile.STATE_ACTIVE; label = "SOS sent"; updateTile() }
  }
}
