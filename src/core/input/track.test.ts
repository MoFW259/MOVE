import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchNearest } from './track.ts';

const p = (x: number, y: number) => ({ x, y });

test('keeps identities when hands swap detection order', () => {
  assert.deepEqual(matchNearest([p(0.2, 0.5), p(0.8, 0.5)], [p(0.79, 0.5), p(0.21, 0.5)], 0.2), [1, 0]);
});

test('closest pair wins; far or surplus points become new hands', () => {
  // Both new points are near prev 0; the closer one takes it, the other is new.
  assert.deepEqual(matchNearest([p(0.5, 0.5)], [p(0.6, 0.5), p(0.52, 0.5)], 0.2), [-1, 0]);
  assert.deepEqual(matchNearest([p(0.1, 0.1)], [p(0.9, 0.9)], 0.2), [-1]);
});
