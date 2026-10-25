// Building blocks of the pip interface: type, marks (colour inside an ink keyline), paper cards, ledge buttons,
// chips, tabs, rows and stroke icons. Everything pairs cream with ink so it reads on the map as well as on paper.
import React, { useEffect, useMemo } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, type StyleProp, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { fontFor, ht, tones, trackingFor, ui, type Family, type Tone } from '@/lib/theme';

// ---- type ----------------------------------------------------------------------------------------------

function Typo({ family, style, ...rest }: TextProps & { family: Family; style?: StyleProp<TextStyle> }) {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const tracking = flat.letterSpacing ?? (family === 'display' ? trackingFor(flat.fontSize) : undefined);
  return <Text {...rest} style={[{ color: ui.text }, flat, fontFor(flat.fontWeight, family), tracking != null ? { letterSpacing: tracking } : null]} />;
}
/** Body text in Figtree. Pass `fontWeight`; the face follows. */
export const T = (p: TextProps & { style?: StyleProp<TextStyle> }) => <Typo family="body" {...p} />;
/** Display text in Fredoka: headings, button labels, big numbers. */
export const D = (p: TextProps & { style?: StyleProp<TextStyle> }) => <Typo family="display" style={[{ fontWeight: '600' }, p.style]} {...p} />;
/** DM Mono: clock times, fingerprints, readings. */
export const Mono = (p: TextProps & { style?: StyleProp<TextStyle> }) => <Typo family="mono" {...p} />;

/** Small bold label with a little tracking: section heads and status tags. */
export const Caps = ({ children, style, color = ui.quiet }: { children: React.ReactNode; style?: StyleProp<TextStyle>; color?: string }) => (
  <T style={[{ fontSize: 12.5, lineHeight: 16, fontWeight: '700', letterSpacing: 0.6, color }, style]}>{children}</T>
);
export const SectionLabel = ({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) => (
  <Caps style={[{ marginTop: 20, marginBottom: 8 }, style]}>{children}</Caps>
);

// ---- marks ---------------------------------------------------------------------------------------------

/** Slow pulse used by danger marks ("friends were told"). */
export function usePulse(on: boolean, periodMs = 2400) {
  const v = useMemo(() => new Animated.Value(0), []);
  useEffect(() => {
    if (!on) { v.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: periodMs, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [on, periodMs, v]);
  return v;
}

/**
 * The mark beside a name: a disc of the tone's colour inside a 1.5 px ink keyline. Coral pulses, butter watches,
 * mint is fine, home and not-streaming are hollow paper. `isMe` is the one sky mark on screen.
 */
export function Dot({ tone, isMe, size, style }: { tone: Tone; isMe?: boolean; size?: number; style?: StyleProp<ViewStyle> }) {
  const t = tones[tone];
  const d = size ?? (isMe ? 14 : 12);
  const pulse = usePulse(tone === 'high' && !isMe);
  const fill = isMe ? ht.sky : t.dot;
  return (
    <View accessible={false} style={[{ width: d, height: d, alignItems: 'center', justifyContent: 'center' }, style]}>
      {tone === 'high' && !isMe && (
        <Animated.View style={{
          position: 'absolute', width: d, height: d, borderRadius: d / 2, backgroundColor: ht.coral,
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 3] }) }],
        }} />
      )}
      <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: fill, borderWidth: 1.5, borderColor: tone === 'offline' && !isMe ? ht.muted : ui.keyline }} />
    </View>
  );
}

/** A person's initial over their mark (headers, compact lists). */
export function Mark({ initial, tone, isMe, dim, size = 13, style }: { initial: string; tone: Tone; isMe?: boolean; dim?: boolean; size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View accessible={false} style={[{ alignItems: 'center', gap: 4, opacity: dim ? 0.45 : 1 }, style]}>
      <D style={{ fontSize: size, lineHeight: Math.round(size * 1.2), color: ui.text }}>{initial}</D>
      <Dot tone={tone} isMe={isMe} size={isMe ? 12 : 10} />
    </View>
  );
}

/** Height of the name under a pin; the same space sits above the disc so the disc is the pin's centre. */
export const PIN_LABEL_H = 24;

/**
 * A pin on the map, as on the site's radar: a disc of the tone's colour in a thick ink ring with the name underneath.
 * `me` is the sky disc (no name). `focused` grows it and puts the name on an ink chip. The disc is the centre of the
 * view, so anchor the marker at (0.5, 0.5).
 */
export function Pin({ name, tone, isMe, focused, dim }: { initial?: string; name?: string; tone: Tone; isMe?: boolean; focused?: boolean; dim?: boolean }) {
  const t = tones[tone];
  const d = focused ? 28 : 22;
  const fill = isMe ? ht.sky : t.hollow ? ht.paper : t.dot;
  return (
    <View accessible={false} style={{ alignItems: 'center', opacity: dim ? 0.5 : 1, minWidth: 64 }}>
      <View style={{ height: PIN_LABEL_H }} />
      <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: fill, borderWidth: 2.5, borderColor: tone === 'offline' && !isMe ? ht.muted : ui.keyline }} />
      <View style={{ height: PIN_LABEL_H, justifyContent: 'center' }}>
        {isMe || !name ? null : focused
          ? <Chip small style={{ alignSelf: 'center' }}>{name}</Chip>
          : <D style={s.pinName} numberOfLines={1}>{name}</D>}
      </View>
    </View>
  );
}

/** pip's mark: a sky ring with a small coral pip. */
export function Brand({ size = 28, withWord = true, color = ui.text }: { size?: number; withWord?: boolean; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: Math.round(size * 0.28) }}>
      <Svg width={size} height={size} viewBox="0 0 64 64">
        <Circle cx={30} cy={34} r={16} fill="none" stroke={ht.sky} strokeWidth={7} />
        <Circle cx={47} cy={19} r={9} fill={ht.coral} stroke={ui.keyline} strokeWidth={3} />
      </Svg>
      {withWord && <D style={{ fontSize: Math.round(size * 0.8), lineHeight: Math.round(size * 0.95), color }}>pip</D>}
    </View>
  );
}

// ---- surfaces ------------------------------------------------------------------------------------------

/** A paper card with a thin line. */
export function Card({ children, style, tint, padded = true }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; tint?: string; padded?: boolean }) {
  return <View style={[s.card, padded && { padding: 18, gap: 10 }, tint ? { borderColor: tint, borderWidth: 2 } : null, style]}>{children}</View>;
}
/** A sunk well in the cream (the site's "shapes well"). */
export const Well = ({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) => <View style={[s.well, style]}>{children}</View>;
/** An ink panel with cream type (the site's dark band). */
export const InkPanel = ({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) => <View style={[s.inkPanel, style]}>{children}</View>;

export const Hairline = ({ style }: { style?: StyleProp<ViewStyle> }) => <View style={[{ height: 1.5, backgroundColor: ui.line }, style]} />;
export const Handle = () => <View style={s.handle} />;

// ---- buttons: each rests on a ledge and sinks onto it when pressed ------------------------------------

export type BtnKind = 'main' | 'paper' | 'coral' | 'mint' | 'butter' | 'quiet';
const FACE: Record<BtnKind, { bg: string; fg: string; border: string; ledge: string }> = {
  main: { bg: ht.ink, fg: ht.cream, border: ht.ink, ledge: ht.ledge },
  paper: { bg: ht.paper, fg: ht.ink, border: ht.ink, ledge: ht.ink },
  coral: { bg: ht.coral, fg: ht.ink, border: ht.ink, ledge: ht.ink },
  mint: { bg: ht.mint, fg: ht.ink, border: ht.ink, ledge: ht.ink },
  butter: { bg: ht.butter, fg: ht.ink, border: ht.ink, ledge: ht.ink },
  quiet: { bg: 'transparent', fg: ht.inkMid, border: 'transparent', ledge: 'transparent' },
};
const LEDGE = 4;

export function Btn({ title, onPress, kind = 'paper', icon, iconRight, disabled, loading, size = 48, style, textStyle, testID, accessibilityLabel }: {
  title: string; onPress: () => void; kind?: BtnKind; icon?: React.ReactNode; iconRight?: React.ReactNode; disabled?: boolean; loading?: boolean;
  size?: 44 | 48 | 56; style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>; testID?: string; accessibilityLabel?: string;
}) {
  const f = FACE[kind];
  const y = useMemo(() => new Animated.Value(0), []);
  const down = () => Animated.timing(y, { toValue: LEDGE, duration: 60, useNativeDriver: true }).start();
  const up = () => Animated.timing(y, { toValue: 0, duration: 90, useNativeDriver: true }).start();
  const flat = kind === 'quiet';
  // Padding from older call sites was meant for the face, not the ledge wrapper: drop it.
  const { padding: _p, paddingVertical: _pv, paddingHorizontal: _ph, paddingTop: _pt, paddingBottom: _pb, paddingLeft: _pl, paddingRight: _pr, minHeight: _mh, ...outer } = (StyleSheet.flatten(style) ?? {}) as ViewStyle;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} disabled={disabled || loading}
      onPressIn={flat ? undefined : down} onPressOut={flat ? undefined : up}
      style={[{ opacity: disabled ? 0.45 : 1 }, outer, { paddingBottom: flat ? 0 : LEDGE }]}>
      {!flat && <View style={[s.ledge, { backgroundColor: f.ledge, borderRadius: size / 2, top: LEDGE }]} />}
      <Animated.View style={[s.face, { height: size, borderRadius: size / 2, backgroundColor: f.bg, borderColor: f.border, borderWidth: flat ? 0 : 2, paddingHorizontal: size === 44 ? 18 : 22, transform: [{ translateY: y }] }]}>
        {icon}
        <D style={[{ fontSize: size === 56 ? 18 : size === 44 ? 16 : 17, lineHeight: 22, color: f.fg }, textStyle]} numberOfLines={1}>{loading ? '…' : title}</D>
        {iconRight}
      </Animated.View>
    </Pressable>
  );
}

/** A 44 px round button on a ledge, for an icon. `onMap` gives it the cream-and-ink keyline for floating over tiles. */
export function IconBtn({ label, onPress, children, style, kind = 'paper', badge, testID }: {
  label: string; onPress: () => void; children: React.ReactNode; style?: StyleProp<ViewStyle>; kind?: 'paper' | 'main'; badge?: React.ReactNode; testID?: string;
}) {
  const f = FACE[kind];
  const y = useMemo(() => new Animated.Value(0), []);
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}
      onPressIn={() => Animated.timing(y, { toValue: 3, duration: 60, useNativeDriver: true }).start()}
      onPressOut={() => Animated.timing(y, { toValue: 0, duration: 90, useNativeDriver: true }).start()}
      style={[{ width: 44, height: 47 }, style]}>
      <View style={[s.ledge, { backgroundColor: f.ledge, borderRadius: 22, top: 3 }]} />
      <Animated.View style={[s.round, { backgroundColor: f.bg, borderColor: f.border, transform: [{ translateY: y }] }]}>
        {children}
        {badge}
      </Animated.View>
    </Pressable>
  );
}

/** A plain text action (no ledge): "Call Sam", "All friends". */
export function TextAction({ title, onPress, color = ui.text, disabled, style, align = 'flex-start' }: {
  title: string; onPress: () => void; color?: string; disabled?: boolean; style?: StyleProp<ViewStyle>; align?: 'flex-start' | 'center';
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}
      style={({ pressed }) => [{ height: 44, justifyContent: 'center', alignItems: align, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }, style]}>
      <D style={{ fontSize: 16, lineHeight: 20, color }} numberOfLines={1}>{title}</D>
    </Pressable>
  );
}

/** Ink chip with cream type (or a tone's fill with ink type). */
export function Chip({ children, fill = ht.ink, color, style, small }: { children: React.ReactNode; fill?: string; color?: string; style?: StyleProp<ViewStyle>; small?: boolean }) {
  const fg = color ?? (fill === ht.ink ? ht.cream : ht.ink);
  return (
    <View style={[{ alignSelf: 'flex-start', paddingVertical: small ? 3 : 5, paddingHorizontal: small ? 10 : 13, borderRadius: 999, backgroundColor: fill, borderWidth: fill === ht.ink ? 0 : 1.5, borderColor: ui.keyline }, style]}>
      <D style={{ fontSize: small ? 12.5 : 14, lineHeight: small ? 16 : 18, fontWeight: '500', color: fg }} numberOfLines={1}>{children}</D>
    </View>
  );
}

/** A track of tabs on a sunk pill: the one that is on is ink. */
export function Tabs<K extends string>({ items, value, onChange, style }: { items: { key: K; label: string; mark?: React.ReactNode }[]; value: K; onChange: (k: K) => void; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[s.tabs, style]} accessibilityRole="tablist">
      {items.map((it) => {
        const on = it.key === value;
        return (
          <Pressable key={it.key} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(it.key)}
            style={({ pressed }) => [s.tab, on && { backgroundColor: ht.ink }, pressed && !on && { backgroundColor: ui.line }]}>
            {it.mark}
            <D style={{ fontSize: 15, lineHeight: 18, color: on ? ht.cream : ui.text2 }}>{it.label}</D>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A list row: title, optional sub, something on the right, a chevron when it goes somewhere. */
export function Row({ title, sub, left, right, onPress, accessibilityLabel, style, chevron = true, height = 56, testID }: {
  title: string; sub?: string; left?: React.ReactNode; right?: React.ReactNode; onPress?: () => void; accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>; chevron?: boolean; height?: number; testID?: string;
}) {
  return (
    <Pressable testID={testID} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={accessibilityLabel} onPress={onPress} disabled={!onPress}
      style={({ pressed }) => [{ minHeight: height, flexDirection: 'row', alignItems: 'center', gap: 14, opacity: pressed ? 0.6 : 1 }, style]}>
      {left}
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <T style={{ fontSize: 16, lineHeight: 21, fontWeight: '500' }} numberOfLines={1}>{title}</T>
        {sub ? <T style={{ fontSize: 13, lineHeight: 17, color: ui.quiet }} numberOfLines={2}>{sub}</T> : null}
      </View>
      {right}
      {onPress && chevron ? Icon.chevron(ui.muted) : null}
    </Pressable>
  );
}

/** Ink track, mint knob when on. */
export function Switch({ value, onChange, label, hint, testID, style }: { value: boolean; onChange: (v: boolean) => void; label: string; hint?: string; testID?: string; style?: StyleProp<ViewStyle> }) {
  const x = useMemo(() => new Animated.Value(value ? 1 : 0), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { Animated.spring(x, { toValue: value ? 1 : 0, useNativeDriver: true, speed: 30, bounciness: 8 }).start(); }, [value, x]);
  return (
    <Pressable testID={testID} accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)}
      style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 56, opacity: pressed ? 0.75 : 1 }, style]}>
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ fontSize: 16, lineHeight: 21, fontWeight: '500' }}>{label}</T>
        {hint ? <T style={{ fontSize: 13, lineHeight: 17, color: ui.quiet }}>{hint}</T> : null}
      </View>
      <View style={[s.switchTrack, { backgroundColor: value ? ht.ink : ui.sunk }]}>
        <Animated.View style={[s.switchKnob, { backgroundColor: value ? ht.mint : ht.paper, transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, 22] }) }] }]} />
      </View>
    </Pressable>
  );
}

/** A numbered step disc (the site's "how it works"). */
export const StepNumber = ({ n, fill }: { n: number | string; fill: string }) => (
  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: fill, borderWidth: 2, borderColor: ui.keyline, alignItems: 'center', justifyContent: 'center' }}>
    <D style={{ fontSize: 17, lineHeight: 21 }}>{n}</D>
  </View>
);

/** A mint disc with a check (the site's "guards" list). */
export const CheckMark = ({ size = 24, fill = ht.mint }: { size?: number; fill?: string }) => (
  <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: fill, borderWidth: 2, borderColor: ui.keyline, alignItems: 'center', justifyContent: 'center' }}>
    {Icon.check(ui.text, Math.round(size * 0.6))}
  </View>
);

// ---- icons: 24 grid, round strokes, as on the site. Pass the colour. ------------------------------------

const ic = (size: number, c: string, children: React.ReactNode, sw = 2.5) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{children}</Svg>
);
export const Icon = {
  back: (c: string = ui.text, size = 20) => ic(size, c, <Path d="M15 5 L8 12 L15 19" />),
  chevron: (c: string = ui.quiet, size = 16) => ic(size, c, <Path d="M9 5 L16 12 L9 19" />),
  close: (c: string = ui.text, size = 18) => ic(size, c, <><Path d="M6 6 L18 18" /><Path d="M18 6 L6 18" /></>),
  check: (c: string = ui.text, size = 18) => ic(size, c, <Path d="M5 12.5 L9.5 17 L19 7.5" />, 3),
  plus: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M12 5 V19" /><Path d="M5 12 H19" /></>),
  arrow: (c: string = ui.text, size = 18) => ic(size, c, <><Path d="M5 12 L19 12" /><Path d="M13 6 L19 12 L13 18" /></>, 3),
  sliders: (c: string = ui.text, size = 22) => ic(size, c, <><Path d="M4 7 H13" /><Path d="M19 7 H20" /><Circle cx={16} cy={7} r={2.6} /><Path d="M4 17 H7" /><Path d="M13 17 H20" /><Circle cx={10} cy={17} r={2.6} /></>),
  people: (c: string = ui.text, size = 22) => ic(size, c, <><Circle cx={9} cy={8} r={3.6} /><Path d="M2.5 20 a6.5 6.5 0 0 1 13 0" /><Circle cx={17} cy={9} r={2.8} /><Path d="M16 14.5 a5 5 0 0 1 5.5 5.5" /></>),
  phone: (c: string = ui.text, size = 20) => ic(size, c, <Path d="M5.5 3.5 h3.5 l2 5 l-2.3 1.4 a9.5 9.5 0 0 0 5.4 5.4 l1.4 -2.3 l5 2 v3.5 a2 2 0 0 1 -2 2 A16.5 16.5 0 0 1 3.5 5.5 a2 2 0 0 1 2 -2z" />),
  lock: (c: string = ui.quiet, size = 16) => ic(size, c, <><Rect x={5} y={11} width={14} height={9} rx={2.5} /><Path d="M8 11 V8 a4 4 0 0 1 8 0 v3" /></>),
  unlocked: (c: string = ht.coralDeep, size = 16) => ic(size, c, <><Rect x={5} y={11} width={14} height={9} rx={2.5} /><Path d="M8 11 V8 a4 4 0 0 1 7.6 -1.6" /></>),
  eye: (c: string = ui.quiet, size = 14) => ic(size, c, <><Path d="M2.5 12 c2.5 -4.5 5.7 -6.5 9.5 -6.5 s7 2 9.5 6.5 c-2.5 4.5 -5.7 6.5 -9.5 6.5 s-7 -2 -9.5 -6.5z" /><Circle cx={12} cy={12} r={3} /></>),
  clock: (c: string = ui.text, size = 20) => ic(size, c, <><Circle cx={12} cy={12} r={8.5} /><Path d="M12 7.5 V12 H16" /></>),
  fingerprint: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M6.5 11 a5.5 5.5 0 0 1 11 0 c0 3.5 -0.7 6.5 -1.8 9" /><Path d="M9.2 20 c1.4 -2.8 2 -5.8 2 -9 a0.8 0.8 0 0 1 1.6 0 c0 3 -0.5 6 -1.5 9" /><Path d="M4 9 a8 8 0 0 1 16 0" /></>, 2.2),
  bell: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M6 16 V11 a6 6 0 0 1 12 0 v5 l1.5 2 H4.5z" /><Path d="M10 21 a2 2 0 0 0 4 0" /></>),
  more: (c: string = ui.quiet, size = 20) => ic(size, c, <><Circle cx={6} cy={12} r={1.4} fill={c} /><Circle cx={12} cy={12} r={1.4} fill={c} /><Circle cx={18} cy={12} r={1.4} fill={c} /></>, 1.5),
  pin: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M12 21 c4.5 -4.5 7 -8 7 -11 a7 7 0 0 0 -14 0 c0 3 2.5 6.5 7 11z" /><Circle cx={12} cy={10} r={2.5} /></>),
  home: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M4 11 L12 4 L20 11 V20 H4z" /><Path d="M10 20 V15 H14 V20" /></>),
  moon: (c: string = ui.text, size = 20) => ic(size, c, <Path d="M20 14.5 A8.5 8.5 0 1 1 9.5 4 A6.5 6.5 0 0 0 20 14.5z" />),
  sun: (c: string = ui.text, size = 20) => ic(size, c, <><Circle cx={12} cy={12} r={4} /><Path d="M12 2.5 v2 M12 19.5 v2 M2.5 12 h2 M19.5 12 h2 M5.3 5.3 l1.4 1.4 M17.3 17.3 l1.4 1.4 M5.3 18.7 l1.4 -1.4 M17.3 6.7 l1.4 -1.4" /></>),
  locate: (c: string = ui.text, size = 20) => ic(size, c, <><Circle cx={12} cy={12} r={5.5} /><Circle cx={12} cy={12} r={1.2} fill={c} /><Path d="M12 2.5 v3 M12 18.5 v3 M2.5 12 h3 M18.5 12 h3" /></>),
  list: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M5 7 H19" /><Path d="M5 12 H19" /><Path d="M5 17 H19" /></>),
  warning: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M12 4 L21 19.5 H3z" /><Path d="M12 10 V14" /><Circle cx={12} cy={17} r={0.6} fill={c} /></>),
  qr: (c: string = ui.text, size = 20) => ic(size, c, <><Rect x={4} y={4} width={6} height={6} rx={1.2} /><Rect x={14} y={4} width={6} height={6} rx={1.2} /><Rect x={4} y={14} width={6} height={6} rx={1.2} /><Path d="M14 14 h2.5 v2.5 M20 14 v2.5 M14 20 h2.5 M17.5 17.5 h2.5 v2.5" /></>, 2.2),
  camera: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M4 8 h3.5 l1.5 -2.5 h6 l1.5 2.5 H20 v11 H4z" /><Circle cx={12} cy={13} r={3.2} /></>),
  walk: (c: string = ui.text, size = 20) => ic(size, c, <><Circle cx={13} cy={4.5} r={1.8} /><Path d="M12 8 l-2.5 5.5 L7 21" /><Path d="M12 8 l3 3 3 1" /><Path d="M9.5 13.5 l3.5 2.5 1.5 5" /></>),
  keyboard: (c: string = ui.text, size = 20) => ic(size, c, <><Rect x={3} y={6} width={18} height={12} rx={2.5} /><Path d="M7 10 h.5 M11 10 h.5 M15 10 h.5 M7 14 h10" /></>, 2.2),
  mic: (c: string = ui.text, size = 20) => ic(size, c, <><Rect x={9} y={3} width={6} height={11} rx={3} /><Path d="M5.5 11.5 a6.5 6.5 0 0 0 13 0" /><Path d="M12 18 v3" /></>),
  battery: (c: string = ui.text, size = 20) => ic(size, c, <><Rect x={3} y={7} width={16} height={10} rx={2.5} /><Path d="M21 10.5 v3" /><Path d="M7 11 v2 M11 11 v2" /></>, 2.2),
  signOut: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M10 4 H5.5 a1.5 1.5 0 0 0 -1.5 1.5 v13 a1.5 1.5 0 0 0 1.5 1.5 H10" /><Path d="M9 12 H20" /><Path d="M16 8 L20 12 L16 16" /></>),
  send: (c: string = ui.text, size = 20) => ic(size, c, <Path d="M4 11 L20 4 L14 20 L11.5 12.5z" />),
  refresh: (c: string = ui.text, size = 20) => ic(size, c, <><Path d="M19 12 a7 7 0 1 1 -2 -5" /><Path d="M19 4 v4 h-4" /></>),
  minus: (c: string = ui.text, size = 20) => ic(size, c, <Path d="M5 12 H19" />),
};

export const s = StyleSheet.create({
  card: { backgroundColor: ui.panel, borderRadius: 22, borderWidth: 1.5, borderColor: ui.line },
  well: { backgroundColor: ui.sunk, borderRadius: 28, padding: 20 },
  inkPanel: { backgroundColor: ht.ink, borderRadius: 22, padding: 18, gap: 10 },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: ui.line },
  ledge: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  face: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  round: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', alignSelf: 'flex-start', gap: 2, padding: 4, borderRadius: 999, backgroundColor: ui.sunk },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, paddingHorizontal: 16, borderRadius: 999 },
  switchTrack: { width: 50, height: 28, borderRadius: 14, padding: 2, borderWidth: 1.5, borderColor: ui.keyline, justifyContent: 'center' },
  switchKnob: { width: 21, height: 21, borderRadius: 11, borderWidth: 1.5, borderColor: ui.keyline },
  pinName: { fontSize: 13, lineHeight: 16, color: ht.inkMid, textShadowColor: ht.cream, textShadowRadius: 3, textShadowOffset: { width: 0, height: 0 } },
});

/** The site's spring, for the bigger moments. */
export const spring = Easing.bezier(0.34, 1.56, 0.64, 1);
