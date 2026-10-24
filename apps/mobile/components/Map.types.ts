import type { StyleProp, ViewStyle } from 'react-native';
import type { HomePlace } from '@/modules/safety-native';

export type LatLng = { lat: number; lng: number };
export type MapProps = {
  center?: LatLng;
  points?: (LatLng & { tMs?: number })[];
  places?: HomePlace[];
  onPress?: (p: LatLng) => void;
  style?: StyleProp<ViewStyle>;
};
