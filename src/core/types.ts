import type * as THREE from 'three';

export type GestureName = 'open' | 'fist' | 'pinch' | 'point' | 'swipe';
export type Need = 'segmentation' | 'hands' | 'pose' | 'face';

/** Normalized 0..1, origin top-left, mirrored (selfie view). z is MediaPipe's relative depth. */
export interface Point3 { x: number; y: number; z: number }
export type PoseLandmarks = Point3[];

export interface Hand {
  /** 'hand-<n>' for tracked hands (stable while tracked), 'pointer-<pointerId>' for mouse/touch. */
  id: string;
  kind: 'tracked' | 'pointer';
  /** Index fingertip (tracked) or pointer position. */
  cursor: Point3;
  /**
   * Midpoint of thumb and index tips (tracked) or pointer position. Use this for selecting and grabbing:
   * it barely moves when the fingers close, unlike the index tip.
   */
  pinchPoint: Point3;
  /** 0 = thumb and index apart … 1 = touching (pointer: 0 or 1). Drive hover/press feedback with it. */
  pinchStrength: number;
  /** Wrist→middle knuckle length, normalized (tracked only; pointer 0). Grows as the hand nears the camera. */
  size: number;
  /** 21 MediaPipe hand landmarks; for pointer hands all equal `cursor`. */
  landmarks: Point3[];
  /** Cursor velocity in normalized units per second. */
  velocity: { x: number; y: number };
  gestures: Record<GestureName, boolean>;
}

export interface InputFrame {
  time: number;
  source: 'camera' | 'fixture' | 'pointer';
  /** Mirrored camera image. GL orientation: sample landmark p at vec2(p.x, 1.0 - p.y). */
  camera?: THREE.Texture;
  /** Person silhouette 0..1 (red channel), same orientation as `camera`. */
  mask?: THREE.Texture;
  hands: Hand[];
  pose?: PoseLandmarks;
  face?: { landmarks: Point3[]; blendshapes: Record<string, number> };
}

export interface Experience {
  id: string;
  title: string;
  hint: { text: string; gesture: GestureName };
  needs: Need[];
  /** One Euro filter strength for landmarks. Lower minCutoff = smoother, higher beta = less lag. */
  filter?: { minCutoff: number; beta: number };
  init(ctx: { renderer: THREE.WebGLRenderer }): Promise<void>;
  frame(input: InputFrame, dt: number): void;
  resize(width: number, height: number): void;
  /** Must release every GPU resource it created. */
  dispose(): void;
}

/**
 * Poster data for the main grid: `src/experiences/<id>/meta.ts` default-exports one.
 * Loaded eagerly (keep it tiny, no three.js imports). Folders without meta.ts are reachable by URL only.
 */
export interface ExperienceMeta {
  title: string; // Korean title, also used as Experience.title
  subtitle: string; // English subtitle, poster typography
  date: string; // poster date line, e.g. 'november, twenty-six'
  bg: string; // poster background color
  ink: string; // poster foreground color
  order: number; // position on the grid (ascending)
}
