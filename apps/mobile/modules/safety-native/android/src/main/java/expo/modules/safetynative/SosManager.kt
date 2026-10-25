package expo.modules.safetynative

import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import uniffi.safety.UserAction

/** Manual SOS (counts as consent → straight to unlock) and its biometric-only cancel. */
class SosManager(private val rt: SafetyRuntime) {
  companion object { private const val TAG = "SosManager" }

  fun trigger() {
    if (rt.sosActive) return
    // A data-collection session records staged falls and grabs: SOS is off until it ends (Settings → Stop recording).
    if (rt.collecting) { Log.i(TAG, "SOS ignored: data collection is running"); return }
    rt.sosActive = true
    rt.emit("sos", mapOf("active" to true))
    // Engine turns UserAction.MANUAL_SOS into EngineEvent.UnlockLocation on the next tick; SafetyRuntime.dispatch then
    // opens the incident, releases hour keys and fans out push.
    rt.pushAction(UserAction.MANUAL_SOS)
    rt.scope.launch {
      val id = rt.openIncident("sos", "Manual SOS")
      rt.alerts.pushToGroup(id, "heads_up", "${rt.displayName()} pressed SOS", "Manual SOS triggered", critical = true)
    }
  }

  /** Shows a BiometricPrompt on the current Activity. Returns true only after a successful biometric. */
  suspend fun cancel(activity: FragmentActivity?): Boolean {
    if (activity == null) { Log.w(TAG, "cancelSos: no foreground activity"); return false }
    val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    if (BiometricManager.from(activity).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) return false

    val result = CompletableDeferred<Boolean>()
    withContext(Dispatchers.Main) {
      val prompt = BiometricPrompt(
        activity, ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) { result.complete(true) }
          override fun onAuthenticationError(code: Int, msg: CharSequence) { result.complete(false) }
          override fun onAuthenticationFailed() { /* retry allowed; wait for error/success */ }
        },
      )
      prompt.authenticate(
        BiometricPrompt.PromptInfo.Builder().setTitle("Cancel SOS").setSubtitle("Confirm it's you")
          .setAllowedAuthenticators(authenticators).build(),
      )
    }
    val ok = result.await()
    if (ok) {
      rt.sosActive = false
      rt.pushAction(UserAction.BIOMETRIC_DISMISS)
      rt.noteOwnerOk("SOS cancelled")
      rt.emit("sos", mapOf("active" to false))
      rt.scope.launch { rt.resolveIncident() }
    }
    return ok
  }
}
