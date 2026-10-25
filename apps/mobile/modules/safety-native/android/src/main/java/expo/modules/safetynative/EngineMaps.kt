package expo.modules.safetynative

import uniffi.safety.Activity
import uniffi.safety.IncidentKind
import uniffi.safety.IncidentRecord
import uniffi.safety.IncidentTier
import uniffi.safety.LiveMetrics
import uniffi.safety.MetricBand
import uniffi.safety.Placement

/**
 * JS-facing serialisation of the v2 engine records (CONTRACTS §6: same field names, camelCase).
 * Numbers cross the bridge as Long (u64/u32 counters, ms) or Double (f32); enums become lowercase
 * snake strings ("possible_fall", "watch", "pocket", "walking").
 */

fun placementName(p: Placement?): String = when (p) {
  Placement.POCKET -> "pocket"; Placement.HAND -> "hand"; Placement.BAG -> "bag"; else -> "unknown"
}

fun activityName(a: Activity?): String = when (a) {
  Activity.STATIONARY -> "stationary"; Activity.WALKING -> "walking"; Activity.RUNNING -> "running"
  Activity.VEHICLE -> "vehicle"; else -> "unknown"
}

fun incidentKindName(k: IncidentKind): String = when (k) {
  IncidentKind.PHONE_DROP -> "phone_drop"; IncidentKind.POSSIBLE_FALL -> "possible_fall"
  IncidentKind.FALL_RECOVERED -> "fall_recovered"; IncidentKind.DOWN_AFTER_FALL -> "down_after_fall"
  IncidentKind.HARD_IMPACT -> "hard_impact"; IncidentKind.UNSTEADY_GAIT -> "unsteady_gait"; IncidentKind.STUMBLE -> "stumble"
  IncidentKind.REPEATED_STUMBLES -> "repeated_stumbles"; IncidentKind.SLOWED_WALK -> "slowed_walk"
  IncidentKind.PHONE_LEFT_BEHIND -> "phone_left_behind"; IncidentKind.GRAB -> "grab"; IncidentKind.SEPARATED -> "separated"
  IncidentKind.STOPPED_ON_WAY_HOME -> "stopped_on_way_home"; IncidentKind.IN_VEHICLE -> "in_vehicle"
  IncidentKind.BATTERY_CRITICAL -> "battery_critical"; IncidentKind.CHECK_IN_MISSED -> "check_in_missed"
  IncidentKind.TYPING_OFF -> "typing_off"; IncidentKind.SCREAM_SHOUT -> "scream_shout"
  IncidentKind.SNORING_WHILE_DOWN -> "snoring_while_down"; IncidentKind.DISTRESS_WORDS -> "distress_words"
}

fun incidentTierName(t: IncidentTier): String = when (t) {
  IncidentTier.CONTEXT -> "context"; IncidentTier.WATCH -> "watch"; IncidentTier.DANGER -> "danger"
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
  "listening" to listening,
  "context" to context,
  "baselineTrusted" to baselineTrusted,
  "baselineWalkDays" to baselineWalkDays.toDouble(),
  "evidence" to evidence,
)

fun IncidentRecord.toMap(): Map<String, Any?> = mapOf(
  "id" to id.toLong(),
  "tMs" to tMs.toLong(),
  "kind" to incidentKindName(kind),
  "tier" to incidentTierName(tier),
  "summary" to summary,
  "sdDistance" to sdDistance.toDouble(),
  "placement" to placementName(placement),
  "rawJson" to rawJson,
  "clearedMs" to clearedMs.toLong(),
  "acknowledged" to acknowledged,
  "sequenceId" to sequenceId.toLong(),
  "watched" to watched,
)

/** Empty metrics for the dashboard when the engine is not ready yet. */
fun emptyMetricsMap(nowMs: Long): Map<String, Any?> = mapOf(
  "tMs" to nowMs, "placement" to "unknown", "samplingFull" to false, "activity" to "unknown",
  "bands" to emptyList<Map<String, Any?>>(), "listening" to false, "context" to emptyList<String>(),
  "baselineTrusted" to false, "baselineWalkDays" to 0.0, "evidence" to "",
)
