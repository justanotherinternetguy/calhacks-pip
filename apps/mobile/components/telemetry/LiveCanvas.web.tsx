import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { colors } from '@/lib/theme';
import type { LiveCanvasProps } from './LiveCanvas.types';

/**
 * Web renderer: a plain DOM <canvas> inside a react-native-web View. react-native-web renders Views as divs and
 * passes raw DOM elements through, so the canvas is created by React DOM like any other intrinsic element
 * (same trick components/Map.web.tsx uses for Leaflet's <div>). The host div is observed for size; the canvas
 * backing store follows devicePixelRatio (capped at 2) and `draw` runs in a requestAnimationFrame loop
 * throttled to `fps`. Nothing re-renders through React on data changes — renderers read mutable buffers.
 */
export function LiveCanvas({ draw, height, fps = 60, style, testID }: LiveCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef(draw);
  useEffect(() => { drawRef.current = draw; }, [draw]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let last = -Infinity;
    let w = 1, h = height, dpr = 1;
    const minFrameMs = 1000 / Math.max(1, fps) - 1;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect.width));
      h = height;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      last = -Infinity; // force a frame
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(host);
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      if (ts - last < minFrameMs) return;
      last = ts;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawRef.current(ctx, w, h, Date.now());
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [height, fps]);

  return (
    <View testID={testID} style={[{ height, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border }, style]}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }}>
        <canvas ref={canvasRef} style={{ display: 'block', pointerEvents: 'none' }} />
      </div>
    </View>
  );
}
