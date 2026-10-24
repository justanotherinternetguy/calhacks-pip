import type { ViewProps } from 'react-native';

/** Draws one frame. `w`/`h` are CSS pixels (the context is already scaled for devicePixelRatio). */
export type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number, nowMs: number) => void;

export type LiveCanvasProps = {
  draw: DrawFn;
  height: number;
  /** Frame cap. 60 for the scrolling traces, lower (5–10) for trend strips and sparklines. */
  fps?: number;
  style?: ViewProps['style'];
  /** Native only: text shown instead of the canvas. */
  placeholder?: string;
  testID?: string;
};
