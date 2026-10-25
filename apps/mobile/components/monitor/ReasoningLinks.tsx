// Arrows from the incident log to the AI read (web console only). Rows and reasoning nodes register their DOM
// element under a key ("inc-12", "as-12", "dr-0", "ai-total"); one fixed SVG overlay draws a curve per link from the
// boxes' live positions, so the arrows follow scrolling in either column. Hovering a row or node focuses its links.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

export type LinkSpec = {
  from: string;
  to: string;
  color: string;
  /** 1-4 px */
  width: number;
  /** cross = between columns (left box's right edge → right box's left edge); inner = within one column, looping out
   * to the right of both boxes */
  kind: 'cross' | 'inner';
  /** focus keys this link belongs to ("i12", "d0"): hovering any of them highlights it */
  focus: string[];
};

type Registry = { set: (key: string, el: unknown) => void; get: (key: string) => HTMLElement | undefined };
const RegistryCtx = createContext<Registry | null>(null);
const FocusCtx = createContext<{ focus: string | null; setFocus: (k: string | null) => void }>({ focus: null, setFocus: () => {} });

export function LinkProvider({ children }: { children: React.ReactNode }) {
  const map = useRef(new Map<string, HTMLElement>());
  const registry = useMemo<Registry>(() => ({
    set: (key, el) => {
      if (el && typeof (el as HTMLElement).getBoundingClientRect === 'function') map.current.set(key, el as HTMLElement);
      else map.current.delete(key);
    },
    get: (key) => map.current.get(key),
  }), []);
  const [focus, setFocus] = useState<string | null>(null);
  const focusValue = useMemo(() => ({ focus, setFocus }), [focus]);
  return (
    <RegistryCtx.Provider value={registry}>
      <FocusCtx.Provider value={focusValue}>{children}</FocusCtx.Provider>
    </RegistryCtx.Provider>
  );
}

/** Ref callback that registers a box under `key` (no-op off the web or outside a provider). */
export function useAnchor(key: string) {
  const reg = useContext(RegistryCtx);
  return useCallback((el: unknown) => reg?.set(key, el), [reg, key]);
}

/** Hover handlers that focus `key`'s links, plus whether `key` is focused / something else is. */
export function useFocusKey(key: string) {
  const { focus, setFocus } = useContext(FocusCtx);
  return {
    focused: focus === key,
    dimmed: focus != null && focus !== key,
    hover: { onHoverIn: () => setFocus(key), onHoverOut: () => setFocus(null) },
  };
}

type Drawn = { d: string; head: string; color: string; width: number; opacity: number; dashed: boolean };

/** Nearest scrolling ancestor's visible box (the column), cached per element. */
const clipCache = new WeakMap<HTMLElement, HTMLElement | null>();
function clipOf(el: HTMLElement): DOMRect | null {
  let c = clipCache.get(el);
  if (c === undefined) {
    c = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if (o === 'auto' || o === 'scroll') { c = p; break; }
    }
    clipCache.set(el, c);
  }
  return c ? c.getBoundingClientRect() : null;
}

/** The box's vertical centre clamped into its column; `off` when the box itself is scrolled out of view. */
function anchorY(el: HTMLElement, r: DOMRect): { y: number; off: boolean } {
  const mid = r.top + Math.min(r.height / 2, 22);
  const clip = clipOf(el);
  if (!clip) return { y: mid, off: false };
  const lo = clip.top + 6, hi = clip.bottom - 6;
  return { y: Math.min(hi, Math.max(lo, mid)), off: mid < lo || mid > hi };
}

function draw(links: LinkSpec[], reg: Registry, focus: string | null): Drawn[] {
  const out: Drawn[] = [];
  for (const l of links) {
    const a = reg.get(l.from), b = reg.get(l.to);
    if (!a || !b || !a.isConnected || !b.isConnected) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    if (!ra.width || !rb.width) continue;
    const pa = anchorY(a, ra), pb = anchorY(b, rb);
    const hit = focus != null && l.focus.includes(focus);
    const opacity = focus == null ? (pa.off || pb.off ? 0.25 : 0.6) : hit ? 1 : 0.08;
    const width = l.width + (hit ? 1 : 0);
    if (l.kind === 'cross') {
      if (ra.right > rb.left - 12) continue; // columns stacked: no room for a cross arrow
      const x1 = ra.right + 2, x2 = rb.left - 3;
      const dx = Math.max(24, (x2 - x1) / 2);
      out.push({
        d: `M ${x1} ${pa.y} C ${x1 + dx} ${pa.y}, ${x2 - dx} ${pb.y}, ${x2} ${pb.y}`,
        head: `M ${x2 + 2} ${pb.y} L ${x2 - 6} ${pb.y - 4.5} L ${x2 - 6} ${pb.y + 4.5} Z`,
        color: l.color, width, opacity, dashed: pa.off || pb.off,
      });
    } else {
      const x1 = ra.right + 2, x2 = rb.right + 2;
      const bulge = 16 + Math.min(40, Math.abs(pb.y - pa.y) / 8);
      const xr = Math.max(x1, x2) + bulge;
      out.push({
        d: `M ${x1} ${pa.y} C ${xr} ${pa.y}, ${xr} ${pb.y}, ${x2} ${pb.y}`,
        head: `M ${x2 - 1} ${pb.y} L ${x2 + 7} ${pb.y - 4.5} L ${x2 + 7} ${pb.y + 4.5} Z`,
        color: l.color, width, opacity, dashed: pa.off || pb.off,
      });
    }
  }
  return out;
}

/** The fixed overlay. Mount once inside LinkProvider, after the columns. Renders nothing off the web. */
export function LinkOverlay({ links }: { links: LinkSpec[] }) {
  const reg = useContext(RegistryCtx);
  const { focus } = useContext(FocusCtx);
  const [paths, setPaths] = useState<Drawn[]>([]);
  const sig = useRef('');
  const inputs = useRef({ links, focus });

  useEffect(() => {
    if (Platform.OS !== 'web' || !reg) return;
    let frame = 0;
    const compute = () => {
      frame = 0;
      const next = draw(inputs.current.links, reg, inputs.current.focus);
      const s = next.map((p) => p.d + p.opacity + p.width).join('|');
      if (s !== sig.current) { sig.current = s; setPaths(next); }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(compute); };
    // Scroll (any column, captured), resize, and a slow tick for layout changes nothing else announces.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const tick = setInterval(schedule, 250);
    schedule();
    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      clearInterval(tick);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [reg]);
  // links / focus changed: redraw on the next frame
  useEffect(() => {
    inputs.current = { links, focus };
    if (Platform.OS !== 'web' || !reg) return;
    const f = requestAnimationFrame(() => {
      const next = draw(links, reg, focus);
      sig.current = next.map((p) => p.d + p.opacity + p.width).join('|');
      setPaths(next);
    });
    return () => cancelAnimationFrame(f);
  }, [links, focus, reg]);

  if (Platform.OS !== 'web' || !paths.length) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.overlay]}>
      <Svg width="100%" height="100%" style={{ pointerEvents: 'none' } as object}>
        {paths.map((p, i) => (
          <React.Fragment key={i}>
            <Path d={p.d} stroke={p.color} strokeWidth={p.width} strokeOpacity={p.opacity} fill="none" strokeDasharray={p.dashed ? '4 4' : undefined} />
            <Path d={p.head} fill={p.color} fillOpacity={p.opacity} />
          </React.Fragment>
        ))}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  // `fixed` is web-only (react-native-web passes it through); the overlay is never rendered on native.
  overlay: { position: 'fixed' as 'absolute', zIndex: 20 },
});
