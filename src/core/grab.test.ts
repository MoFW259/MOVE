import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { Grabber, type Grabbable } from './grab.ts';
import type { Hand } from './types.ts';

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(0, 0, 5);
camera.updateMatrixWorld();

function pointer(id: string, x: number, y: number, down: boolean): Hand {
  const p = { x, y, z: 0 };
  return {
    id, kind: 'pointer', cursor: p, pinchPoint: p, pinchStrength: down ? 1 : 0, size: 0, landmarks: [],
    velocity: { x: 0, y: 0 }, gestures: { open: !down, fist: down, pinch: down, point: !down, swipe: false },
  };
}

function setup() {
  const item: Grabbable = { object: new THREE.Object3D(), radius: 0.5 };
  const g = new Grabber(camera, [item]);
  return { item, g };
}

test('hover, grab, drag and release with velocity', () => {
  const { item, g } = setup();
  g.update([pointer('m', 0.5, 0.5, false)], 1 / 60);
  assert.ok(g.isHovered(item));
  let released: THREE.Vector3 | undefined;
  g.onRelease = (_, v) => (released = v.clone());
  g.update([pointer('m', 0.5, 0.5, true)], 1 / 60);
  assert.ok(g.isHeld(item));
  for (let i = 0; i < 60; i++) g.update([pointer('m', 0.5 + i * 0.004, 0.5, true)], 1 / 60);
  assert.ok(item.object.position.x > 0.5, `moved right: ${item.object.position.x}`);
  g.update([pointer('m', 0.74, 0.5, false)], 1 / 60);
  assert.ok(!g.isHeld(item));
  assert.ok(released && released.x > 0, 'throw velocity points along the drag');
});

test('pressing before reaching an item does not grab it on hover', () => {
  const { item, g } = setup();
  g.update([pointer('m', 0.05, 0.05, true)], 1 / 60); // pressed in empty space
  g.update([pointer('m', 0.5, 0.5, true)], 1 / 60); // dragged onto the item while pressed
  assert.ok(!g.isHeld(item));
});

test('two hands scale the held item', () => {
  const { item, g } = setup();
  g.update([pointer('a', 0.48, 0.5, true)], 1 / 60);
  g.update([pointer('a', 0.48, 0.5, true), pointer('b', 0.52, 0.5, true)], 1 / 60);
  for (let i = 0; i < 30; i++) g.update([pointer('a', 0.46, 0.5, true), pointer('b', 0.54, 0.5, true)], 1 / 60);
  assert.ok(Math.abs(item.object.scale.x - 2) < 1e-6, `scale doubled: ${item.object.scale.x}`);
});
