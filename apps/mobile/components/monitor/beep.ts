import { Platform } from 'react-native';

/**
 * Short two-tone WebAudio beep for "a new incident just opened" (web only; native gets a push instead).
 * Browsers only let an AudioContext start from a user gesture, so `primeAudio()` is called from the
 * sound toggle; if the page was never clicked the beep is silently skipped.
 */
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  return ctx;
}

export function primeAudio() {
  const c = context();
  if (c && c.state === 'suspended') void c.resume().catch(() => {});
}

export function beep() {
  const c = context();
  if (!c) return;
  if (c.state === 'suspended') void c.resume().catch(() => {});
  const tone = (freq: number, at: number, dur: number) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  };
  const t = c.currentTime;
  tone(880, t, 0.14);
  tone(1320, t + 0.17, 0.2);
}
