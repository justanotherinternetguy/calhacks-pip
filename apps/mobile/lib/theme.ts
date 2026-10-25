import { Platform, type TextStyle } from 'react-native';

/**
 * pip's interface language, borrowed from the HoloTouch site: cream and ink carry the page, and colour marks what a
 * person is doing. Sky is you. Coral is "friends were told". Butter is "on watch". Mint is fine, home and done. Lilac
 * is a check-in waiting on an answer. Nothing else is coloured.
 */
export const ht = {
  cream: '#FBF3E4',
  paper: '#FFFCF5',
  sunk: '#F2E6CF',
  line: '#E6D8BD',
  muted: '#B8AC96',
  ink: '#1E1B2E',
  inkRaised: '#2C2842',
  inkMid: '#3A3552',
  inkSoft: '#5A5470',
  ledge: '#0E0C18',
  coral: '#FF6B5C',
  sky: '#4AA8FF',
  mint: '#3DD6A3',
  butter: '#FFD35A',
  lilac: '#B69CFF',
  lilacDeep: '#6341C9',
  /** the accents are fills; when one has to be read as text it darkens to these */
  coralDeep: '#C43D2E',
  skyDeep: '#1F6FCC',
  butterDeep: '#8A6400',
  mintDeep: '#1E8A66',
  /** cream type on ink */
  creamSoft: '#E3DACB',
} as const;

/** Semantic names the screens use. */
export const ui = {
  ground: ht.cream,
  panel: ht.paper,
  sunk: ht.sunk,
  line: ht.line,
  muted: ht.muted,
  text: ht.ink,
  text2: ht.inkMid,
  quiet: ht.inkSoft,
  dim: ht.muted,
  you: ht.sky,
  youWash: 'rgba(74,168,255,0.16)',
  watch: ht.butter,
  danger: ht.coral,
  dangerWash: 'rgba(255,107,92,0.16)',
  ok: ht.mint,
  pending: ht.lilac,
  link: ht.lilacDeep,
  /** every floating shape pairs cream with ink so it reads over the map */
  keyline: ht.ink,
  float: 'rgba(30,27,46,0.28)',
} as const;

// ---- names the older screens still use; all point at the cream palette ---------------------------------

export const night = {
  ground: ui.ground,
  glass: ui.panel,
  glassSolid: ui.panel,
  raised: ui.sunk,
  hair: ui.line,
  hairSoft: ui.line,
  handle: ui.muted,
  chip: ui.sunk,
  text: ui.text,
  text2: ui.text2,
  quiet: ui.quiet,
  dim: ui.dim,
  dimmer: ui.muted,
  you: ui.you,
  youGlow: ui.youWash,
  watch: ui.watch,
  danger: ui.danger,
  dangerWash: ui.dangerWash,
  day: ui.panel,
};

export const colors = {
  bg: ui.ground, card: ui.panel, border: ui.line, text: ui.text, muted: ui.quiet,
  accent: ht.skyDeep, danger: ht.coralDeep, ok: ht.mintDeep, warn: ht.butterDeep,
};
export const radius = 22;
export const levelColor = (level: string) =>
  ({ idle: ui.quiet, resolved: ht.mintDeep, check: ht.butterDeep, heads_up: ht.butterDeep, unlocked: ht.coralDeep, snatch: ht.coralDeep, sos: ht.coralDeep, offline: ui.quiet, battery_dying: ht.butterDeep }[level] ?? ui.quiet);

export const pip = {
  ground: ui.ground,
  ink: ui.text,
  ink2: ui.text2,
  sub: ui.quiet,
  faint: ui.dim,
  hair: ui.line,
  handle: ui.muted,
  chip: ui.sunk,
  link: ui.link,
  you: ui.you,
  zone: 'rgba(182,156,255,0.16)',
  shadow: ui.float,
  sosBg: ui.dangerWash,
  sosText: ht.coralDeep,
};

/**
 * How worried friends should be, as five states. `dot` fills the mark beside a name (always inside an ink keyline);
 * `hollow` marks are paper inside the keyline (home: recedes); `text` is the colour a headline may take.
 */
export type Tone = 'high' | 'mild' | 'out' | 'home' | 'offline';
export const tones: Record<Tone, { ring: string; bg: string; text: string; dot: string; dotOff: string; hollow: boolean; glow: string | null; label: string }> = {
  high: { ring: ht.coral, bg: ui.dangerWash, text: ht.coralDeep, dot: ht.coral, dotOff: 'rgba(255,107,92,0.3)', hollow: false, glow: 'rgba(255,107,92,0.7)', label: 'Friends alerted' },
  mild: { ring: ht.butter, bg: 'rgba(255,211,90,0.22)', text: ht.butterDeep, dot: ht.butter, dotOff: 'rgba(255,211,90,0.3)', hollow: false, glow: 'rgba(255,211,90,0.7)', label: 'On watch' },
  out: { ring: ht.mint, bg: 'rgba(61,214,163,0.16)', text: ui.text, dot: ht.mint, dotOff: 'rgba(61,214,163,0.3)', hollow: false, glow: null, label: 'Out tonight' },
  home: { ring: ht.line, bg: 'transparent', text: ui.quiet, dot: ht.paper, dotOff: 'rgba(230,216,189,0.5)', hollow: true, glow: null, label: 'Home' },
  offline: { ring: ht.muted, bg: 'transparent', text: ui.quiet, dot: ht.sunk, dotOff: 'rgba(184,172,150,0.4)', hollow: true, glow: null, label: 'Not streaming' },
};

// ---- type: Fredoka for display, Figtree for body, DM Mono for numbers ------------------------------------

/** Bundled on the phone (loaded in the root layout); the web page links the same families from Google Fonts. */
export const FONT_FILES = {
  'Fredoka-Medium': require('../assets/fonts/Fredoka-Medium.ttf'),
  'Fredoka-SemiBold': require('../assets/fonts/Fredoka-SemiBold.ttf'),
  'Fredoka-Bold': require('../assets/fonts/Fredoka-Bold.ttf'),
  'Figtree-Regular': require('../assets/fonts/Figtree-Regular.ttf'),
  'Figtree-Medium': require('../assets/fonts/Figtree-Medium.ttf'),
  'Figtree-SemiBold': require('../assets/fonts/Figtree-SemiBold.ttf'),
  'Figtree-Bold': require('../assets/fonts/Figtree-Bold.ttf'),
  'DMMono-Regular': require('../assets/fonts/DMMono-Regular.ttf'),
  'DMMono-Medium': require('../assets/fonts/DMMono-Medium.ttf'),
};
export const WEB_FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Figtree:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap';
export const WEB_DISPLAY_STACK = "Fredoka, ui-rounded, system-ui, sans-serif";
export const WEB_BODY_STACK = "Figtree, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const WEB_MONO_STACK = "'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export type Family = 'display' | 'body' | 'mono';

let nativeFontsLoaded = false;
export const setNativeFontsLoaded = (on: boolean) => { nativeFontsLoaded = on; };

const weightNumber = (w: TextStyle['fontWeight']): number => {
  if (w == null || w === 'normal') return 400;
  if (w === 'bold') return 700;
  const n = typeof w === 'number' ? w : parseInt(String(w), 10);
  return Number.isFinite(n) ? n : 400;
};

const FACES: Record<Family, { min: number; max: number; name: (w: number) => string }> = {
  display: { min: 500, max: 700, name: (w) => (w >= 700 ? 'Fredoka-Bold' : w >= 600 ? 'Fredoka-SemiBold' : 'Fredoka-Medium') },
  body: { min: 400, max: 700, name: (w) => (w >= 700 ? 'Figtree-Bold' : w >= 600 ? 'Figtree-SemiBold' : w >= 500 ? 'Figtree-Medium' : 'Figtree-Regular') },
  mono: { min: 400, max: 500, name: (w) => (w >= 500 ? 'DMMono-Medium' : 'DMMono-Regular') },
};
const STACK: Record<Family, string> = { display: WEB_DISPLAY_STACK, body: WEB_BODY_STACK, mono: WEB_MONO_STACK };

/**
 * The font for a family and weight. Static faces are bundled, so the weight snaps to the nearest one and is cleared
 * on the phone (Android would otherwise fake a bold on top of the real face).
 */
export function fontFor(weight: TextStyle['fontWeight'], family: Family = 'body'): Pick<TextStyle, 'fontFamily' | 'fontWeight'> {
  const f = FACES[family];
  const w = Math.min(f.max, Math.max(f.min, Math.round(weightNumber(weight) / 100) * 100));
  if (Platform.OS === 'web') return { fontFamily: STACK[family], fontWeight: String(w) as TextStyle['fontWeight'] };
  if (!nativeFontsLoaded) return { fontWeight: weight };
  return { fontFamily: f.name(w), fontWeight: 'normal' };
}

/** Display type sits a touch tighter as it grows. */
export function trackingFor(fontSize: number | undefined): number | undefined {
  if (!fontSize || fontSize < 24) return undefined;
  const pct = fontSize >= 40 ? 0.02 : fontSize >= 32 ? 0.015 : 0.01;
  return -Math.round(fontSize * pct * 100) / 100;
}
