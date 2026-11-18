import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Experience, Hand } from '../../core/types.ts';
import meta from './meta.ts';

// A clay lump on a turntable. Pinch near the surface grabs that spot and pulls/pushes it with a soft falloff
// (hand size drives depth), open palm relaxes the surface, fist held resets, swipe or pinch-drag in the air spins the stand.
// Mouse: press on clay = grab, press-drag on empty space = spin, press and hold still on empty space = reset.
const DETAIL = 50; // ~26k vertices after welding
const TOP = -0.86; // turntable surface in clay space
const R_GRAB = 0.5; // soft-selection radius
const R_SMOOTH = 0.55;
const MAX_R = 2.4, MIN_R = 0.25;
const FRONT_TOL2 = 0.1 * 0.1; // ray→vertex distance² that counts as "on the ray"
const MISS2 = 0.3 * 0.3; // forgiving pick just outside the silhouette
const RESET_HOLD = 1.5;
const RESET_S = 0.9;
const NORMAL_DT = 1 / 30;
const MAX_GRIPS = 4;
const MAX_SPOTS = 8;
const MAX_CURSORS = 6;
const PULSES = 4;
const PULSE_S = 0.45;
const BASE_DIST = 6.2;
const CAM_DIR = new THREE.Vector3(0, 0.22, 1).normalize();
const LOOK = new THREE.Vector3(0, -0.15, 0);

interface Grip {
  busy: boolean;
  idx: Uint32Array;
  w: Float32Array;
  n: number;
  anchor: THREE.Vector3; // grabbed vertex, clay space, at grab time
  prev: THREE.Vector3; // displacement already applied, clay space
  point: THREE.Vector3; // smoothed hand point, world
  offset: THREE.Vector3; // anchor − ray point at grab (near-miss grabs don't snap)
  depth: number;
  size0: number;
}

interface HandState {
  grip: Grip | null;
  pinch: boolean;
  air: boolean; // pinched on empty space: dragging spins the turntable
  airX: number;
  airX0: number;
  airY0: number;
  airVel: number;
  moved: boolean;
  hold: number; // pointer: seconds held still on empty space
  fist: number;
  fistDone: boolean;
  seen: number;
}

const clayVertex = /* glsl */ `
varying vec3 vLocal;
`;
const clayFragment = /* glsl */ `
uniform vec4 spotA[${MAX_SPOTS}]; // clay-space centre, radius (0 = off)
uniform vec4 spotB[${MAX_SPOTS}]; // colour × intensity, disc fill
uniform vec3 rimColor;
varying vec3 vLocal;
`;
const clayEmissive = /* glsl */ `
#include <emissivemap_fragment>
// Warm rim: light scattering through the clay's edge.
float fres = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
totalEmissiveRadiance += rimColor * (fres * fres * fres);
for (int i = 0; i < ${MAX_SPOTS}; i++) {
  vec4 a = spotA[i];
  if (a.w <= 0.0) continue;
  float d = distance(vLocal, a.xyz);
  float disc = 1.0 - smoothstep(0.0, a.w, d);
  float ring = 1.0 - smoothstep(0.0, 0.015 + a.w * 0.05, abs(d - a.w));
  totalEmissiveRadiance += spotB[i].rgb * (disc * disc * spotB[i].w + ring);
}
`;

export default (): Experience => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const IDLE_SPIN = reduced ? 0.1 : 0.28;

  let renderer: THREE.WebGLRenderer;
  let time = 0;
  let frameNo = 0;
  let camDist = BASE_DIST;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);

  // Background: warm studio gradient with a soft vignette.
  const bgMat = new THREE.ShaderMaterial({
    uniforms: { top: { value: new THREE.Color('#f4ead9') }, bottom: { value: new THREE.Color('#d9c2a0') } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform vec3 top, bottom;
      varying vec2 vUv;
      void main() {
        vec3 c = mix(bottom, top, smoothstep(0.0, 1.0, vUv.y));
        c *= 1.0 - 0.22 * smoothstep(0.35, 0.95, length(vUv - vec2(0.5, 0.55)));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
  bg.frustumCulled = false;
  bg.renderOrder = -1;
  scene.add(bg);

  scene.add(new THREE.HemisphereLight('#fff3e2', '#6e4a38', 1.4));
  const key = new THREE.DirectionalLight('#fff1dc', 2.4);
  key.position.set(3, 4, 5);
  const fill = new THREE.DirectionalLight('#ffd6bd', 0.6);
  fill.position.set(-4, 1, 2);
  const back = new THREE.DirectionalLight('#ffe2c8', 1.6);
  back.position.set(-1, 3, -5);
  scene.add(key, fill, back);

  // Turntable group: clay, plate and contact shadow spin together.
  const spin = new THREE.Group();
  scene.add(spin);
  const plate = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.48, 0.16, 96),
    new THREE.MeshStandardMaterial({ color: '#5b3b29', roughness: 0.55 }),
  );
  plate.position.y = TOP - 0.08;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.5, 1.6, 48), new THREE.MeshStandardMaterial({ color: '#2e201a', roughness: 0.7 }));
  stem.position.y = TOP - 0.16 - 0.8;
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.3, 64),
    new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          gl_FragColor = vec4(0.12, 0.06, 0.03, (1.0 - smoothstep(0.25, 1.0, r)) * 0.5);
        }`,
      transparent: true,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = TOP + 0.002;
  spin.add(plate, stem, shadow);

  // Clay: welded icosphere (no seams to tear), slightly lumpy, flattened where it sits.
  const ico = new THREE.IcosahedronGeometry(1, DETAIL);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico, 1e-4);
  ico.dispose();
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const pos = posAttr.array as Float32Array;
  const nv = posAttr.count;
  for (let i = 0; i < nv; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const r = 1 + 0.025 * Math.sin(3.1 * x + 1.3) * Math.sin(2.7 * y + 0.4) * Math.sin(3.3 * z + 2.1) + 0.01 * Math.sin(7 * x + 5 * z + 2 * y);
    pos[i * 3] = x * r;
    pos[i * 3 + 1] = Math.max(TOP, y * r * 0.94);
    pos[i * 3 + 2] = z * r;
  }
  const base = pos.slice();
  const snap = new Float32Array(pos.length);
  geo.computeVertexNormals();
  (geo.getAttribute('normal') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);

  // Vertex adjacency (CSR) for smoothing; every edge appears in two triangles, so duplicates don't bias the average.
  const index = geo.index!.array;
  const off = new Uint32Array(nv + 1);
  for (let t = 0; t < index.length; t++) off[index[t] + 1] += 2;
  for (let i = 0; i < nv; i++) off[i + 1] += off[i];
  const adj = new Uint32Array(off[nv]);
  const fillAt = off.slice(0, nv);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    adj[fillAt[a]++] = b;
    adj[fillAt[a]++] = c;
    adj[fillAt[b]++] = a;
    adj[fillAt[b]++] = c;
    adj[fillAt[c]++] = a;
    adj[fillAt[c]++] = b;
  }

  const spotA = Array.from({ length: MAX_SPOTS }, () => new THREE.Vector4());
  const spotB = Array.from({ length: MAX_SPOTS }, () => new THREE.Vector4());
  const clayUniforms = { spotA: { value: spotA }, spotB: { value: spotB }, rimColor: { value: new THREE.Color('#ff9a6a').multiplyScalar(0.4) } };
  const clayMat = new THREE.MeshStandardMaterial({ color: '#c0613b', roughness: 0.86, metalness: 0 });
  clayMat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, clayUniforms);
    s.vertexShader = clayVertex + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = transformed;');
    s.fragmentShader = clayFragment + s.fragmentShader.replace('#include <emissivemap_fragment>', clayEmissive);
  };
  const clay = new THREE.Mesh(geo, clayMat);
  clay.frustumCulled = false; // bounds go stale while sculpting
  spin.add(clay);

  // Reset progress ring around the plate (does not spin).
  const ringU = { progress: { value: 0 }, alpha: { value: 0 }, color: { value: new THREE.Color('#6e2a12') } };
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.56, 1.64, 128, 1),
    new THREE.ShaderMaterial({
      uniforms: ringU,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform float progress, alpha;
        uniform vec3 color;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float f = fract(atan(p.x, -p.y) / 6.2831853); // 0 at the front, clockwise from above
          float on = 1.0 - smoothstep(progress - 0.004, progress, f);
          gl_FragColor = vec4(color, alpha * mix(0.18, 0.9, on));
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = TOP;
  scene.add(ring);

  // 3D pinch cursors: billboard rings that tighten with pinchStrength.
  const cursorGeo = new THREE.RingGeometry(0.75, 1, 40);
  const cursors: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  for (let i = 0; i < MAX_CURSORS; i++) {
    const m = new THREE.Mesh(cursorGeo, new THREE.MeshBasicMaterial({ color: '#3a1a0c', transparent: true, depthTest: false, depthWrite: false }));
    m.renderOrder = 10;
    m.visible = false;
    cursors.push(m);
    scene.add(m);
  }

  const grips: Grip[] = Array.from({ length: MAX_GRIPS }, () => ({
    busy: false,
    idx: new Uint32Array(nv),
    w: new Float32Array(nv),
    n: 0,
    anchor: new THREE.Vector3(),
    prev: new THREE.Vector3(),
    point: new THREE.Vector3(),
    offset: new THREE.Vector3(),
    depth: 0,
    size0: 0,
  }));
  const pulses = Array.from({ length: PULSES }, () => ({ pos: new THREE.Vector3(), age: Infinity }));
  const states = new Map<string, HandState>();

  const C_HOVER = new THREE.Color('#ffe2bd');
  const C_HELD = new THREE.Color('#fff0d8');
  const C_SMOOTH = new THREE.Color('#b9d6ff');

  let angle = 0;
  let spinVel = IDLE_SPIN;
  let gripCount = 0;
  let airCount = 0;
  let resetK = -1; // -1 = idle, else 0..1 animation progress
  let dirty = false;
  let lastNormals = 0;
  let bounce = 0, bounceV = 0;
  let nSpots = 0;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const inv = new THREE.Matrix4();
  const wRay = new THREE.Ray();
  const lRay = new THREE.Ray();
  const tmp = new THREE.Vector3();

  function rayAt(x: number, y: number) {
    ndc.set(x * 2 - 1, 1 - y * 2);
    raycaster.setFromCamera(ndc, camera);
    wRay.copy(raycaster.ray);
    lRay.copy(wRay).applyMatrix4(inv);
  }

  /** Front-most vertex near the local ray (or the nearest one for a near miss), −1 if none. */
  function pick(): number {
    const o = lRay.origin, d = lRay.direction;
    let best = -1, bestT = Infinity, near = -1, nearD = MISS2;
    for (let i = 0, j = 0; i < nv; i++, j += 3) {
      const vx = pos[j] - o.x, vy = pos[j + 1] - o.y, vz = pos[j + 2] - o.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t <= 0) continue;
      const d2 = vx * vx + vy * vy + vz * vz - t * t;
      if (d2 < FRONT_TOL2 && t < bestT) {
        bestT = t;
        best = i;
      }
      if (d2 < nearD) {
        nearD = d2;
        near = i;
      }
    }
    return best >= 0 ? best : near;
  }

  function addSpot(x: number, y: number, z: number, r: number, c: THREE.Color, intensity: number, fill: number) {
    if (nSpots >= MAX_SPOTS) return;
    spotA[nSpots].set(x, y, z, r);
    spotB[nSpots].set(c.r * intensity, c.g * intensity, c.b * intensity, fill);
    nSpots++;
  }

  function grab(st: HandState, v: number, h: Hand) {
    const g = grips.find((x) => !x.busy);
    if (!g) return;
    g.busy = true;
    gripCount++;
    const ax = pos[v * 3], ay = pos[v * 3 + 1], az = pos[v * 3 + 2];
    g.anchor.set(ax, ay, az);
    g.prev.set(0, 0, 0);
    g.n = 0;
    const r2 = R_GRAB * R_GRAB;
    for (let i = 0, j = 0; i < nv; i++, j += 3) {
      const dx = pos[j] - ax, dy = pos[j + 1] - ay, dz = pos[j + 2] - az;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const k = 1 - d2 / r2;
      g.idx[g.n] = i;
      g.w[g.n++] = k * k;
    }
    g.point.copy(g.anchor).applyMatrix4(clay.matrixWorld);
    g.depth = tmp.copy(g.point).sub(wRay.origin).dot(wRay.direction);
    g.offset.copy(g.point).sub(wRay.at(g.depth, tmp));
    g.size0 = h.size;
    st.grip = g;
  }

  function release(st: HandState) {
    const g = st.grip!;
    g.busy = false;
    st.grip = null;
    gripCount--;
    let p = pulses[0];
    for (const q of pulses) if (q.age > p.age) p = q;
    p.pos.copy(g.anchor).add(g.prev);
    p.age = 0;
    if (!reduced) bounceV += 0.25;
  }

  function dragGrip(g: Grip, h: Hand, dt: number) {
    // Hand nearer the camera (bigger) pulls the spot toward the viewer; softened exponent tames size jitter.
    const ratio = h.kind === 'tracked' && g.size0 > 0 && h.size > 0 ? THREE.MathUtils.clamp(Math.pow(g.size0 / h.size, 0.8), 0.6, 1.6) : 1;
    wRay.at(g.depth * ratio, tmp).add(g.offset);
    g.point.lerp(tmp, 1 - Math.exp(-18 * dt));
    tmp.copy(g.point).applyMatrix4(inv).sub(g.anchor);
    const dx = tmp.x - g.prev.x, dy = tmp.y - g.prev.y, dz = tmp.z - g.prev.z;
    g.prev.copy(tmp);
    if (dx * dx + dy * dy + dz * dz < 1e-12) return;
    const max2 = MAX_R * MAX_R, min2 = MIN_R * MIN_R;
    for (let k = 0; k < g.n; k++) {
      const j = g.idx[k] * 3, w = g.w[k];
      let x = pos[j] + dx * w, y = Math.max(TOP, pos[j + 1] + dy * w), z = pos[j + 2] + dz * w;
      const r2 = x * x + y * y + z * z;
      if (r2 > max2 || (r2 < min2 && r2 > 1e-8)) {
        const s = (r2 > max2 ? MAX_R : MIN_R) / Math.sqrt(r2);
        x *= s;
        y *= s;
        z *= s;
      }
      pos[j] = x;
      pos[j + 1] = y;
      pos[j + 2] = z;
    }
    posAttr.needsUpdate = true;
    dirty = true;
  }

  /** Laplacian relax around vertex c, weighted by the same soft falloff. */
  function relax(c: number, rate: number) {
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    const r2 = R_SMOOTH * R_SMOOTH;
    for (let i = 0, j = 0; i < nv; i++, j += 3) {
      const dx = pos[j] - cx, dy = pos[j + 1] - cy, dz = pos[j + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const k = 1 - d2 / r2;
      const w = k * k * rate;
      let ax = 0, ay = 0, az = 0;
      const a = off[i], b = off[i + 1];
      for (let e = a; e < b; e++) {
        const n = adj[e] * 3;
        ax += pos[n];
        ay += pos[n + 1];
        az += pos[n + 2];
      }
      const m = 1 / (b - a);
      pos[j] += (ax * m - pos[j]) * w;
      pos[j + 1] = Math.max(TOP, pos[j + 1] + (ay * m - pos[j + 1]) * w);
      pos[j + 2] += (az * m - pos[j + 2]) * w;
    }
    posAttr.needsUpdate = true;
    dirty = true;
  }

  function startReset() {
    if (resetK >= 0) return;
    states.forEach((st) => {
      if (st.grip) release(st);
    });
    snap.set(pos);
    resetK = 0;
    spinVel += reduced ? 0.4 : 2.5;
  }

  const prune = (st: HandState, id: string) => {
    if (st.seen === frameNo) return;
    if (st.grip) release(st);
    if (st.air) airCount--;
    states.delete(id);
  };

  return {
    id: 'clay',
    title: meta.title,
    hint: { text: '점토를 집어서 당기고 눌러 빚어 보세요', gesture: 'pinch' },
    needs: ['hands'],
    async init(ctx) {
      renderer = ctx.renderer;
    },
    frame(input, dt) {
      time += dt;
      frameNo++;

      // Turntable: stops dead while the clay is held, otherwise eases back to the idle spin.
      if (gripCount > 0) spinVel = 0;
      else if (airCount === 0) {
        spinVel += (IDLE_SPIN - spinVel) * (1 - Math.exp(-0.7 * dt));
        angle += spinVel * dt;
      }
      bounceV += (-80 * bounce - 9 * bounceV) * dt;
      bounce += bounceV * dt;
      spin.rotation.y = angle;
      clay.scale.set(1 + bounce * 0.5, 1 - bounce, 1 + bounce * 0.5);
      spin.updateMatrixWorld(true);
      inv.copy(clay.matrixWorld).invert();

      nSpots = 0;
      let progress = 0;
      let c = 0;
      for (const h of input.hands) {
        let st = states.get(h.id);
        if (!st) {
          st = { grip: null, pinch: false, air: false, airX: 0, airX0: 0, airY0: 0, airVel: 0, moved: false, hold: 0, fist: 0, fistDone: false, seen: 0 };
          states.set(h.id, st);
        }
        st.seen = frameNo;
        const tracked = h.kind === 'tracked';
        const pp = h.pinchPoint;
        // A closed fist can read as a pinch too; it means "reset", never "grab".
        const pinch = h.gestures.pinch && !(tracked && h.gestures.fist && !st.grip);
        const started = pinch && !st.pinch;
        st.pinch = pinch;
        rayAt(pp.x, pp.y);

        if (st.grip && !pinch) release(st);
        if (st.air && !pinch) {
          st.air = false;
          airCount--;
          if (gripCount === 0) spinVel = THREE.MathUtils.clamp(st.airVel, -6, 6);
        }

        let v = -1;
        if (st.grip) dragGrip(st.grip, h, dt);
        else if (!st.air) {
          v = resetK >= 0 ? -1 : pick();
          if (started && v >= 0) grab(st, v, h);
          else if (started) {
            st.air = true;
            airCount++;
            st.airX = st.airX0 = pp.x;
            st.airY0 = pp.y;
            st.airVel = 0;
            st.moved = false;
            st.hold = 0;
          }
        }

        const smoothing = tracked && h.gestures.open && !pinch && !st.grip;
        if (st.grip) {
          const g = st.grip;
          addSpot(g.anchor.x + g.prev.x, g.anchor.y + g.prev.y, g.anchor.z + g.prev.z, R_GRAB, C_HELD, 0.5, 0.75);
        } else if (v >= 0 && !st.air && !smoothing) {
          // Anticipation: the spot brightens and tightens to the real grab radius as the fingers close.
          const s = h.pinchStrength;
          addSpot(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], R_GRAB * (1.7 - 0.7 * s), C_HOVER, 0.12 + 0.38 * s, 0.35 + 0.4 * s);
        }

        if (st.air) {
          const dx = pp.x - st.airX;
          st.airX = pp.x;
          if (gripCount === 0) {
            angle += dx * 6;
            if (dt > 0) st.airVel += ((dx * 6) / dt - st.airVel) * 0.3;
          }
          if (Math.hypot(pp.x - st.airX0, pp.y - st.airY0) > 0.02) st.moved = true;
          // Mouse has no fist: press and hold still on empty space resets.
          if (!tracked && !st.moved) {
            st.hold += dt;
            progress = Math.max(progress, st.hold / RESET_HOLD);
            if (st.hold >= RESET_HOLD) {
              startReset();
              st.moved = true;
            }
          }
        }

        // 3D cursor.
        if (c < MAX_CURSORS) {
          const m = cursors[c++];
          if (st.grip) m.position.copy(st.grip.point);
          else if (v >= 0) m.position.set(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]).applyMatrix4(clay.matrixWorld);
          else wRay.at(camDist, m.position);
          const s = st.grip ? 0.45 : 1.2 - 0.6 * h.pinchStrength;
          m.scale.setScalar(m.position.distanceTo(camera.position) * 0.014 * s);
          m.quaternion.copy(camera.quaternion);
          m.material.opacity = st.grip ? 0.95 : 0.3 + 0.6 * h.pinchStrength;
          m.visible = true;
        }

        if (smoothing && resetK < 0) {
          const palm = h.landmarks[9];
          rayAt(palm.x, palm.y);
          const sv = pick();
          if (sv >= 0) {
            relax(sv, 1 - Math.exp(-2.5 * dt));
            addSpot(pos[sv * 3], pos[sv * 3 + 1], pos[sv * 3 + 2], R_SMOOTH, C_SMOOTH, 0.3, 0.6);
          }
        }

        if (tracked && h.gestures.fist && !st.grip) {
          if (!st.fistDone) st.fist += dt;
        } else {
          st.fist = 0;
          st.fistDone = false;
        }
        progress = Math.max(progress, st.fist / RESET_HOLD);
        if (st.fist >= RESET_HOLD) {
          startReset();
          st.fist = 0;
          st.fistDone = true;
        }

        if (tracked && h.gestures.swipe && !pinch && gripCount === 0) spinVel = THREE.MathUtils.clamp(spinVel + h.velocity.x * 8 * dt, -6, 6);
      }
      states.forEach(prune);
      for (; c < MAX_CURSORS; c++) cursors[c].visible = false;

      for (const p of pulses) {
        if (p.age >= PULSE_S) continue;
        p.age += dt;
        const k = Math.min(1, p.age / PULSE_S);
        addSpot(p.pos.x, p.pos.y, p.pos.z, R_GRAB * (1 + 0.8 * k), C_HELD, 0.6 * (1 - k) * (1 - k), 0);
      }
      for (let i = nSpots; i < MAX_SPOTS; i++) spotA[i].w = 0;

      if (resetK >= 0) {
        resetK = Math.min(1, resetK + dt / RESET_S);
        const e = resetK < 0.5 ? 2 * resetK * resetK : 1 - 2 * (1 - resetK) * (1 - resetK); // ease in-out
        for (let i = 0; i < pos.length; i++) pos[i] = snap[i] + (base[i] - snap[i]) * e;
        posAttr.needsUpdate = true;
        dirty = true;
        progress = 1;
        if (resetK >= 1) resetK = -1;
      }
      ringU.progress.value = Math.min(1, progress);
      ringU.alpha.value += ((progress > 0 ? 1 : 0) - ringU.alpha.value) * (1 - Math.exp(-8 * dt));

      if (dirty && time - lastNormals >= NORMAL_DT) {
        geo.computeVertexNormals();
        lastNormals = time;
        dirty = false;
      }

      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(width, height) {
      const aspect = width / height;
      camera.aspect = aspect;
      // Portrait screens: back off so the plate still fits horizontally.
      camDist = BASE_DIST * Math.min(2.2, Math.max(1, 1.15 / aspect));
      camera.position.copy(CAM_DIR).multiplyScalar(camDist).add(LOOK);
      camera.lookAt(LOOK);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
    },
    dispose() {
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    },
  };
};
