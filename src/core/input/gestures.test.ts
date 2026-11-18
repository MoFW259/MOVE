import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GestureState } from './gestures.ts';

// Synthetic upright right hand; wrist at the bottom, hand size (wrist→middle MCP) = 0.15.
type P = { x: number; y: number; z: number };
const p = (x: number, y: number): P => ({ x, y, z: 0 });
const FINGER_X = [0.44, 0.5, 0.55, 0.59];

function hand({ fingers = [true, true, true, true], thumbOut = true, thumbTip }: { fingers?: boolean[]; thumbOut?: boolean; thumbTip?: P } = {}): P[] {
  const lm: P[] = [p(0.5, 0.8), p(0.45, 0.76), p(0.42, 0.72), p(0.39, 0.68)];
  lm.push(thumbTip ?? (thumbOut ? p(0.35, 0.65) : p(0.52, 0.68)));
  FINGER_X.forEach((x, i) => {
    const ys = fingers[i] ? [0.65, 0.58, 0.53, 0.48] : [0.65, 0.6, 0.63, 0.66];
    for (const y of ys) lm.push(p(x, y));
  });
  return lm;
}

const active = (g: Record<string, boolean>) => Object.keys(g).filter((k) => g[k]).sort();

test('classifies the basic vocabulary', () => {
  assert.deepEqual(active(new GestureState().update(hand(), 0)), ['open']);
  assert.deepEqual(active(new GestureState().update(hand({ fingers: [false, false, false, false], thumbOut: false }), 0)), ['fist']);
  assert.deepEqual(active(new GestureState().update(hand({ fingers: [true, false, false, false], thumbOut: false }), 0)), ['point']);
  assert.ok(new GestureState().update(hand({ thumbTip: p(0.44, 0.49) }), 0).pinch);
  assert.ok(new GestureState().update(hand(), 3).swipe);
});

test('pinch and swipe use hysteresis', () => {
  // Thumb→index distance 0.06 / 0.15 = 0.4: between on (0.3) and off (0.45).
  const between = hand({ thumbTip: p(0.44, 0.54) });
  assert.equal(new GestureState().update(between, 0).pinch, false);
  const g = new GestureState();
  g.update(hand({ thumbTip: p(0.44, 0.49) }), 0);
  assert.equal(g.update(between, 0).pinch, true);

  const s = new GestureState();
  assert.equal(s.update(hand(), 2).swipe, false);
  s.update(hand(), 3);
  assert.equal(s.update(hand(), 2).swipe, true);
  assert.equal(s.update(hand(), 1).swipe, false);
});
