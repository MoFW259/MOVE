import * as THREE from 'three';
import { Grabber, type Grabbable } from '../../core/grab.ts';
import type { Experience } from '../../core/types.ts';
import meta from './meta.ts';

// A Calder-like hanging mobile in front of a gallery wall. Every wire arm hangs from a thread (pendulum swing + yaw/tilt
// springs); shapes hang from the arm ends. Pinching a shape pulls it along its taut thread and the pull drags every
// arm above it (swing, yaw, see-saw tilt); letting go leaves the whole tree swinging until it settles.
const Z0 = 3.5; // mobile plane; the wall is z = 0, far enough back that turning arms never cross it
const CEIL = 3.6; // root hook, above the top of the view
const HOOK_X = -0.4;
const VIEW = { halfW: 4.3, halfH: 2.9, y: 0.25 }; // area kept in view at Z0
const FOV = 40;
const G = 3.2; // softened gravity: slow, heavy swings
const LIFT = 0.12; // hovered shapes rise along their thread
const K_PULL = 24; // force per unit the hand pulls past the thread length
const F_MAX = 40;
const INERTIA = 0.85; // how much of a hook's motion a hanging body lags behind
const MAX_H = 0.92; // max horizontal swing (sin of the thread angle)
const KY = 0.6, KT = 6, KS = 0.8; // arm yaw, arm tilt, shape yaw stiffness
const MAX_HANDS = 8;

const RED = 0xc8322a, BLUE = 0x1f4aa0, YELLOW = 0xe9b81f, BLACK = 0x161616;

type Leaf = { shape: 'disc' | 'petal'; r: number; thread: number; color: number };
type Spec = { span: number; thread: number; yaw: number; ends: [Spec | Leaf, Spec | Leaf] };

const TREE: Spec = {
  span: 3.6, thread: 1.2, yaw: 0.1,
  ends: [
    { span: 1.7, thread: 0.7, yaw: -0.35, ends: [
      { shape: 'disc', r: 0.46, thread: 0.9, color: RED },
      { shape: 'petal', r: 0.3, thread: 1.5, color: YELLOW },
    ] },
    { span: 2.4, thread: 0.9, yaw: 0.3, ends: [
      { span: 1.4, thread: 1.0, yaw: -0.25, ends: [
        { shape: 'disc', r: 0.34, thread: 0.7, color: BLUE },
        { shape: 'disc', r: 0.2, thread: 1.4, color: BLACK },
      ] },
      { span: 1.3, thread: 1.5, yaw: 0.45, ends: [
        { shape: 'petal', r: 0.28, thread: 0.9, color: RED },
        { shape: 'disc', r: 0.24, thread: 1.6, color: YELLOW },
      ] },
    ] },
  ],
};

interface Arm {
  parent?: Arm;
  side: number;
  len: number; // thread length
  ends: THREE.Vector3[]; // local attach points
  mass: number; // whole subtree
  inertia: number;
  seed: number;
  hx: number; hz: number; vx: number; vz: number; // swing: horizontal part of the thread direction
  yaw: number; yawV: number; yaw0: number;
  tilt: number; tiltV: number;
  fx: number; fz: number; torque: number; tiltTorque: number; // accumulated hand pull this frame
  hook: THREE.Vector3; center: THREE.Vector3; quat: THREE.Quaternion; endW: THREE.Vector3[];
  wire: THREE.Mesh; thread: THREE.Mesh;
}

interface Piece extends Grabbable {
  object: THREE.Mesh;
  arm: Arm;
  side: number;
  r: number;
  len: number; // thread + radius: hook to center
  seed: number;
  hx: number; hz: number; vx: number; vz: number;
  yaw: number; yawV: number; yaw0: number;
  hover: number; // 0 idle … 1 held, eases
  prevA: THREE.Vector3;
  thread: THREE.Mesh;
  shadow: THREE.Mesh; // crisp planar shadow, fades in on hover
  mat: THREE.MeshStandardMaterial;
  shadowMat: THREE.MeshBasicMaterial;
}

const isLeaf = (s: Spec | Leaf): s is Leaf => 'shape' in s;
const massOf = (s: Spec | Leaf): number => (isLeaf(s) ? s.r * s.r * 8 : s.span * 0.15 + massOf(s.ends[0]) + massOf(s.ends[1]));

const outline = (kind: Leaf['shape'], r: number) => {
  const s = new THREE.Shape();
  if (kind === 'disc') s.absarc(0, 0, r, 0, Math.PI * 2, false);
  else {
    // Asymmetric petal, thread at the tip (0, r).
    s.moveTo(0, r);
    s.quadraticCurveTo(r * 1.15, r * 0.15, r * 0.1, -r);
    s.quadraticCurveTo(-r * 0.75, -r * 0.2, 0, r);
  }
  return s;
};

export default (): Experience => {
  let renderer!: THREE.WebGLRenderer;
  let prevShadow = { enabled: false, type: THREE.PCFShadowMap as THREE.ShadowMapType };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const drift = reduced ? 0.4 : 1;
  const damp = reduced ? 1.8 : 1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xefece4);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

  const wall = new THREE.Mesh(new THREE.PlaneGeometry(80, 50), new THREE.MeshStandardMaterial({ color: 0xefece4, roughness: 0.95 }));
  wall.receiveShadow = true;
  scene.add(wall);

  scene.add(new THREE.AmbientLight(0xfff8ee, 1.5));
  const light = new THREE.DirectionalLight(0xffffff, 2.1);
  light.position.set(-2.5, 3.5, 12);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.radius = 7;
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.02;
  Object.assign(light.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
  scene.add(light, light.target);

  // Planar projection onto the wall along the light: p - L * (p.z / L.z), lifted a hair off the wall.
  const L = new THREE.Vector3().subVectors(light.target.position, light.position).normalize();
  const project = new THREE.Matrix4().set(1, 0, -L.x / L.z, 0, 0, 1, -L.y / L.z, 0, 0, 0, 0, 0.004, 0, 0, 0, 1);

  const inkMat = new THREE.MeshStandardMaterial({ color: BLACK, roughness: 0.5 });
  const threadGeo = new THREE.CylinderGeometry(0.007, 0.007, 1, 5, 1, true);
  const arms: Arm[] = [];
  const pieces: Piece[] = [];

  const addThread = () => {
    const m = new THREE.Mesh(threadGeo, inkMat);
    m.castShadow = true;
    scene.add(m);
    return m;
  };

  let seed = 1;
  const build = (s: Spec, parent: Arm | undefined, side: number) => {
    const mL = massOf(s.ends[0]), mR = massOf(s.ends[1]);
    // Balance point: the thread sits where both sides' moments cancel.
    const xL = (-s.span * mR) / (mL + mR), xR = (s.span * mL) / (mL + mR);
    const xm = (xL + xR) / 2, hs = s.span / 2, bow = s.span * 0.05;
    const arch = (x: number) => bow * (1 - ((x - xm) / hs) ** 2) - bow * (1 - (xm / hs) ** 2); // 0 at the pivot
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const x = xL + ((xR - xL) * i) / 16;
      pts.push(new THREE.Vector3(x, arch(x), 0));
    }
    const wire = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.016, 6), inkMat);
    wire.castShadow = true;
    scene.add(wire);
    const mass = mL + mR + s.span * 0.15;
    const arm: Arm = {
      parent, side, len: s.thread, mass, inertia: mass * hs * hs * 0.5 + 0.2, seed: seed++ * 1.7,
      ends: [new THREE.Vector3(xL, arch(xL), 0), new THREE.Vector3(xR, arch(xR), 0)],
      hx: 0, hz: 0, vx: 0, vz: 0, yaw: s.yaw, yawV: 0, yaw0: s.yaw, tilt: 0, tiltV: 0,
      fx: 0, fz: 0, torque: 0, tiltTorque: 0,
      hook: new THREE.Vector3(), center: new THREE.Vector3(), quat: new THREE.Quaternion(), endW: [new THREE.Vector3(), new THREE.Vector3()],
      wire, thread: addThread(),
    };
    arms.push(arm); // parents before children: place() relies on it
    s.ends.forEach((e, i) => {
      if (!isLeaf(e)) return build(e, arm, i);
      const shape = outline(e.shape, e.r);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false, curveSegments: 32 });
      geo.translate(0, 0, -0.015);
      const mat = new THREE.MeshStandardMaterial({ color: e.color, emissive: e.color, emissiveIntensity: 0, roughness: 0.55 });
      const object = new THREE.Mesh(geo, mat);
      object.castShadow = true;
      const shadowMat = new THREE.MeshBasicMaterial({
        color: 0x2e2a25, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
      });
      const shadow = new THREE.Mesh(new THREE.ShapeGeometry(shape, 32), shadowMat);
      shadow.matrixAutoUpdate = false;
      scene.add(object, shadow);
      const yaw0 = (seed % 3) * 0.35 - 0.35;
      pieces.push({
        object, radius: Math.max(0.32, e.r * 1.25), arm, side: i, r: e.r, len: e.thread + e.r, seed: seed++ * 2.3,
        hx: 0, hz: 0, vx: 0, vz: 0, yaw: yaw0, yawV: 0, yaw0, hover: 0, prevA: new THREE.Vector3(),
        thread: addThread(), shadow, mat, shadowMat,
      });
    });
  };
  build(TREE, undefined, 0);

  const grabber = new Grabber(camera, pieces);

  // 3D pinch cursors: a ring that tightens as the fingers close, a dot that fills in, red over a shape.
  const ringGeo = new THREE.RingGeometry(0.1, 0.125, 40);
  const dotGeo = new THREE.CircleGeometry(0.04, 24);
  const cursorMat = new THREE.MeshBasicMaterial({ color: BLACK, transparent: true, opacity: 0.75, depthTest: false });
  const hotMat = new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0.95, depthTest: false });
  const cursors = Array.from({ length: MAX_HANDS }, () => {
    const ring = new THREE.Mesh(ringGeo, cursorMat);
    const dot = new THREE.Mesh(dotGeo, hotMat);
    ring.renderOrder = dot.renderOrder = 10;
    ring.visible = dot.visible = false;
    scene.add(ring, dot);
    return { ring, dot };
  });

  const UP = new THREE.Vector3(0, 1, 0);
  const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);
  const v = new THREE.Vector3(), w = new THREE.Vector3(), dir = new THREE.Vector3(), F = new THREE.Vector3(), top = new THREE.Vector3();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  let time = 0;

  const segment = (m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
    m.position.addVectors(a, b).multiplyScalar(0.5);
    v.subVectors(b, a);
    const l = v.length();
    m.quaternion.setFromUnitVectors(UP, v.divideScalar(l || 1));
    m.scale.set(1, l, 1);
  };

  const clampH = (o: { hx: number; hz: number }) => {
    const m = Math.hypot(o.hx, o.hz);
    if (m > MAX_H) { o.hx *= MAX_H / m; o.hz *= MAX_H / m; }
  };

  // Thread direction (pointing down the thread) from its horizontal part.
  const down = (out: THREE.Vector3, hx: number, hz: number) => out.set(hx, -Math.sqrt(Math.max(0, 1 - hx * hx - hz * hz)), hz);

  /** Forward kinematics, parents first. `inertia`: bodies lag behind their moving hook (that is what makes them swing). */
  const place = (inertia: boolean) => {
    for (const a of arms) {
      w.copy(a.hook);
      if (a.parent) a.hook.copy(a.parent.endW[a.side]);
      else a.hook.set(HOOK_X, CEIL, Z0);
      if (inertia) {
        a.hx -= ((a.hook.x - w.x) / a.len) * INERTIA;
        a.hz -= ((a.hook.z - w.z) / a.len) * INERTIA;
        clampH(a);
      }
      a.center.copy(a.hook).addScaledVector(down(dir, a.hx, a.hz), a.len);
      a.quat.setFromAxisAngle(UP, a.yaw).multiply(qa.setFromAxisAngle(Z, a.tilt));
      for (let i = 0; i < 2; i++) a.endW[i].copy(a.ends[i]).applyQuaternion(a.quat).add(a.center);
      a.wire.position.copy(a.center);
      a.wire.quaternion.copy(a.quat);
      segment(a.thread, a.hook, a.center);
    }
    for (const p of pieces) {
      const A = p.arm.endW[p.side];
      if (inertia && !grabber.isHeld(p)) {
        p.hx -= ((A.x - p.prevA.x) / p.len) * INERTIA;
        p.hz -= ((A.z - p.prevA.z) / p.len) * INERTIA;
        clampH(p);
      }
      p.prevA.copy(A);
      down(dir, p.hx, p.hz);
      const o = p.object;
      o.position.copy(A).addScaledVector(dir, p.len - LIFT * p.hover);
      // Shape's up axis points back up the thread, then it spins about it.
      o.quaternion.setFromUnitVectors(UP, w.copy(dir).negate()).multiply(qb.setFromAxisAngle(UP, p.yaw));
      const s = 1 + 0.08 * p.hover;
      o.scale.setScalar(s);
      segment(p.thread, A, top.copy(o.position).addScaledVector(w, p.r * s));
      o.updateMatrix();
      p.shadow.matrix.multiplyMatrices(project, o.matrix);
      p.shadowMat.opacity = 0.32 * p.hover;
      p.shadow.visible = p.hover > 0.01;
      p.mat.emissiveIntensity = 0.3 * p.hover;
    }
  };
  place(false);

  const step = (h: number) => {
    for (const a of arms) {
      const g = G / a.len, push = 1 / (a.mass * a.len);
      const breeze = 0.03 * drift * Math.sin(time * 0.5 + a.seed);
      a.vx += (-g * a.hx - 0.5 * damp * a.vx + a.fx * push + breeze) * h;
      a.vz += (-g * a.hz - 0.5 * damp * a.vz + a.fz * push + breeze * 0.6) * h;
      a.hx += a.vx * h;
      a.hz += a.vz * h;
      clampH(a);
      const target = a.yaw0 + drift * (0.18 * Math.sin(time * 0.11 + a.seed) + 0.08 * Math.sin(time * 0.23 + a.seed * 2));
      a.yawV += (-KY * (a.yaw - target) - 0.4 * damp * a.yawV + a.torque / a.inertia) * h;
      a.yaw += a.yawV * h;
      a.tiltV += (-KT * a.tilt - 1.5 * damp * a.tiltV + a.tiltTorque / a.inertia) * h;
      a.tilt = THREE.MathUtils.clamp(a.tilt + a.tiltV * h, -0.45, 0.45);
    }
    for (const p of pieces) {
      const held = grabber.isHeld(p);
      const target = held ? 0 : p.yaw0 + drift * 0.3 * Math.sin(time * 0.17 + p.seed); // held shapes turn to face you
      p.yawV += (-KS * (p.yaw - target) - 0.45 * damp * p.yawV) * h;
      p.yaw += p.yawV * h;
      if (held) continue;
      const g = G / p.len, breeze = 0.04 * drift * Math.sin(time * 0.6 + p.seed);
      p.vx += (-g * p.hx - 0.45 * damp * p.vx + breeze) * h;
      p.vz += (-g * p.hz - 0.45 * damp * p.vz + breeze * 0.5) * h;
      p.hx += p.vx * h;
      p.hz += p.vz * h;
      clampH(p);
    }
  };

  return {
    id: 'mobile',
    title: meta.title,
    hint: { text: '조각을 집어 당겼다 놓아 보세요', gesture: 'pinch' },
    needs: ['hands'],

    async init(ctx) {
      renderer = ctx.renderer;
      prevShadow = { enabled: renderer.shadowMap.enabled, type: renderer.shadowMap.type };
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
    },

    frame(input, dt) {
      time += dt;
      const hands = input.hands;
      grabber.update(hands, dt);

      for (const a of arms) a.fx = a.fz = a.torque = a.tiltTorque = 0;
      for (const p of pieces) {
        const held = grabber.isHeld(p);
        let target = held ? 1 : 0;
        if (!held) for (const hand of hands) if (grabber.hovered.get(hand.id) === p) target = Math.max(target, 0.35 + 0.65 * hand.pinchStrength);
        p.hover += (target - p.hover) * (1 - Math.exp(-12 * dt));
        if (!held) continue;

        // Held: keep the shape on its taut thread; pulling past the thread drags every arm above it.
        const A = p.arm.endW[p.side];
        const len = p.len - LIFT * p.hover;
        v.subVectors(p.object.position, A);
        const dist = v.length();
        if (dist < 1e-4) continue;
        v.divideScalar(dist);
        if (dist > len) {
          F.copy(v).multiplyScalar(Math.min(K_PULL * (dist - len), F_MAX));
          for (let a: Arm | undefined = p.arm; a; a = a.parent) {
            w.subVectors(A, a.center);
            a.fx += F.x;
            a.fz += F.z;
            a.torque += w.z * F.x - w.x * F.z;
            a.tiltTorque += w.dot(dir.copy(X).applyQuaternion(a.quat)) * F.y;
          }
        }
        const hx = p.hx, hz = p.hz;
        p.hx = v.x;
        p.hz = v.z;
        clampH(p);
        // Velocity from the motion while held, so a flick throws the shape on release.
        if (dt > 0) {
          p.vx += ((p.hx - hx) / dt - p.vx) * 0.3;
          p.vz += ((p.hz - hz) / dt - p.vz) * 0.3;
        }
      }

      const n = Math.max(1, Math.ceil(dt / 0.017));
      for (let i = 0; i < n; i++) step(dt / n);
      place(true);

      let c = 0;
      for (const hand of hands) {
        if (c >= MAX_HANDS) break;
        const { ring, dot } = cursors[c++];
        const p = grabber.points.get(hand.id);
        if (p) ring.position.copy(p);
        else {
          const ray = grabber.rayAt(hand.pinchPoint.x, hand.pinchPoint.y);
          ring.position.copy(ray.origin).addScaledVector(ray.direction, (Z0 - ray.origin.z) / ray.direction.z);
        }
        const held = grabber.held.has(hand.id), hot = held || grabber.hovered.has(hand.id);
        const s = hand.pinchStrength;
        ring.material = hot ? hotMat : cursorMat;
        ring.scale.setScalar(held ? 0.5 : 1.25 - 0.6 * s);
        dot.position.copy(ring.position);
        dot.scale.setScalar(held ? 1 : Math.max(0.001, s * 0.8));
        ring.visible = dot.visible = true;
      }
      for (; c < MAX_HANDS; c++) cursors[c].ring.visible = cursors[c].dot.visible = false;

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },

    resize(width, height) {
      camera.aspect = width / height;
      // Back the camera off until the whole mobile fits, portrait screens included.
      const half = Math.max(VIEW.halfH, VIEW.halfW / camera.aspect);
      camera.position.set(0, VIEW.y, Z0 + half / Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(); // the grabber casts rays before the first render
    },

    dispose() {
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      });
      cursorMat.dispose();
      hotMat.dispose();
      light.dispose();
      renderer.shadowMap.enabled = prevShadow.enabled;
      renderer.shadowMap.type = prevShadow.type;
    },
  };
};
