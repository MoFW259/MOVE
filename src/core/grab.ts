import * as THREE from 'three';
import type { Hand } from './types.ts';

/** Something a hand can pick up. `object.position` is in world space (keep grabbables as direct scene children). */
export interface Grabbable {
  object: THREE.Object3D;
  /** Pick radius around `object.position`, world units. */
  radius: number;
  /** Set false to make it temporarily ungrabbable. */
  enabled?: boolean;
}

interface Hold {
  item: Grabbable;
  depth: number; // distance along the hand ray at grab time
  size0: number; // hand size at grab time (depth follows its ratio)
  offset: THREE.Vector3; // object position − grab point
  roll0: number;
  quat0: THREE.Quaternion;
  velocity: THREE.Vector3;
  reanchor: boolean; // set when the other hand of a two-hand grab lets go
}

interface Pair { a: string; b: string; dist0: number; angle0: number; scale0: THREE.Vector3; quat0: THREE.Quaternion }

const SMOOTH = 25; // 1/s, how tightly a held object follows the hand

const roll = (h: Hand) => (h.kind === 'tracked' ? Math.atan2(h.landmarks[9].y - h.landmarks[0].y, h.landmarks[9].x - h.landmarks[0].x) : 0);

/**
 * Pinch-to-grab for 3D scenes, shared so every piece feels the same:
 * - hover: the ray through `hand.pinchPoint` passes within `radius` of an item (nearest along the ray wins);
 * - pinch while hovering grabs; the item follows the hand, pulling the hand toward the camera brings it closer
 *   (depth scales with hand size), twisting the hand rolls it;
 * - a second hand pinching the same item scales and rotates it with the two hands' distance and angle;
 * - releasing reports the item's velocity so the piece can throw it.
 * Mouse/touch: press = grab, depth stays fixed, no roll.
 */
export class Grabber {
  /** Hand id → item under that hand (not held). */
  readonly hovered = new Map<string, Grabbable>();
  /** Hand id → held item. */
  readonly held = new Map<string, Grabbable>();
  /** Hand id → world point on its ray at the held/hovered item's depth (for drawing 3D cursors). */
  readonly points = new Map<string, THREE.Vector3>();
  onGrab?: (item: Grabbable, hand: Hand) => void;
  onRelease?: (item: Grabbable, velocity: THREE.Vector3) => void;

  private camera: THREE.Camera;
  private items: Grabbable[];
  private holds = new Map<string, Hold>();
  private pair?: Pair;
  private wasPinching = new Set<string>();
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private q = new THREE.Quaternion();

  /** `items` is read every frame, so the caller may push/splice it. */
  constructor(camera: THREE.Camera, items: Grabbable[]) {
    this.camera = camera;
    this.items = items;
  }

  isHeld(item: Grabbable): boolean {
    for (const h of this.held.values()) if (h === item) return true;
    return false;
  }

  isHovered(item: Grabbable): boolean {
    for (const h of this.hovered.values()) if (h === item) return true;
    return false;
  }

  update(hands: Hand[], dt: number): void {
    this.hovered.clear();
    const live = new Set<string>();
    for (const hand of hands) {
      live.add(hand.id);
      const ray = this.rayAt(hand.pinchPoint.x, hand.pinchPoint.y);
      const pinching = hand.gestures.pinch;
      const started = pinching && !this.wasPinching.has(hand.id);
      if (pinching) this.wasPinching.add(hand.id);
      else this.wasPinching.delete(hand.id);

      let hold = this.holds.get(hand.id);
      if (hold && !pinching) {
        this.release(hand.id);
        hold = undefined;
      }
      if (!hold) {
        const hit = this.pick(ray);
        if (!hit) {
          this.points.delete(hand.id);
          continue;
        }
        const p = this.pointOf(hand.id).copy(ray.origin).addScaledVector(ray.direction, hit.t);
        if (!started) {
          this.hovered.set(hand.id, hit.item);
          continue;
        }
        hold = {
          item: hit.item,
          depth: hit.t,
          size0: hand.size,
          offset: hit.item.object.position.clone().sub(p),
          roll0: roll(hand),
          quat0: hit.item.object.quaternion.clone(),
          velocity: new THREE.Vector3(),
          reanchor: false,
        };
        this.holds.set(hand.id, hold);
        this.held.set(hand.id, hit.item);
        this.onGrab?.(hit.item, hand);
        this.syncPair(hands);
      }
      this.follow(hand, hold, ray, dt);
    }
    for (const id of [...this.holds.keys()]) if (!live.has(id)) this.release(id);
    for (const id of [...this.wasPinching]) if (!live.has(id)) this.wasPinching.delete(id);
    for (const id of [...this.points.keys()]) if (!live.has(id)) this.points.delete(id);
    if (this.pair) this.followPair(hands, dt);
  }

  /** Ray through a normalized (0..1, top-left) screen point. The returned ray is reused; copy it to keep it. */
  rayAt(x: number, y: number): THREE.Ray {
    this.ndc.set(x * 2 - 1, 1 - y * 2);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.ray;
  }

  private pointOf(id: string): THREE.Vector3 {
    let p = this.points.get(id);
    if (!p) this.points.set(id, (p = new THREE.Vector3()));
    return p;
  }

  private pick(ray: THREE.Ray): { item: Grabbable; t: number } | undefined {
    let best: Grabbable | undefined, bestT = Infinity;
    for (const item of this.items) {
      if (item.enabled === false) continue;
      const pos = item.object.position;
      const t = this.tmp.copy(pos).sub(ray.origin).dot(ray.direction);
      if (t <= 0 || t >= bestT) continue;
      if (ray.distanceSqToPoint(pos) > item.radius * item.radius) continue;
      best = item;
      bestT = t;
    }
    return best && { item: best, t: bestT };
  }

  private follow(hand: Hand, hold: Hold, ray: THREE.Ray, dt: number): void {
    // Two-hand mode drives position/scale/rotation itself.
    if (this.pair && (this.pair.a === hand.id || this.pair.b === hand.id)) return;
    const obj = hold.item.object;
    if (hold.reanchor) {
      // Continue from the current pose instead of snapping back to this hand's original grab.
      hold.reanchor = false;
      hold.size0 = hand.size;
      hold.depth = this.tmp.copy(obj.position).sub(ray.origin).dot(ray.direction);
      hold.offset.copy(obj.position).sub(this.tmp.copy(ray.origin).addScaledVector(ray.direction, hold.depth));
      hold.roll0 = roll(hand);
      hold.quat0.copy(obj.quaternion);
    }
    const depth = hand.kind === 'tracked' && hold.size0 > 0 && hand.size > 0 ? hold.depth * (hold.size0 / hand.size) : hold.depth;
    const p = this.pointOf(hand.id).copy(ray.origin).addScaledVector(ray.direction, depth);
    this.moveTo(hold, this.tmp.copy(p).add(hold.offset), dt);
    if (hand.kind === 'tracked') {
      // Roll around the view axis by how much the hand has twisted since the grab.
      this.camera.getWorldDirection(this.axis).negate();
      this.q.setFromAxisAngle(this.axis, -(roll(hand) - hold.roll0));
      obj.quaternion.copy(this.q).multiply(hold.quat0);
    }
  }

  private moveTo(hold: Hold, target: THREE.Vector3, dt: number): void {
    const obj = hold.item.object;
    const prev = this.tmp2.copy(obj.position);
    obj.position.lerp(target, 1 - Math.exp(-SMOOTH * dt));
    if (dt > 0) hold.velocity.lerp(prev.subVectors(obj.position, prev).divideScalar(dt), 0.4);
  }

  private syncPair(hands: Hand[]): void {
    this.pair = undefined;
    const ids = [...this.holds.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const hi = this.holds.get(ids[i])!, hj = this.holds.get(ids[j])!;
        if (hi.item !== hj.item) continue;
        const a = hands.find((h) => h.id === ids[i]), b = hands.find((h) => h.id === ids[j]);
        if (!a || !b) continue;
        const dx = b.pinchPoint.x - a.pinchPoint.x, dy = b.pinchPoint.y - a.pinchPoint.y;
        const obj = hi.item.object;
        this.pair = { a: a.id, b: b.id, dist0: Math.hypot(dx, dy) || 1e-3, angle0: Math.atan2(dy, dx), scale0: obj.scale.clone(), quat0: obj.quaternion.clone() };
        return;
      }
    }
  }

  private followPair(hands: Hand[], dt: number): void {
    const pr = this.pair!;
    const a = hands.find((h) => h.id === pr.a), b = hands.find((h) => h.id === pr.b);
    const hold = this.holds.get(pr.a);
    if (!a || !b || !hold) return;
    const dx = b.pinchPoint.x - a.pinchPoint.x, dy = b.pinchPoint.y - a.pinchPoint.y;
    const obj = hold.item.object;
    obj.scale.copy(pr.scale0).multiplyScalar(THREE.MathUtils.clamp(Math.hypot(dx, dy) / pr.dist0, 0.25, 4));
    this.camera.getWorldDirection(this.axis).negate();
    this.q.setFromAxisAngle(this.axis, -(Math.atan2(dy, dx) - pr.angle0));
    obj.quaternion.copy(this.q).multiply(pr.quat0);
    // Position: the ray through the hands' midpoint, at the grab depth.
    const ray = this.rayAt((a.pinchPoint.x + b.pinchPoint.x) / 2, (a.pinchPoint.y + b.pinchPoint.y) / 2);
    this.moveTo(hold, this.tmp.copy(ray.origin).addScaledVector(ray.direction, hold.depth), dt);
  }

  private release(handId: string): void {
    const hold = this.holds.get(handId);
    if (!hold) return;
    this.holds.delete(handId);
    this.held.delete(handId);
    let stillHeld: Hold | undefined;
    for (const h of this.holds.values()) if (h.item === hold.item) stillHeld = h;
    if (this.pair && (this.pair.a === handId || this.pair.b === handId)) {
      this.pair = undefined;
      if (stillHeld) stillHeld.reanchor = true;
    }
    if (!stillHeld) this.onRelease?.(hold.item, hold.velocity);
  }
}
