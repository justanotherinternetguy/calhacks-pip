import type { StyleProp, ViewStyle } from 'react-native';
import type { Tone } from '@/lib/theme';
import type { LatLng } from '@/lib/friends';

export type MapPerson = { id: string; initial: string; name: string; tone: Tone; isMe?: boolean; loc: LatLng | null };

export type FriendsMapProps = {
  /** everyone, me included; people without a position are simply not drawn */
  people: MapPerson[];
  /** the group's meeting point: the zone circle is drawn around it */
  anchor?: LatLng | null;
  /** this person is the subject: the camera keeps them in view and everyone else recedes */
  focusId?: string | null;
  onSelect?: (id: string) => void;
  /** screen space the sheet covers at the bottom (and the header at the top), so pins are fitted clear of it */
  insetBottom?: number;
  insetTop?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Google Maps styled in the site's palette: cream land, paper roads, sky water, mint parks. */
export const CREAM_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#F6ECD6' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5A5470' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#FBF3E4' }, { weight: 3 }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#D9CBAE' }] },
  { featureType: 'administrative.land_parcel', stylers: [{ visibility: 'off' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry.stroke', stylers: [{ color: '#EADFC8' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#DDF2E8' }, { visibility: 'on' }] },
  { featureType: 'poi.park', elementType: 'labels.text', stylers: [{ visibility: 'on' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#1E8A66' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#FFFCF5' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#E6D8BD' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#FFE7A3' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#E6D8BD' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#FFFCF5' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#CFE4FA' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#1F6FCC' }] },
];

/** Where the camera starts before anyone has a position. */
export const DEFAULT_CENTER: LatLng = { lat: 42.3505, lng: -71.1054 };

/** The people with a position, the subject (if any) first so a fit can weight it. */
export function placed(people: MapPerson[], focusId?: string | null) {
  const pts = people.filter((p): p is MapPerson & { loc: LatLng } => !!p.loc);
  return focusId ? [...pts.filter((p) => p.id === focusId), ...pts.filter((p) => p.id !== focusId)] : pts;
}

/** What the camera should show: the subject and me when there is a subject, otherwise everyone. */
export function framed(people: MapPerson[], focusId?: string | null): LatLng[] {
  const pts = placed(people, focusId);
  if (!focusId) return pts.map((p) => p.loc);
  const keep = pts.filter((p) => p.id === focusId || p.isMe);
  return (keep.length ? keep : pts).map((p) => p.loc);
}

/** Reads a frame as text, for the accessibility label. */
export function describe(people: MapPerson[]): string {
  const pts = placed(people).filter((p) => !p.isMe);
  const me = people.find((p) => p.isMe);
  if (!me?.loc) return 'Map. Waiting for your position.';
  return pts.length ? `Map. ${pts.map((p) => p.name).join(', ')} on the map around you.` : 'Map. Just you on the map.';
}
