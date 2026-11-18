import type { Hand, InputFrame, Point3 } from './types.ts';

// MediaPipe topology (hand: 21 points, pose: 33 points), as index pairs.
const HAND = [0, 1, 1, 2, 2, 3, 3, 4, 0, 5, 5, 6, 6, 7, 7, 8, 5, 9, 9, 10, 10, 11, 11, 12, 9, 13, 13, 14, 14, 15, 15, 16, 13, 17, 0, 17, 17, 18, 18, 19, 19, 20];
const POSE = [11, 12, 11, 13, 13, 15, 12, 14, 14, 16, 11, 23, 12, 24, 23, 24, 23, 25, 25, 27, 24, 26, 26, 28, 0, 11, 0, 12];

function bones(ctx: CanvasRenderingContext2D, pts: Point3[], pairs: number[], w: number, h: number): void {
  ctx.beginPath();
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pts[pairs[i]], b = pts[pairs[i + 1]];
    if (!a || !b) continue;
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
  }
  ctx.stroke();
  for (const p of pts) ctx.fillRect(p.x * w - 1.5, p.y * h - 1.5, 3, 3);
}

/** Clears `ctx` and draws tracked hands (and pose, if `withPose`) as thin guide lines over a w×h area. */
export function drawSkeleton(ctx: CanvasRenderingContext2D, frame: InputFrame, w: number, h: number, alpha: number, withPose: boolean): void {
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.strokeStyle = ctx.fillStyle = `rgba(255,255,255,${alpha})`;
  for (const hand of frame.hands) if (hand.kind === 'tracked') bones(ctx, hand.landmarks, HAND, w, h);
  if (withPose && frame.pose) {
    ctx.strokeStyle = ctx.fillStyle = `rgba(255,214,120,${alpha})`;
    bones(ctx, frame.pose, POSE, w, h);
  }
}

// --- virtual hand ---------------------------------------------------------------
// Finger chains (MCP → tip) with half-widths at each joint, in units of hand size (wrist → middle knuckle).
const FINGERS: [number[], number[]][] = [
  [[1, 2, 3, 4], [0.15, 0.125, 0.11, 0.095]], // thumb
  [[5, 6, 7, 8], [0.105, 0.095, 0.085, 0.075]],
  [[9, 10, 11, 12], [0.11, 0.1, 0.09, 0.078]],
  [[13, 14, 15, 16], [0.1, 0.09, 0.08, 0.07]],
  [[17, 18, 19, 20], [0.085, 0.075, 0.068, 0.06]],
];
const PALM = [0, 1, 5, 9, 13, 17];
const FLESH_ALPHA = 0.42; // translucent so the artwork stays readable through the hand

// Opaque silhouettes are drawn here first and composited once, so overlapping parts blend without double alpha.
let layer: HTMLCanvasElement | undefined;

/** Half-width at landmark `p`: nearer joints (MediaPipe z < 0) swell a little, like perspective. */
const radius = (p: Point3, r: number, s: number) => r * s * Math.min(1.35, Math.max(0.75, 1 - p.z * 1.5));

function silhouette(ctx: CanvasRenderingContext2D, lm: Point3[], w: number, h: number, s: number, grow: number): void {
  ctx.beginPath();
  for (let i = 0; i < PALM.length; i++) ctx.lineTo(lm[PALM[i]].x * w, lm[PALM[i]].y * h);
  ctx.closePath();
  ctx.lineWidth = 0.2 * s + 2 * grow; // round joins blend the palm edge into the finger roots
  ctx.fill();
  ctx.stroke();
  for (const [chain, widths] of FINGERS) {
    for (let j = 0; j < chain.length; j++) {
      const a = lm[chain[j]];
      const ax = a.x * w, ay = a.y * h, ra = radius(a, widths[j], s) + grow;
      ctx.beginPath();
      ctx.arc(ax, ay, ra, 0, Math.PI * 2);
      ctx.fill();
      if (j === chain.length - 1) break;
      // Tapered capsule body to the next joint: a quad between the two joint circles.
      const b = lm[chain[j + 1]];
      const bx = b.x * w, by = b.y * h, rb = radius(b, widths[j + 1], s) + grow;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / len, ny = (bx - ax) / len;
      ctx.beginPath();
      ctx.moveTo(ax + nx * ra, ay + ny * ra);
      ctx.lineTo(bx + nx * rb, by + ny * rb);
      ctx.lineTo(bx - nx * rb, by - ny * rb);
      ctx.lineTo(ax - nx * ra, ay - ny * ra);
      ctx.fill();
    }
  }
}

/** Hand size in screen px (wrist → middle knuckle); measured in px so a wide screen does not squash it. */
const sizePx = (hand: Hand, w: number, h: number) =>
  Math.hypot((hand.landmarks[0].x - hand.landmarks[9].x) * w, (hand.landmarks[0].y - hand.landmarks[9].y) * h);

/** Clears `ctx` and draws every tracked hand as a stylised translucent porcelain hand over a w×h area. */
export function drawHandFlesh(ctx: CanvasRenderingContext2D, frame: InputFrame, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  if (!frame.hands.some((hand) => hand.kind === 'tracked' && hand.landmarks.length === 21)) return;
  layer ??= document.createElement('canvas');
  if (layer.width !== w || layer.height !== h) Object.assign(layer, { width: w, height: h });
  const g = layer.getContext('2d')!;
  g.clearRect(0, 0, w, h);
  g.lineJoin = g.lineCap = 'round';

  for (const hand of frame.hands) {
    if (hand.kind !== 'tracked' || hand.landmarks.length !== 21) continue;
    const lm = hand.landmarks, s = sizePx(hand, w, h);
    // Rim: a slightly grown silhouette in cool white, then the body on top leaves a thin bright edge.
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = g.strokeStyle = '#eef6ff';
    silhouette(g, lm, w, h, s, Math.max(1.2, s * 0.012));
    g.fillStyle = g.strokeStyle = '#b8b3c6';
    silhouette(g, lm, w, h, s, 0);

    // Volume: light falls from the palm centre, cooler shade towards the fingertips.
    g.globalCompositeOperation = 'source-atop';
    const px = (lm[0].x + lm[9].x) / 2 * w, py = (lm[0].y + lm[9].y) / 2 * h;
    const body = g.createRadialGradient(px - s * 0.15, py - s * 0.2, 0, px, py, s * 2.1);
    body.addColorStop(0, 'rgba(255,252,246,0.85)');
    body.addColorStop(0.45, 'rgba(236,232,240,0.25)');
    body.addColorStop(1, 'rgba(92,96,128,0.55)');
    g.fillStyle = body;
    g.fillRect(px - s * 2.2, py - s * 2.2, s * 4.4, s * 4.4);

    // Soft highlight ridge along each finger reads as a rounded, cylindrical surface.
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.shadowColor = 'rgba(255,255,255,0.8)';
    g.shadowBlur = s * 0.06;
    g.lineWidth = s * 0.05;
    g.beginPath();
    for (const [chain] of FINGERS) {
      g.moveTo(lm[chain[0]].x * w, lm[chain[0]].y * h);
      for (let j = 1; j < chain.length; j++) g.lineTo(lm[chain[j]].x * w, lm[chain[j]].y * h);
    }
    g.stroke();
    g.shadowBlur = 0;
  }
  g.globalCompositeOperation = 'source-over';

  ctx.globalAlpha = FLESH_ALPHA;
  ctx.drawImage(layer, 0, 0);
  ctx.globalAlpha = 1;

  // Thumb and index tips glow brighter as the fingers close: the pinch is the verb, so show it coming.
  ctx.globalCompositeOperation = 'lighter';
  for (const hand of frame.hands) {
    if (hand.kind !== 'tracked' || hand.landmarks.length !== 21 || hand.pinchStrength < 0.05) continue;
    const s = sizePx(hand, w, h), p = hand.pinchStrength;
    for (let i = 4; i <= 8; i += 4) { // thumb tip, index tip
      const x = hand.landmarks[i].x * w, y = hand.landmarks[i].y * h, r = s * (0.14 + 0.12 * p);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
      glow.addColorStop(0, `rgba(255,246,228,${0.75 * p})`);
      glow.addColorStop(1, 'rgba(255,246,228,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}
