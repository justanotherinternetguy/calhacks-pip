// The actions an operator can label on /collect, with the line they read out to the person holding the phone.
// Pure data (no runtime imports) so the analysis and its tests can use it under plain Node.

export type ActionGroup = 'walking' | 'still' | 'events' | 'other';
export type ActionDef = { label: string; title: string; instruction: string; group: ActionGroup; key: string };

export const TRANSITION = 'transition';

export const ACTIONS: ActionDef[] = [
  { label: 'normal_walking', title: 'Normal walking', instruction: 'Walk at your usual pace.', group: 'walking', key: '1' },
  { label: 'slow_walking', title: 'Slow walking', instruction: 'Walk slowly, like a stroll.', group: 'walking', key: '2' },
  { label: 'fast_walking', title: 'Fast walking', instruction: 'Walk fast, as if you are late.', group: 'walking', key: '3' },
  { label: 'unsteady_walking', title: 'Unsteady walking', instruction: 'Stagger and sway as if drunk. Keep walking.', group: 'walking', key: '4' },
  { label: 'stumbling', title: 'Stumbling', instruction: 'Walk, trip and catch yourself, keep walking.', group: 'walking', key: '5' },
  { label: 'stairs_up', title: 'Stairs up', instruction: 'Walk up the stairs at a normal pace.', group: 'walking', key: '6' },
  { label: 'stairs_down', title: 'Stairs down', instruction: 'Walk down the stairs at a normal pace.', group: 'walking', key: '7' },
  { label: 'running', title: 'Running', instruction: 'Jog or run.', group: 'walking', key: '8' },
  { label: 'standing', title: 'Standing', instruction: 'Stand still. Small movements are fine.', group: 'still', key: 'q' },
  { label: 'sitting', title: 'Sitting', instruction: 'Sit down and stay seated.', group: 'still', key: 'w' },
  { label: 'lying_down', title: 'Lying down', instruction: 'Lie down and stay still.', group: 'still', key: 'e' },
  { label: 'fall', title: 'Fall', instruction: 'Fall onto a bed or mat, then stay down for 15 s.', group: 'events', key: 'a' },
  { label: 'phone_drop', title: 'Phone drop', instruction: 'Drop the phone onto something soft. Leave it there for 10 s.', group: 'events', key: 's' },
  { label: 'phone_grab', title: 'Phone grab', instruction: 'Someone yanks the phone away and runs a few steps.', group: 'events', key: 'd' },
  { label: 'dancing', title: 'Dancing', instruction: 'Dance to music.', group: 'events', key: 'f' },
  { label: 'vehicle', title: 'Vehicle', instruction: 'Ride in a car, bus or train.', group: 'events', key: 'g' },
  { label: TRANSITION, title: 'Between actions', instruction: 'Getting ready for the next action. Not used in analysis.', group: 'other', key: '0' },
];

export const ACTION_GROUPS: { group: ActionGroup; title: string }[] = [
  { group: 'walking', title: 'Walking' },
  { group: 'still', title: 'Still' },
  { group: 'events', title: 'Events' },
  { group: 'other', title: 'Other' },
];

export const actionDef = (label: string | null | undefined): ActionDef | undefined => ACTIONS.find((a) => a.label === label);
export const actionTitle = (label: string | null | undefined) => (label ? actionDef(label)?.title ?? label.replace(/_/g, ' ') : 'No action');

/** Where the phone is. Recorded as its own segment track (labels `in_pocket` / `in_hand` / `in_bag`). */
export type PlacementChoice = 'pocket' | 'hand' | 'bag';
export const PLACEMENTS: { value: PlacementChoice; title: string; key: string }[] = [
  { value: 'pocket', title: 'Pocket', key: 'p' },
  { value: 'hand', title: 'Hand', key: 'h' },
  { value: 'bag', title: 'Bag', key: 'b' },
];
export const placementLabel = (p: PlacementChoice) => `in_${p}`;
export const placementFromLabel = (l: string | null | undefined): PlacementChoice | null =>
  l === 'in_pocket' ? 'pocket' : l === 'in_hand' ? 'hand' : l === 'in_bag' ? 'bag' : null;

/** Walking labels that must not raise unsteady gait (false alarms), and the ones it should catch. */
export const STEADY_WALK_LABELS = ['normal_walking', 'slow_walking', 'fast_walking', 'stairs_up', 'stairs_down'];
export const UNSTEADY_LABELS = ['unsteady_walking', 'stumbling'];

/** Which action a key press picks (case-insensitive), or the placement it sets. */
export function shortcut(key: string): { action: string } | { placement: PlacementChoice } | null {
  const k = key.toLowerCase();
  const a = ACTIONS.find((x) => x.key === k);
  if (a) return { action: a.label };
  const p = PLACEMENTS.find((x) => x.key === k);
  return p ? { placement: p.value } : null;
}
