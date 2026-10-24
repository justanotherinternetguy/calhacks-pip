// Pure canvas-2D drawing for the telemetry console. No chart library: every renderer below is a plain
// function of (ctx, rect, data, now). Only called from LiveCanvas.web.tsx's requestAnimationFrame loop;
// the DOM types come from tsconfig's `lib: ["DOM"]`, so this file typechecks on native too (it is just never run there).
import type { TelemetryBuffers, TrendPoint } from '@/lib/telemetry';
import { colors } from '@/lib/theme';

export type Rect = { x: number; y: number; w: number; h: number };
export const FONT = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const SERIES = { accel: '#7c9cff', gyro: '#c084fc', danger: colors.danger, grid: '#1b2130', axis: '#2a3245' } as const;
export const STATE_FILL = ['#34d399', '#fbbf24', '#ff3b5c', '#9f1239'] as const; // normal, impaired, incident, unresponsive

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const yFor = (r: Rect, v: number, lo: number, hi: number) => r.y + r.h - ((clamp(v, lo, hi) - lo) / (hi - lo)) * r.h;

export function fill(ctx: CanvasRenderingContext2D, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
}

export function hgrid(ctx: CanvasRenderingContext2D, r: Rect, rows: number, color: string = SERIES.grid) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= rows; i++) {
    const y = Math.round(r.y + (r.h * i) / rows) + 0.5;
    ctx.moveTo(r.x, y);
    ctx.lineTo(r.x + r.w, y);
  }
  ctx.stroke();
}

/** Vertical time grid every `stepSec` seconds, anchored to the right edge (now). */
export function vgrid(ctx: CanvasRenderingContext2D, r: Rect, windowSec: number, stepSec: number, color: string = SERIES.grid) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let s = stepSec; s < windowSec; s += stepSec) {
    const x = Math.round(r.x + r.w - (s / windowSec) * r.w) + 0.5;
    ctx.moveTo(x, r.y);
    ctx.lineTo(x, r.y + r.h);
  }
  ctx.stroke();
}

export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string = colors.muted, align: CanvasTextAlign = 'left') {
  ctx.font = FONT;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
}

export function hline(ctx: CanvasRenderingContext2D, r: Rect, v: number, lo: number, hi: number, color: string, text?: string, dashed = true) {
  if (v < lo || v > hi) return;
  const y = Math.round(yFor(r, v, lo, hi)) + 0.5;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  if (dashed) ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(r.x, y);
  ctx.lineTo(r.x + r.w, y);
  ctx.stroke();
  ctx.restore();
  if (text) label(ctx, text, r.x + r.w - 4, y - 13, color, 'right');
}

/** Shaded horizontal band between two values (a baseline band, mean ± k SD). */
export function hband(ctx: CanvasRenderingContext2D, r: Rect, lo: number, hi: number, yLo: number, yHi: number, color: string) {
  const a = yFor(r, Math.max(lo, yLo), yLo, yHi);
  const b = yFor(r, Math.min(hi, yHi), yLo, yHi);
  if (b >= a) return;
  ctx.fillStyle = color;
  ctx.fillRect(r.x, b, r.w, a - b);
}

/**
 * Display-time geometry shared by the sample trace renderers. Samples sit on the phone's sensor clock (mapped to
 * local time by the buffers' skew floor) and are drawn `displayDelayMs()` behind wall-clock, so a frame that lands
 * late still scrolls in continuously instead of jumping; the viewport moves at constant speed.
 */
export function traceWindow(buf: TelemetryBuffers, windowSec: number, nowMs: number) {
  const rightT = nowMs - buf.displayDelayMs();
  return { rightT, leftT: rightT - windowSec * 1000, span: windowSec * 1000 };
}

/** Max |value| of the samples currently inside the display window (for autoscaling). */
export function traceMax(buf: TelemetryBuffers, which: 'accel' | 'gyro', windowSec: number, nowMs: number): number {
  const { rightT, leftT } = traceWindow(buf, windowSec, nowMs);
  let max = 0;
  for (let k = 0; k < buf.count; k++) {
    const t = buf.sampleTimeLocal(k);
    if (t > rightT) continue;
    if (t < leftT) break;
    const v = buf.sample(which, k);
    if (v > max) max = v;
  }
  return max;
}

/** The scrolling |a| / |ω| trace: newest sample at the (delayed) right edge, one polyline, clamped to [lo, hi]. */
export function drawTrace(ctx: CanvasRenderingContext2D, r: Rect, buf: TelemetryBuffers, which: 'accel' | 'gyro', windowSec: number, lo: number, hi: number, color: string, nowMs: number) {
  if (!buf.count) return;
  const { rightT, leftT, span } = traceWindow(buf, windowSec, nowMs);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  for (let k = 0; k < buf.count; k++) {
    const t = buf.sampleTimeLocal(k);
    if (t > rightT) continue;
    if (t < leftT) break;
    const x = r.x + ((t - leftT) / span) * r.w;
    const y = yFor(r, buf.sample(which, k), lo, hi);
    if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
  }
  ctx.stroke();
  ctx.restore();
}

const xForTrend = (r: Rect, p: TrendPoint, nowMs: number, windowMs: number) => r.x + r.w - ((nowMs - p.at) / windowMs) * r.w;

/** A trend line over the last `windowSec` (by local arrival time), optional area fill under it. */
export function drawTrendLine(
  ctx: CanvasRenderingContext2D, r: Rect, pts: TrendPoint[], nowMs: number, windowSec: number,
  getV: (p: TrendPoint) => number, lo: number, hi: number, color: string, fillColor?: string,
) {
  if (!pts.length) return;
  const windowMs = windowSec * 1000;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.beginPath();
  let firstX = 0, lastX = 0, started = false;
  for (const p of pts) {
    if (nowMs - p.at > windowMs) continue;
    const x = xForTrend(r, p, nowMs, windowMs);
    const y = yFor(r, getV(p), lo, hi);
    if (!started) { ctx.moveTo(x, y); firstX = x; started = true; } else ctx.lineTo(x, y);
    lastX = x;
  }
  if (started && fillColor) {
    ctx.save();
    ctx.lineTo(lastX, r.y + r.h);
    ctx.lineTo(firstX, r.y + r.h);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.restore();
    // re-trace the line on top of the fill
    ctx.beginPath();
    started = false;
    for (const p of pts) {
      if (nowMs - p.at > windowMs) continue;
      const x = xForTrend(r, p, nowMs, windowMs);
      const y = yFor(r, getV(p), lo, hi);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

/** Four HMM probabilities as a 100 % stacked area: normal at the bottom, unresponsive on top. */
export function drawStack(ctx: CanvasRenderingContext2D, r: Rect, pts: TrendPoint[], nowMs: number, windowSec: number) {
  if (!pts.length) return;
  const windowMs = windowSec * 1000;
  const visible = pts.filter((p) => nowMs - p.at <= windowMs);
  if (!visible.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  // Draw the largest cumulative first; each lower layer paints over it.
  for (let layer = 3; layer >= 0; layer--) {
    ctx.beginPath();
    let firstX = 0, lastX = 0;
    visible.forEach((p, i) => {
      let cum = 0;
      for (let j = 0; j <= layer; j++) cum += p.p[j];
      const x = xForTrend(r, p, nowMs, windowMs);
      const y = yFor(r, cum, 0, 1);
      if (i === 0) { ctx.moveTo(x, y); firstX = x; } else ctx.lineTo(x, y);
      lastX = x;
    });
    ctx.lineTo(lastX, r.y + r.h);
    ctx.lineTo(firstX, r.y + r.h);
    ctx.closePath();
    ctx.fillStyle = STATE_FILL[layer];
    ctx.fill();
  }
  ctx.restore();
}

/** One metric's signed SD distance over the last `windowSec`, with the ±2.5 SD band shaded. */
export function drawSdSparkline(ctx: CanvasRenderingContext2D, r: Rect, pts: TrendPoint[], name: string, nowMs: number, windowSec: number, bandSd: number, out: boolean) {
  const lo = -5, hi = 5;
  hband(ctx, r, -bandSd, bandSd, lo, hi, '#ffffff0d');
  ctx.strokeStyle = SERIES.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const y0 = Math.round(yFor(r, 0, lo, hi)) + 0.5;
  ctx.moveTo(r.x, y0);
  ctx.lineTo(r.x + r.w, y0);
  ctx.stroke();
  drawTrendLine(ctx, r, pts, nowMs, windowSec, (p) => p.sd[name] ?? 0, lo, hi, out ? colors.danger : colors.accent);
}
