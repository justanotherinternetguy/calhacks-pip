package expo.modules.safetynative

import uniffi.safety.Activity
import uniffi.safety.IncidentKind
import uniffi.safety.IncidentRecord
import uniffi.safety.LiveMetrics
import uniffi.safety.MetricBand
import uniffi.safety.Placement

/**
 * JS-facing serialisation of the v1.1 engine records (CONTRACTS §6: same field names, camelCase).
 * Numbers cross the bridge as Long (u64/u32 counters, ms) or Double (f32); enums become lowercase
 * snake strings ("gait_drift", "pocket", "walking").
 */

fun placementName(p: Placement?): String = when (p) {
  Placement.POCKET -> "pocket"; Placement.HAND -> "hand"; Placement.BAG -> "bag"; else -> "unknown"
}

fun activityName(a: Activity?): String = when (a) {
  Activity.STATIONARY -> "stationary"; Activity.WALKING -> "walking"; Activity.RUNNING -> "running"
  Activity.VEHICLE -> "vehicle"; else -> "unknown"
}

fun incidentKindName(k: IncidentKind): String = when (k) {
  IncidentKind.GAIT_DRIFT -> "gait_drift"; IncidentKind.IMPACT -> "impact"; IncidentKind.GRAB -> "grab"
  IncidentKind.STILLNESS -> "stillness"; IncidentKind.SEPARATED -> "separated"; IncidentKind.TYPING_OFF -> "typing_off"
}

fun MetricBand.toMap(): Map<String, Any?> = mapOf(
  "name" to name,
  "value" to value.toDouble(),
  "mean" to mean.toDouble(),
  "sd" to sd.toDouble(),
  "sdDistance" to sdDistance.toDouble(),
  "inBand" to inBand,
)

fun LiveMetrics.toMap(): Map<String, Any?> = mapOf(
  "tMs" to tMs.toLong(),
  "placement" to placementName(placement),
  "samplingFull" to samplingFull,
  "activity" to activityName(activity),
  "bands" to bands.map { it.toMap() },
  "pNormal" to pNormal.toDouble(),
  "pImpaired" to pImpaired.toDouble(),
  "pIncident" to pIncident.toDouble(),
  "pUnresponsive" to pUnresponsive.toDouble(),
  "baselineTrusted" to baselineTrusted,
  "baselineWalkDays" to baselineWalkDays.toDouble(),
  "evidence" to evidence,
)

fun IncidentRecord.toMap(): Map<String, Any?> = mapOf(
  "id" to id.toLong(),
  "tMs" to tMs.toLong(),
  "kind" to incidentKindName(kind),
  "summary" to summary,
  "sdDistance" to sdDistance.toDouble(),
  "placement" to placementName(placement),
  "rawJson" to rawJson,
  "pNormal" to pNormal.toDouble(),
  "pImpaired" to pImpaired.toDouble(),
  "pIncident" to pIncident.toDouble(),
  "pUnresponsive" to pUnresponsive.toDouble(),
  "sequenceId" to sequenceId.toLong(),
  "watched" to watched,
)

/** Empty metrics for the dashboard when the engine is not ready yet. */
fun emptyMetricsMap(nowMs: Long): Map<String, Any?> = mapOf(
  "tMs" to nowMs, "placement" to "unknown", "samplingFull" to false, "activity" to "unknown",
  "bands" to emptyList<Map<String, Any?>>(), "pNormal" to 1.0, "pImpaired" to 0.0, "pIncident" to 0.0, "pUnresponsive" to 0.0,
  "baselineTrusted" to false, "baselineWalkDays" to 0.0, "evidence" to "",
)
