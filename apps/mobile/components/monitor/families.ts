// Incident kind → family, mirroring safety_core::IncidentFamily. Type imports only, so node --test can load it.
import type { IncidentKind } from '@/modules/safety-native';

export type Family = 'fall' | 'gait' | 'phone' | 'handling' | 'location' | 'device' | 'check_in' | 'audio';

/** Same families as safety_core::IncidentFamily. */
export const FAMILY: Record<IncidentKind, Family> = {
  phone_drop: 'fall', possible_fall: 'fall', fall_recovered: 'fall', down_after_fall: 'fall', hard_impact: 'fall',
  unsteady_gait: 'gait', stumble: 'gait', repeated_stumbles: 'gait', slowed_walk: 'gait',
  phone_left_behind: 'phone', grab: 'handling',
  separated: 'location', stopped_on_way_home: 'location', in_vehicle: 'location',
  battery_critical: 'device', check_in_missed: 'check_in', typing_off: 'check_in',
  scream_shout: 'audio', snoring_while_down: 'audio', distress_words: 'audio',
};

