import React, { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { TelemetryTick } from '@/modules/safety-native';
import { TREND_SECONDS, type TelemetryBuffers } from '@/lib/telemetry';
import { colors, radius } from '@/lib/theme';
import { LiveCanvas } from './LiveCanvas';
import type { DrawFn } from './LiveCanvas.types';
import { SERIES, drawSpans, drawTrace, fill, hband, hgrid, hline, label, traceMax, vgrid } from './draw';

const WINDOWS = [10, 30, 60] as const;
const IMPACT_G = 2.5; // CONTRACTS §6: impact = peak > 2.5 g with orientation change
const BAND_SD = 2.5;

/**
 * Left column: the scrolling |a| (g) and |ω| (rad/s) traces at the incoming sample rate, then a 5-min strip of the
 * microphone listening window. All three are canvases fed straight from the buffers.
 */
export function WaveformPanel({ buffers, tick }: { buffers: TelemetryBuffers; tick: TelemetryTick | null }) {
  const [windowSec, setWindowSec] = useState<(typeof WINDOWS)[number]>(10);
  // Smoothed y-axis maxima, mutated from the rAF draw callbacks only (never during render).
  const scale = useRef({ accel: 3.2, gyro: 2 });

  const accelDraw = useMemo<DrawFn>(() => {
    return (ctx, w, h, now) => {
      fill(ctx, w, h, colors.bg);
      const r = { x: 0, y: 16, w, h: h - 20 };
      const peak = traceMax(buffers, 'accel', windowSec, now);
      scale.current.accel += (Math.max(3.2, peak * 1.15) - scale.current.accel) * 0.1;
      const hi = scale.current.accel;
      hgrid(ctx, r, 4);
      vgrid(ctx, r, windowSec, windowSec >= 30 ? 10 : 1);
      const band = buffers.tick?.metrics.bands.find((b) => b.name === 'peak_g');
      if (band && band.sd > 0) hband(ctx, r, band.mean - BAND_SD * band.sd, band.mean + BAND_SD * band.sd, 0, hi, `${SERIES.accel}14`);
      hline(ctx, r, 1, 0, hi, SERIES.axis, undefined, false);
      hline(ctx, r, IMPACT_G, 0, hi, colors.danger, `impact ${IMPACT_G} g`);
      drawTrace(ctx, r, buffers, 'accel', windowSec, 0, hi, SERIES.accel, now);
      label(ctx, `|a|  0–${hi.toFixed(1)} g`, 4, 2, SERIES.accel);
      label(ctx, `${windowSec} s · ${buffers.sampleHz.toFixed(1)} Hz`, w - 4, 2, colors.muted, 'right');
      if (!buffers.count) label(ctx, 'waiting for samples…', w / 2, h / 2 - 6, colors.muted, 'center');
    };
  }, [buffers, windowSec]);

  const gyroDraw = useMemo<DrawFn>(() => {
    return (ctx, w, h, now) => {
      fill(ctx, w, h, colors.bg);
      const r = { x: 0, y: 16, w, h: h - 20 };
      const peak = traceMax(buffers, 'gyro', windowSec, now);
      scale.current.gyro += (Math.max(2, peak * 1.15) - scale.current.gyro) * 0.1;
      const hi = scale.current.gyro;
      hgrid(ctx, r, 4);
      vgrid(ctx, r, windowSec, windowSec >= 30 ? 10 : 1);
      const band = buffers.tick?.metrics.bands.find((b) => b.name === 'rotation');
      if (band && band.sd > 0) {
        hband(ctx, r, band.mean - BAND_SD * band.sd, band.mean + BAND_SD * band.sd, 0, hi, `${SERIES.gyro}14`);
        hline(ctx, r, band.mean + BAND_SD * band.sd, 0, hi, `${SERIES.gyro}99`, `rotation band +${BAND_SD} SD`);
      }
      drawTrace(ctx, r, buffers, 'gyro', windowSec, 0, hi, SERIES.gyro, now);
      label(ctx, `|ω|  0–${hi.toFixed(1)} rad/s`, 4, 2, SERIES.gyro);
      if (buffers.tick && !buffers.tick.samplingFull) label(ctx, 'gyro off (low-rate mode)', w - 4, 2, colors.muted, 'right');
    };
  }, [buffers, windowSec]);

  const micDraw = useMemo<DrawFn>(() => (ctx, w, h, now) => {
    fill(ctx, w, h, colors.bg);
    const r = { x: 0, y: 15, w, h: h - 16 };
    drawSpans(ctx, r, buffers.trend, now, TREND_SECONDS, (p) => p.listening, `${colors.warn}55`);
    vgrid(ctx, r, TREND_SECONDS, 60);
    const last = buffers.trend[buffers.trend.length - 1];
    label(ctx, 'Mic listening · 5 min', 4, 2, colors.text);
    if (last) label(ctx, last.listening ? 'listening' : 'off', w - 4, 2, last.listening ? colors.warn : colors.muted, 'right');
  }, [buffers]);

  const tickPeak = tick ? Math.max(0, ...tick.accel) : 0;
  const tickGyro = tick ? Math.max(0, ...tick.gyro) : 0;

  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <Text style={styles.title}>Motion</Text>
        <Text style={styles.meta}>
          {tick ? `peak ${tickPeak.toFixed(2)} g · ${tickGyro.toFixed(2)} rad/s · ${tick.accel.length} samples/frame · drawn ${Math.round(buffers.displayDelayMs())} ms behind` : 'no samples yet'}
        </Text>
        <View style={{ flex: 1 }} />
        <View style={styles.seg}>
          {WINDOWS.map((s) => (
            <Pressable key={s} onPress={() => setWindowSec(s)} accessibilityRole="button" accessibilityState={{ selected: s === windowSec }} style={[styles.segBtn, s === windowSec && styles.segOn]}>
              <Text style={[styles.segText, s === windowSec && { color: colors.text }]}>{s} s</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <LiveCanvas draw={accelDraw} height={110} fps={60} testID="wave-accel" placeholder="Accelerometer |a| trace" />
      <LiveCanvas draw={gyroDraw} height={84} fps={60} testID="wave-gyro" placeholder="Gyroscope |ω| trace" />
      <LiveCanvas draw={micDraw} height={30} fps={10} testID="trend-mic" placeholder="Mic listening 5-min strip" />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.card, borderRadius: radius, padding: 10, gap: 6, borderWidth: 1, borderColor: colors.border },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  title: { color: colors.text, fontSize: 15, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  seg: { flexDirection: 'row', borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden' },
  segBtn: { paddingVertical: 4, paddingHorizontal: 10 },
  segOn: { backgroundColor: colors.border },
  segText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
});
