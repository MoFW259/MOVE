import type { GestureName, Point3 } from '../types.ts';

const dist = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y);

// Landmark indices: https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8, MIDDLE_MCP = 9, PINKY_MCP = 17;
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]] as const; // [tip, pip]

/** Thresholds as [on, off]; the gap is the hysteresis band. */
export const THRESHOLDS = {
  extended: [1.15, 1.05], // wrist→tip / wrist→pip
  thumbOut: [0.9, 0.75], // thumb tip→pinky MCP / hand size
  fist: [0.9, 1.05], // mean tip→middle MCP / hand size (lower = closed)
  pinch: [0.3, 0.45], // thumb tip→index tip / hand size
  swipe: [2.5, 1.5], // wrist speed, normalized units / s
} as const;

const on = (prev: boolean, v: number, [hi, lo]: readonly [number, number]) => (prev ? v > lo : v > hi);
const below = (prev: boolean, v: number, [lo, hi]: readonly [number, number]) => (prev ? v < hi : v < lo);

export const noGestures = (): Record<GestureName, boolean> =>
  ({ open: false, fist: false, pinch: false, point: false, swipe: false });

/** 0 (thumb and index far apart) … 1 (touching): continuous pinch closure, for cursor feedback before the pinch fires. */
export function pinchStrength(lm: Point3[]): number {
  const r = dist(lm[THUMB_TIP], lm[INDEX_TIP]) / (dist(lm[WRIST], lm[MIDDLE_MCP]) || 1e-6);
  return Math.min(1, Math.max(0, (0.8 - r) / (0.8 - THRESHOLDS.pinch[0])));
}

/** Stateful per-hand classifier; keep one instance per tracked hand id. */
export class GestureState {
  private fingers = [false, false, false, false];
  private thumb = false;
  readonly gestures = noGestures();

  update(lm: Point3[], wristSpeed: number): Record<GestureName, boolean> {
    const size = dist(lm[WRIST], lm[MIDDLE_MCP]) || 1e-6;
    this.fingers = FINGERS.map(([tip, pip], i) =>
      on(this.fingers[i], dist(lm[WRIST], lm[tip]) / (dist(lm[WRIST], lm[pip]) || 1e-6), THRESHOLDS.extended));
    this.thumb = on(this.thumb, dist(lm[THUMB_TIP], lm[PINKY_MCP]) / size, THRESHOLDS.thumbOut);
    const curl = FINGERS.reduce((s, [tip]) => s + dist(lm[tip], lm[MIDDLE_MCP]), 0) / FINGERS.length / size;
    const [index, middle, ring, pinky] = this.fingers;
    const g = this.gestures;
    g.open = this.thumb && this.fingers.every(Boolean);
    g.fist = below(g.fist, curl, THRESHOLDS.fist) && !this.fingers.some(Boolean);
    g.pinch = below(g.pinch, dist(lm[THUMB_TIP], lm[INDEX_TIP]) / size, THRESHOLDS.pinch);
    g.point = index && !middle && !ring && !pinky;
    g.swipe = on(g.swipe, wristSpeed, THRESHOLDS.swipe);
    return g;
  }
}
